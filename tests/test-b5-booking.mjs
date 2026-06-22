// Week-2 / B5 — Patient Appointment Booking Tests
//
// Covers the 4 new patient-facing endpoints on /api/patient/appointments + /api/patient/appointment-slots:
//   GET  /api/patient/appointment-slots                 (requirePatientAuth)
//   POST /api/patient/appointments                       (requirePatientAuthCsrf)
//   GET  /api/patient/appointments                       (requirePatientAuth)
//   POST /api/patient/appointments/:id/cancel            (requirePatientAuthCsrf)
//
// Flow tested (each step also asserts the right HTTP status + error code):
//   1. Patient login → pid cookie + csrf_token cookie + body csrfToken
//   2. GET slots (date range + doctor filter)         → 200, count >= 1
//   3. POST book a slot                               → 201, returns appointment_id
//   4. GET my appointments                             → 200, new row visible, status=booked
//   5. POST book same slot again                       → 409 SLOT_TAKEN (atomicity)
//   6. POST cancel the appointment                     → 200, status=cancelled, cancelled_at set
//   7. GET slots again                                 → slot status back to 'open'
//   8. POST book a non-existent slot                   → 404 NOT_FOUND
//   9. POST cancel an already-cancelled appointment   → 409 ALREADY_CANCELLED
//  10. POST book with pid but no csrf                  → 403 csrf_invalid
//  11. GET slots with no pid cookie                    → 401
//  12. POST book with no pid cookie                    → 401
//  13. POST cancel a slot_id that doesn't belong to me → 401 (cross-patient isolation)
//
// Auth model under test (same as B2 refill — Week-1 PR CSRF in effect):
//   - No pid cookie                     → 401
//   - pid cookie + POST, no csrf        → 403 (csrf_invalid)
//   - pid cookie + POST + valid csrf    → 200/201
//
// Seed assumptions (db/migrations/009):
//   - Patient p-001 (Rakesh Kumar) has phone '+919812345670', password 'patient123'
//     (Vedadb has no encode() builtin → all 5 patients end up with the same hash).
//   - Doctor d-001 (Dr. Priya Sharma) — 7 open slots seeded in 009 for 2026-06-23..2026-06-29.
//   - Migration 010 added clinic_id column to appointments.
//
// Run: `node tests/test-b5-booking.mjs` from repo root.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SERVER_ENTRY = join(REPO_ROOT, 'backend', 'server.mjs');
// Distinct port from test-b2-refill (3091) so they don't collide.
const TEST_PORT = parseInt(process.env.TEST_PORT || '3095', 10);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const DEMO_PATIENT_P001 = {
  phone: '+919812345670', password: 'patient123', patient_id: 'p-001', name: 'Rakesh Kumar',
};
const DEMO_PATIENT_P002 = {
  phone: '+919812345672', password: 'patient123', patient_id: 'p-002', name: 'Meera Patel',
};
const DEMO_DOCTOR = { doctor_id: 'd-001', name: 'Dr. Priya Sharma' };

// ============ HTTP test client ============
async function req(port, { method = 'GET', path = '/', headers = {}, body = null, cookies = null } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookies) init.headers['cookie'] = cookies;
  if (body != null && typeof body === 'object' && !(body instanceof Buffer)) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = init.headers['content-type'] || 'application/json';
  } else if (body != null) { init.body = body; }
  const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  const setCookies = typeof r.headers.getSetCookie === 'function'
    ? r.headers.getSetCookie()
    : (r.headers.get('set-cookie') || '').split(/, (?=[A-Za-z0-9_]+=)/);
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()), setCookies, body: text, json };
}

