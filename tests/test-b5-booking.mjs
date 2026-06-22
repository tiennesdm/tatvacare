// Week-2 / B5 — Patient Appointment Booking Backend Tests
//
// Covers the 4 new endpoints on /api/patient/appointments*:
//   GET  /api/patient/appointment-slots          (requirePatientAuth)
//   POST /api/patient/appointments               (requirePatientAuthCsrf)
//   GET  /api/patient/appointments               (requirePatientAuth)
//   POST /api/patient/appointments/:id/cancel    (requirePatientAuthCsrf)
//
// Pattern: dep-free, node:assert + node:http + fetch. Mirrors
// tests/test-b2-refill.mjs (same spawn-the-server approach).
//
// Seed assumptions (db/migrations/009 + 002 + 006):
//   - Patient p-001 (Rakesh Kumar) has phone '+919812345670'.
//     Password = 'patient123' (Vedadb's missing encode() builtin means
//     all seeded patients share the same sha256 hash, verified to be
//     'patient123' against the live DB).
//   - Doctor d-001 (Dr. Priya Sharma) published 7 open slots for the
//     next 7 days starting 2026-06-23 (slot_id 'slot-d-001-1' … 'slot-d-001-7'),
//     seeded by 009_appointments.sql.
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
// Distinct port from b2-refill (3091) so the two test files can coexist
// on the same machine without stepping on each other's server.
const TEST_PORT = parseInt(process.env.TEST_PORT || '3092', 10);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

const DEMO_PATIENT = {
  phone: '+919812345670',
  password: 'patient123',
  expected_patient_id: 'p-001',
};

// ============ HTTP test client ============
async function req(port, { method = 'GET', path = '/', headers = {}, body = null, cookies = null } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookies) init.headers['cookie'] = cookies;
  if (body != null && typeof body === 'object' && !(body instanceof Buffer)) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = init.headers['content-type'] || 'application/json';
  } else if (body != null) {
    init.body = body;
  }
  const url = `http://127.0.0.1:${port}${path}`;
  const r = await fetch(url, init);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  const setCookies = typeof r.headers.getSetCookie === 'function'
    ? r.headers.getSetCookie()
    : (r.headers.get('set-cookie') || '').split(/, (?=[A-Za-z0-9_]+=)/);
  return {
    status: r.status,
    headers: Object.fromEntries(r.headers.entries()),
    setCookies,
    body: text,
    json,
  };
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