function parseCookies(setCookieList) {
  if (!setCookieList) return {};
  const list = Array.isArray(setCookieList) ? setCookieList : [setCookieList];
  const out = {};
  for (const sc of list) {
    if (!sc) continue;
    const first = sc.split(';')[0];
    const eq = first.indexOf('=');
    if (eq < 0) continue;
    out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return out;
}
function cookieHeader(map) { return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; '); }

// ============ Spawn the TatvaCare backend on TEST_PORT ============
console.log(`[b5-booking] booting server.mjs on :${TEST_PORT} …`);
const child = spawn(process.execPath, [SERVER_ENTRY], {
  env: { ...process.env, PORT: String(TEST_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: REPO_ROOT,
});

let serverLog = '';
child.stdout.on('data', (b) => { serverLog += b.toString(); process.stdout.write(`  [srv] ${b}`); });
child.stderr.on('data', (b) => { serverLog += b.toString(); process.stderr.write(`  [srv!] ${b}`); });
child.on('exit', (code) => { console.log(`[b5-booking] server exited code=${code}`); });

async function waitForReady(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req(port, { path: '/api/health' });
      if (r.status === 200 && r.json && r.json.status === 'ok') return true;
    } catch { /* not up yet */ }
    await delay(150);
  }
  return false;
}

let exitCode = 0;
function fail(msg) { console.error(`FAIL — ${msg}`); exitCode = 1; }
function ok(msg)   { console.log(`OK   — ${msg}`); }

// Reset booking state (slots → open, drop prior apt-% rows) so the test is
// reproducible. Done via direct VBP since there's no admin endpoint for it.
// Also resets p-002's password to a known sha256('patient123') hash — the
// 006 seed attempted encode(sha256(right(phone,6))::bytea) which Vedadb
// doesn't support, so p-002..p-005 ended up with an unguessable hash. The
// cross-patient test (step 13) needs p-002 to log in, so we patch the hash
// here.
async function resetBookingState() {
  const crypto = await import('node:crypto');
  const patient123Hash = crypto.createHash('sha256').update('patient123').digest('hex');
  const vbp = await import(join(REPO_ROOT, 'backend', 'lib', 'vbp.mjs'));
  const db = new vbp.VBP('127.0.0.1', 6381);
  await db.connect();
  try {
    await db.query("UPDATE appointment_slots SET status='open', appointment_id=NULL");
    await db.query("DELETE FROM appointments WHERE appointment_id LIKE 'apt-%'");
    await db.query(`UPDATE patient_credentials SET password_hash = '${patient123Hash}' WHERE patient_id = 'p-002'`);
  } finally { await db.close(); }
}

try {
  // Reset state BEFORE spawning — the spawn log otherwise fills with state noise.
  await resetBookingState();
  ok('reset booking state (slots=open, prior apt-% rows deleted)');

  const up = await waitForReady(TEST_PORT);
  assert.equal(up, true, 'server did not become ready within 15s — check Vedadb at :6381');

  // ============ STEP 1: Patient p-001 login ============
  console.log('\n[b5-booking] === step 1: patient p-001 login ===');
  const pLogin = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/auth/login',
    body: { phoneOrEmail: DEMO_PATIENT_P001.phone, password: DEMO_PATIENT_P001.password },
  });
  assert.equal(pLogin.status, 200, `patient login should be 200, got ${pLogin.status} body=${pLogin.body}`);
  assert.ok(pLogin.json && pLogin.json.patient, 'patient login response missing patient');
  assert.equal(pLogin.json.patient.patient_id, DEMO_PATIENT_P001.patient_id);
  const pCookies = parseCookies(pLogin.setCookies);
  assert.ok(pCookies.pid, 'patient login sets pid cookie');
  assert.ok(pCookies.csrf_token, 'patient login sets csrf_token cookie');
  assert.ok(pLogin.json.csrfToken, 'patient login returns csrfToken in body');
  // CSRF double-submit: cookie value MUST match body value.
  assert.equal(pCookies.csrf_token, pLogin.json.csrfToken,
    `csrf cookie/header MUST match (cookie=${pCookies.csrf_token?.slice(0,8)}… body=${pLogin.json.csrfToken?.slice(0,8)}…)`);
  const patientCookie = cookieHeader({ pid: pCookies.pid, csrf_token: pCookies.csrf_token });
  const patientCsrf = pLogin.json.csrfToken;
  ok(`patient login OK — patient_id=${pLogin.json.patient.patient_id}, csrf cookie/header match`);

  // ============ STEP 2: GET /api/patient/appointment-slots ============
  console.log('\n[b5-booking] === step 2: GET /api/patient/appointment-slots ===');
  const slotsR = await req(TEST_PORT, {
    path: '/api/patient/appointment-slots?from=2026-06-23&to=2026-06-29&doctor_id=d-001',
    cookies: patientCookie,
  });
  assert.equal(slotsR.status, 200, `GET slots should be 200, got ${slotsR.status} body=${slotsR.body}`);
  assert.ok(Array.isArray(slotsR.json.slots), 'response slots should be array');
  assert.ok(slotsR.json.slots.length >= 1, `expected at least 1 open slot, got ${slotsR.json.slots.length}`);
  const firstSlot = slotsR.json.slots[0];
  assert.equal(firstSlot.status, 'open', `expected first slot to be 'open', got '${firstSlot.status}'`);
  assert.equal(firstSlot.doctor_id, DEMO_DOCTOR.doctor_id, 'slot doctor_id matches filter');
  assert.ok(firstSlot.slot_date && firstSlot.slot_time, 'slot has date + time');
  ok(`GET slots OK — ${slotsR.json.slots.length} open slots for d-001 between 2026-06-23..2026-06-29`);

  // ============ STEP 3: POST /api/patient/appointments — book a slot ============
  console.log('\n[b5-booking] === step 3: POST /api/patient/appointments ===');
  const slotToBook = firstSlot.slot_id;
  const bookR = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/appointments',
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: { slot_id: slotToBook, kind: 'in_person', reason: 'Routine cardiac checkup' },
  });
  assert.equal(bookR.status, 201, `POST book should be 201, got ${bookR.status} body=${bookR.body}`);
  assert.ok(bookR.json && bookR.json.appointment_id, 'book response missing appointment_id');
  assert.equal(bookR.json.slot_id, slotToBook, 'book response echoes slot_id');
  assert.equal(bookR.json.status, 'booked', `expected status='booked', got '${bookR.json.status}'`);
  assert.equal(bookR.json.kind, 'in_person', `expected kind='in_person', got '${bookR.json.kind}'`);
  assert.equal(bookR.json.patient_id, DEMO_PATIENT_P001.patient_id, 'book response patient_id matches session');
  assert.equal(bookR.json.doctor_id, DEMO_DOCTOR.doctor_id, 'book response doctor_id matches slot');
  assert.equal(bookR.json.clinic_id, 'cl-001', `expected clinic_id='cl-001', got '${bookR.json.clinic_id}'`);
  assert.ok(bookR.json.scheduled_at, 'book response has scheduled_at');
  const appointmentId = bookR.json.appointment_id;
  ok(`POST book OK — appointment_id=${appointmentId}, status=booked, kind=in_person, clinic=${bookR.json.clinic_id}`);

  // ============ STEP 4: GET /api/patient/appointments — see the new row ============
  console.log('\n[b5-booking] === step 4: GET /api/patient/appointments ===');
  const myR = await req(TEST_PORT, { path: '/api/patient/appointments', cookies: patientCookie });
  assert.equal(myR.status, 200, `GET my appointments should be 200, got ${myR.status}`);
  assert.ok(Array.isArray(myR.json.appointments), 'response appointments should be array');
  const found = myR.json.appointments.find(a => a.appointment_id === appointmentId);
  assert.ok(found, `my appointments should include ${appointmentId}`);
  assert.equal(found.status, 'booked', `new row status should be 'booked', got '${found.status}'`);
  assert.equal(found.kind, 'in_person', 'new row kind preserved');
  assert.equal(found.slot_id, slotToBook, 'new row slot_id preserved');
  assert.equal(found.reason, 'Routine cardiac checkup', 'new row reason preserved');
  assert.ok(found.cancelled_at === null || found.cancelled_at === 'NULL',
    `new row cancelled_at should be null/'NULL', got ${JSON.stringify(found.cancelled_at)}`);
  ok(`GET my appointments OK — ${myR.json.appointments.length} row(s), found booking with status=booked`);

  // ============ STEP 5: POST same slot again — 409 SLOT_TAKEN ============
  console.log('\n[b5-booking] === step 5: POST duplicate book → 409 SLOT_TAKEN ===');
  const dupR = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/appointments',
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: { slot_id: slotToBook },
  });
  assert.equal(dupR.status, 409, `duplicate book should be 409, got ${dupR.status} body=${dupR.body}`);
  assert.equal(dupR.json.error.code, 'SLOT_TAKEN', `expected error.code='SLOT_TAKEN', got '${dupR.json.error?.code}'`);
  ok(`duplicate book → 409 SLOT_TAKEN (atomic UPDATE guard works)`);

  // ============ STEP 6: POST /api/patient/appointments/:id/cancel ============
  console.log('\n[b5-booking] === step 6: POST cancel ===');
  const cancelR = await req(TEST_PORT, {
    method: 'POST', path: `/api/patient/appointments/${appointmentId}/cancel`,
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: { cancel_reason: 'Rescheduling — feeling better' },
  });
  assert.equal(cancelR.status, 200, `cancel should be 200, got ${cancelR.status} body=${cancelR.body}`);
  assert.equal(cancelR.json.status, 'cancelled', `expected status='cancelled', got '${cancelR.json.status}'`);
  assert.ok(cancelR.json.cancelled_at, 'cancelled_at should be set after cancel');
  assert.equal(cancelR.json.cancel_reason, 'Rescheduling — feeling better', 'cancel_reason preserved');
  ok(`POST cancel OK — status=cancelled, cancelled_at=${cancelR.json.cancelled_at}, reason preserved`);

  // ============ STEP 7: GET slots — slot back to 'open' ============
  console.log('\n[b5-booking] === step 7: GET slots — verify slot reopened ===');
  const slotsAfter = await req(TEST_PORT, {
    path: '/api/patient/appointment-slots?from=2026-06-23&to=2026-06-23&doctor_id=d-001',
    cookies: patientCookie,
  });
  assert.equal(slotsAfter.status, 200);
  const reopened = slotsAfter.json.slots.find(s => s.slot_id === slotToBook);
  assert.ok(reopened, 'cancelled slot should reappear in open list');
  assert.equal(reopened.status, 'open', `cancelled slot should be 'open' again, got '${reopened.status}'`);
  ok(`slot ${slotToBook} reopened after cancel — status=open`);

  // ============ STEP 8: POST book non-existent slot → 404 NOT_FOUND ============
  console.log('\n[b5-booking] === step 8: POST book non-existent slot → 404 ===');
  const nfR = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/appointments',
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: { slot_id: 'nonexistent-slot-id' },
  });
  assert.equal(nfR.status, 404, `non-existent slot should be 404, got ${nfR.status}`);
  assert.equal(nfR.json.error.code, 'NOT_FOUND', `expected error.code='NOT_FOUND', got '${nfR.json.error?.code}'`);
  ok(`non-existent slot → 404 NOT_FOUND`);

  // ============ STEP 9: Cancel already-cancelled → 409 ALREADY_CANCELLED ============
  console.log('\n[b5-booking] === step 9: POST cancel on already-cancelled → 409 ===');
  const c2R = await req(TEST_PORT, {
    method: 'POST', path: `/api/patient/appointments/${appointmentId}/cancel`,
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: {},
  });
  assert.equal(c2R.status, 409, `cancel-already-cancelled should be 409, got ${c2R.status}`);
  assert.equal(c2R.json.error.code, 'ALREADY_CANCELLED',
    `expected error.code='ALREADY_CANCELLED', got '${c2R.json.error?.code}'`);
  ok(`cancel-twice → 409 ALREADY_CANCELLED`);

  // ============ STEP 10: POST with pid cookie but NO csrf → 403 csrf_invalid ============
  console.log('\n[b5-booking] === step 10: POST book with pid but no csrf → 403 ===');
  // Need a fresh open slot for this — reuse slotToBook (reopened in step 7).
  const noCsrfR = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/appointments',
    cookies: patientCookie,
    // intentionally omit x-csrf-token header
    body: { slot_id: slotToBook },
  });
  assert.equal(noCsrfR.status, 403, `POST without csrf should be 403, got ${noCsrfR.status}`);
  assert.equal(noCsrfR.json.error, 'csrf_invalid', `expected error='csrf_invalid', got '${noCsrfR.json.error}'`);
  ok(`POST without csrf → 403 csrf_invalid`);

  // ============ STEP 11: GET slots with NO pid cookie → 401 ============
  console.log('\n[b5-booking] === step 11: GET slots with no auth → 401 ===');
  const noAuthR = await req(TEST_PORT, { path: '/api/patient/appointment-slots' });
  assert.equal(noAuthR.status, 401, `GET without pid should be 401, got ${noAuthR.status}`);
  ok(`GET without pid → 401`);

  // ============ STEP 12: POST book with NO pid cookie → 401 ============
  console.log('\n[b5-booking] === step 12: POST book with no auth → 401 ===');
  const noAuthPostR = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/appointments',
    headers: { 'x-csrf-token': 'fake-token' },
    body: { slot_id: slotToBook },
  });
  assert.equal(noAuthPostR.status, 401, `POST without pid should be 401, got ${noAuthPostR.status}`);
  ok(`POST without pid → 401`);

  // ============ STEP 13: Cross-patient isolation — p-002 cannot cancel p-001's booking ============
  console.log('\n[b5-booking] === step 13: cross-patient cancel → 401 (isolation) ===');
  // First: book a fresh slot as p-001.
  const freshSlot = slotsR.json.slots.find(s => s.slot_id !== slotToBook && s.status === 'open').slot_id;
  const bR = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/appointments',
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: { slot_id: freshSlot },
  });
  assert.equal(bR.status, 201, `p-001 book should be 201, got ${bR.status} body=${bR.body}`);
  const crossApptId = bR.json.appointment_id;

  // Now: login as p-002.
  const p2Login = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/auth/login',
    body: { phoneOrEmail: DEMO_PATIENT_P002.phone, password: DEMO_PATIENT_P002.password },
  });
  assert.equal(p2Login.status, 200, `p-002 login should be 200, got ${p2Login.status}`);
  assert.equal(p2Login.json.patient.patient_id, DEMO_PATIENT_P002.patient_id);
  const p2Cookies = parseCookies(p2Login.setCookies);
  assert.equal(p2Cookies.csrf_token, p2Login.json.csrfToken, 'p-002 csrf cookie/header MUST match too');
  const p2Cookie = cookieHeader({ pid: p2Cookies.pid, csrf_token: p2Cookies.csrf_token });
  const p2Csrf = p2Login.json.csrfToken;

  // p-002 attempts to cancel p-001's appointment — must be rejected (NOT 200).
  const crossR = await req(TEST_PORT, {
    method: 'POST', path: `/api/patient/appointments/${crossApptId}/cancel`,
    cookies: p2Cookie,
    headers: { 'x-csrf-token': p2Csrf },
    body: { cancel_reason: 'Should not work' },
  });
  assert.notEqual(crossR.status, 200, `cross-patient cancel must NOT be 200, got ${crossR.status}`);
  assert.ok(crossR.status === 404 || crossR.status === 401 || crossR.status === 403,
    `cross-patient cancel should be 4xx, got ${crossR.status} body=${crossR.body}`);
  ok(`cross-patient cancel → ${crossR.status} (NOT 200 — isolation enforced)`);

  // Cleanup — p-001 cancels the booking we just made (so the slot is free for re-runs).
  await req(TEST_PORT, {
    method: 'POST', path: `/api/patient/appointments/${crossApptId}/cancel`,
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: { cancel_reason: 'test cleanup' },
  });

  console.log('\nAll Week-2 / B5 patient appointment booking tests passed.');
} catch (e) {
  console.error('\nTEST ERROR:', e.stack || e.message);
  exitCode = 1;
} finally {
  try { child.kill('SIGINT'); } catch {}
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
  process.exit(exitCode);
}