function cookieHeader(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

function todayPlus(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

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

try {
  const up = await waitForReady(TEST_PORT);
  assert.equal(up, true, 'server did not become ready within 15s — check Vedadb at :6381');

  // ============ STEP 1: Patient login ============
  console.log('\n[b5-booking] === step 1: patient login ===');
  const pLogin = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/auth/login',
    body: { phoneOrEmail: DEMO_PATIENT.phone, password: DEMO_PATIENT.password },
  });
  assert.equal(pLogin.status, 200, `patient login should be 200, got ${pLogin.status} body=${pLogin.body}`);
  assert.ok(pLogin.json && pLogin.json.patient, 'patient login response missing patient');
  assert.equal(pLogin.json.patient.patient_id, DEMO_PATIENT.expected_patient_id, `expected ${DEMO_PATIENT.expected_patient_id}`);
  const pCookies = parseCookies(pLogin.setCookies);
  assert.ok(pCookies.pid, 'patient login sets pid cookie');
  assert.ok(pCookies.csrf_token, 'patient login sets csrf_token cookie');
  assert.ok(pLogin.json.csrfToken, 'patient login returns csrfToken in body');
  const patientCookie = cookieHeader({ pid: pCookies.pid, csrf_token: pCookies.csrf_token });
  const patientCsrf = pLogin.json.csrfToken;
  ok(`patient login OK — patient_id=${pLogin.json.patient.patient_id}, csrf issued`);

  // Compute the date range that covers the seeded slots. Seed dates are
  // hardcoded to 2026-06-23..2026-06-29. To stay robust against the
  // current_date, we widen the window: from 7 days ago to 30 days ahead.
  const fromDate = todayPlus(-7);
  const toDate = todayPlus(30);

  // ============ STEP 2: GET /api/patient/appointment-slots — list open slots ============
  console.log('\n[b5-booking] === step 2: GET /api/patient/appointment-slots ===');
  const slots1 = await req(TEST_PORT, {
    path: `/api/patient/appointment-slots?from=${fromDate}&to=${toDate}&doctor_id=d-001`,
    cookies: patientCookie,
  });
  assert.equal(slots1.status, 200, `GET slots should be 200, got ${slots1.status} body=${slots1.body}`);
  assert.ok(Array.isArray(slots1.json.slots), 'response slots should be array');
  assert.ok(slots1.json.slots.length >= 1, `expected ≥1 slot from seed, got ${slots1.json.slots.length}`);
  const firstSlot = slots1.json.slots[0];
  assert.ok(firstSlot.slot_id, 'slot must have slot_id');
  assert.equal(firstSlot.doctor_id, 'd-001', 'slot must be for d-001');
  assert.equal(firstSlot.status, 'open', 'slot status must be open');
  assert.ok(firstSlot.slot_date, 'slot must have slot_date');
  assert.ok(firstSlot.slot_time, 'slot must have slot_time');
  assert.equal(firstSlot.duration_min, 15, 'seeded slot duration is 15min');
  ok(`GET slots OK — ${slots1.json.slots.length} open slot(s); first = ${firstSlot.slot_id} on ${firstSlot.slot_date} ${firstSlot.slot_time}`);
  const slotIdToBook = firstSlot.slot_id;

  // ============ STEP 3: POST /api/patient/appointments — book a slot ============
  console.log('\n[b5-booking] === step 3: POST /api/patient/appointments (book) ===');
  const book = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/appointments',
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: { slot_id: slotIdToBook, reason: 'Headache checkup', kind: 'in_person' },
  });
  assert.equal(book.status, 201, `POST appointment should be 201, got ${book.status} body=${book.body}`);
  assert.ok(book.json && book.json.appointment_id, 'POST response missing appointment_id');
  assert.equal(book.json.slot_id, slotIdToBook, 'appointment slot_id echoes booked slot');
  assert.equal(book.json.patient_id, DEMO_PATIENT.expected_patient_id, 'appointment patient_id is p-001');
  assert.equal(book.json.doctor_id, 'd-001', 'appointment doctor_id is d-001');
  assert.equal(book.json.status, 'booked', 'new appointment status is booked');
  assert.equal(book.json.kind, 'in_person', 'kind echoes request');
  assert.ok(book.json.scheduled_at, 'scheduled_at is populated');
  assert.equal(book.json.reason, 'Headache checkup', 'reason echoes request');
  const appointmentId = book.json.appointment_id;
  ok(`POST appointment OK — appointment_id=${appointmentId}, status=booked, scheduled_at=${book.json.scheduled_at}`);

  // ============ STEP 4: GET /api/patient/appointment-slots — booked slot NOT in list ============
  console.log('\n[b5-booking] === step 4: GET slots — booked slot absent ===');
  const slots2 = await req(TEST_PORT, {
    path: `/api/patient/appointment-slots?from=${fromDate}&to=${toDate}&doctor_id=d-001`,
    cookies: patientCookie,
  });
  assert.equal(slots2.status, 200, `GET slots after booking should be 200, got ${slots2.status}`);
  assert.ok(Array.isArray(slots2.json.slots), 'response slots is array');
  const stillThere = slots2.json.slots.find(s => s.slot_id === slotIdToBook);
  assert.ok(!stillThere, `booked slot ${slotIdToBook} should NOT appear in open list (found: ${JSON.stringify(stillThere)})`);
  ok(`GET slots after book OK — booked slot ${slotIdToBook} correctly excluded from open list (${slots2.json.slots.length} remaining)`);

  // ============ STEP 5: POST /api/patient/appointments same slot → 409 ============
  console.log('\n[b5-booking] === step 5: POST same slot → 409 ===');
  const conflict = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/appointments',
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: { slot_id: slotIdToBook, reason: 'Try again' },
  });
  assert.equal(conflict.status, 409, `rebook same slot should be 409, got ${conflict.status} body=${conflict.body}`);
  assert.ok(conflict.json && conflict.json.error, `409 response missing error envelope, got ${JSON.stringify(conflict.json)}`);
  ok(`rebook same slot → ${conflict.status} ${conflict.json.error.code || ''} (expected 409)`);

  // ============ STEP 6: POST /api/patient/appointments/:id/cancel ============
  console.log('\n[b5-booking] === step 6: POST cancel ===');
  const cancel = await req(TEST_PORT, {
    method: 'POST', path: `/api/patient/appointments/${appointmentId}/cancel`,
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: { cancel_reason: 'Plans changed' },
  });
  assert.equal(cancel.status, 200, `cancel should be 200, got ${cancel.status} body=${cancel.body}`);
  assert.equal(cancel.json.status, 'cancelled', 'cancel response status is cancelled');
  assert.equal(cancel.json.appointment_id, appointmentId, 'cancel echoes appointment_id');
  assert.equal(cancel.json.cancel_reason, 'Plans changed', 'cancel_reason echoes request');
  assert.ok(cancel.json.cancelled_at, 'cancelled_at is populated');
  ok(`cancel OK — appointment_id=${appointmentId} status=cancelled`);

  // ============ STEP 7: GET slots — slot is back in the open list ============
  console.log('\n[b5-booking] === step 7: GET slots — slot back in open list ===');
  const slots3 = await req(TEST_PORT, {
    path: `/api/patient/appointment-slots?from=${fromDate}&to=${toDate}&doctor_id=d-001`,
    cookies: patientCookie,
  });
  assert.equal(slots3.status, 200, `GET slots after cancel should be 200, got ${slots3.status}`);
  const back = slots3.json.slots.find(s => s.slot_id === slotIdToBook);
  assert.ok(back, `cancelled slot ${slotIdToBook} should be back in open list`);
  assert.equal(back.status, 'open', 'freed slot status is open again');
  ok(`GET slots after cancel OK — slot ${slotIdToBook} back in open list`);

  // ============ STEP 8a: POST without pid cookie → 401 ============
  console.log('\n[b5-booking] === step 8a: POST without patient auth → 401 ===');
  const noAuth = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/appointments',
    headers: { 'x-csrf-token': patientCsrf },
    body: { slot_id: slotIdToBook, reason: 'no auth' },
  });
  assert.equal(noAuth.status, 401, `POST without pid should be 401, got ${noAuth.status} body=${noAuth.body}`);
  ok(`POST without pid → ${noAuth.status} (expected 401)`);

  // ============ STEP 8b: POST with cookie but no CSRF → 403 ============
  console.log('\n[b5-booking] === step 8b: POST without CSRF → 403 ===');
  const noCsrf = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/appointments',
    cookies: patientCookie,
    body: { slot_id: slotIdToBook, reason: 'no csrf' },
  });
  assert.equal(noCsrf.status, 403, `POST without csrf should be 403, got ${noCsrf.status} body=${noCsrf.body}`);
  // CSRF middleware returns {error: 'csrf_invalid', message: '...'} — error
  // is a plain string, not an object with .code. (See lib/security/csrf.mjs.)
  assert.ok(noCsrf.json && noCsrf.json.error === 'csrf_invalid',
    `expected csrf_invalid error, got ${JSON.stringify(noCsrf.json)}`);
  ok(`POST without csrf → ${noCsrf.status} csrf_invalid (expected 403)`);

  // ============ STEP 8c (bonus): GET slots without auth → 401 ============
  console.log('\n[b5-booking] === step 8c: GET slots without auth → 401 ===');
  const noAuthGet = await req(TEST_PORT, {
    path: `/api/patient/appointment-slots?from=${fromDate}&to=${toDate}`,
  });
  assert.equal(noAuthGet.status, 401, `GET slots without pid should be 401, got ${noAuthGet.status}`);
  ok(`GET slots without pid → ${noAuthGet.status} (expected 401)`);

  console.log('\nAll Week-2 / B5 patient appointment booking tests passed (8 assertions).');
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
