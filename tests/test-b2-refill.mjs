// Week-2 / B2 — Medication Refill Request Backend Tests
//
// Covers the 4 new endpoints on /api/patient/refill + /api/refill/*:
//   POST /api/patient/refill         (requirePatientAuthCsrf)
//   GET  /api/patient/refill         (requirePatientAuth)
//   GET  /api/refill/pending         (requireAuth — DOCTOR)
//   POST /api/refill/:id/decision    (requireAuthCsrf — DOCTOR)
//
// Pattern: dep-free, node:assert + node:http + fetch. Mirrors
// tests/test-b1-adherence.mjs (same spawn-the-server approach).
//
// Auth model under test:
//   - No pid cookie + POST          → 401
//   - pid cookie + POST, no csrf    → 403 (Week-1 PR CSRF in effect)
//   - sid cookie (doctor) + GET     → 200
//   - sid cookie (doctor) + POST + valid csrf → 200
//
// Seed assumptions (db/migrations/002 + 006):
//   - Patient p-001 (Rakesh Kumar) has phone '+919812345670'.
//     Password = last 6 digits of phone = '345670' (per migration 006).
//   - Doctor d-001 (Dr. Priya Sharma) has phone '+919876500001'.
//     Password = 'tatva123' (set by migrate.mjs seed-patch step).
//
// Run: `node tests/test-b2-refill.mjs` from repo root.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SERVER_ENTRY = join(REPO_ROOT, 'backend', 'server.mjs');
// Use a distinct port from b1-adherence (3090) so the two test files can
// coexist on the same machine without stepping on each other's server.
const TEST_PORT = parseInt(process.env.TEST_PORT || '3091', 10);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Patient p-001 — seed migration 006 tried `encode(sha256(right(phone,6))::bytea)`
// but Vedadb has no `encode()` builtin (verified), so all 5 seeded patients
// ended up with the same hash (sha256('patient123')). This is the value we
// expect from the live DB; it does NOT match the documented 'last 6 digits of
// phone' — that's a Vedadb-engine limitation, not a script bug.
const DEMO_PATIENT = {
  phone: '+919812345670',
  password: 'patient123',
  expected_patient_id: 'p-001',
};
// Doctor d-001 — seeded password = 'tatva123'
const DEMO_DOCTOR = {
  phone: '+919876500001',
  password: 'tatva123',
  expected_doctor_id: 'd-001',
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

// ============ Spawn the TatvaCare backend on TEST_PORT ============
console.log(`[b2-refill] booting server.mjs on :${TEST_PORT} …`);
const child = spawn(process.execPath, [SERVER_ENTRY], {
  env: { ...process.env, PORT: String(TEST_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: REPO_ROOT,
});

let serverLog = '';
child.stdout.on('data', (b) => { serverLog += b.toString(); process.stdout.write(`  [srv] ${b}`); });
child.stderr.on('data', (b) => { serverLog += b.toString(); process.stderr.write(`  [srv!] ${b}`); });
child.on('exit', (code) => { console.log(`[b2-refill] server exited code=${code}`); });

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
  console.log('\n[b2-refill] === step 1: patient login ===');
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

  // ============ STEP 2: POST /api/patient/refill — create request ============
  console.log('\n[b2-refill] === step 2: POST /api/patient/refill ===');
  const post = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/refill',
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: {
      drug_name: 'Metformin',
      current_stock: 5,
      requested_qty: 2,
      urgency: 'normal',
      pharmacy: 'Apollo Pharmacy',
      patient_notes: 'Need before next week',
    },
  });
  assert.equal(post.status, 201, `POST /api/patient/refill should be 201, got ${post.status} body=${post.body}`);
  assert.ok(post.json && post.json.request_id, 'POST response missing request_id');
  assert.equal(post.json.drug_name, 'Metformin', 'drug_name echoed back');
  assert.equal(post.json.status, 'pending', 'initial status should be pending');
  assert.equal(post.json.urgency, 'normal', 'urgency echoed back');
  assert.equal(post.json.requested_qty, 2, 'requested_qty echoed back');
  const requestId = post.json.request_id;
  ok(`POST refill OK — request_id=${requestId}`);

  // ============ STEP 3: GET /api/patient/refill — own list ============
  console.log('\n[b2-refill] === step 3: GET /api/patient/refill (patient) ===');
  const pList = await req(TEST_PORT, {
    path: '/api/patient/refill',
    cookies: patientCookie,
  });
  assert.equal(pList.status, 200, `GET /api/patient/refill should be 200, got ${pList.status}`);
  assert.ok(Array.isArray(pList.json.requests), 'response requests should be array');
  const found = pList.json.requests.find(r => r.request_id === requestId);
  assert.ok(found, 'patient list should contain the just-created request');
  assert.equal(found.status, 'pending', 'new row status should be pending');
  assert.equal(found.drug_name, 'Metformin', 'drug_name preserved');
  assert.equal(found.urgency, 'normal', 'urgency preserved');
  assert.equal(found.requested_qty, 2, 'requested_qty preserved');
  assert.equal(found.decided_at, null, 'new row decided_at should be null');
  assert.equal(found.decided_by, null, 'new row decided_by should be null');
  ok(`GET /api/patient/refill OK — found request_id=${requestId} status=pending`);

  // ============ STEP 4: Doctor login (separate cookie) ============
  console.log('\n[b2-refill] === step 4: doctor login ===');
  const dLogin = await req(TEST_PORT, {
    method: 'POST', path: '/api/auth/login',
    body: { phoneOrEmail: DEMO_DOCTOR.phone, password: DEMO_DOCTOR.password },
  });
  assert.equal(dLogin.status, 200, `doctor login should be 200, got ${dLogin.status} body=${dLogin.body}`);
  assert.ok(dLogin.json && dLogin.json.doctor, 'doctor login response missing doctor');
  assert.equal(dLogin.json.doctor.doctor_id, DEMO_DOCTOR.expected_doctor_id, `expected ${DEMO_DOCTOR.expected_doctor_id}`);
  const dCookies = parseCookies(dLogin.setCookies);
  assert.ok(dCookies.sid, 'doctor login sets sid cookie');
  const doctorCookie = cookieHeader({ sid: dCookies.sid, csrf_token: dCookies.csrf_token });
  const doctorCsrf = dLogin.json.csrfToken;
  ok(`doctor login OK — doctor_id=${dLogin.json.doctor.doctor_id}`);

  // ============ STEP 5: GET /api/refill/pending — doctor's inbox ============
  console.log('\n[b2-refill] === step 5: GET /api/refill/pending (doctor) ===');
  const pending = await req(TEST_PORT, {
    path: '/api/refill/pending',
    cookies: doctorCookie,
  });
  assert.equal(pending.status, 200, `GET /api/refill/pending should be 200, got ${pending.status} body=${pending.body}`);
  assert.ok(Array.isArray(pending.json.requests), 'pending requests should be array');
  const pendingFound = pending.json.requests.find(r => r.request_id === requestId);
  assert.ok(pendingFound, `doctor's pending inbox should contain request_id=${requestId}`);
  assert.equal(pendingFound.status, 'pending', 'inbox row status should be pending');
  assert.equal(pendingFound.drug_name, 'Metformin', 'inbox drug_name preserved');
  assert.equal(pendingFound.patient_id, DEMO_PATIENT.expected_patient_id, 'inbox row patient_id is p-001');
  assert.equal(pendingFound.patient_name, 'Rakesh Kumar', 'inbox row joins patient name');
  ok(`GET /api/refill/pending OK — ${pending.json.requests.length} pending request(s), includes ours`);

  // ============ STEP 6: POST /api/refill/:id/decision — approve ============
  console.log('\n[b2-refill] === step 6: POST /api/refill/:id/decision (approved) ===');
  const decide = await req(TEST_PORT, {
    method: 'POST', path: `/api/refill/${requestId}/decision`,
    cookies: doctorCookie,
    headers: { 'x-csrf-token': doctorCsrf },
    body: { decision: 'approved', doctor_notes: 'OK to refill' },
  });
  assert.equal(decide.status, 200, `POST decision should be 200, got ${decide.status} body=${decide.body}`);
  assert.equal(decide.json.status, 'approved', 'response status should be approved');
  assert.equal(decide.json.decided_by, DEMO_DOCTOR.expected_doctor_id, 'response decided_by is d-001');
  assert.ok(decide.json.decided_at, 'response decided_at should be set');
  ok(`POST decision OK — status=approved, decided_by=${decide.json.decided_by}`);

  // ============ STEP 7: Patient GET — see updated status ============
  console.log('\n[b2-refill] === step 7: GET /api/patient/refill — status updated ===');
  const pListAfter = await req(TEST_PORT, {
    path: '/api/patient/refill',
    cookies: patientCookie,
  });
  assert.equal(pListAfter.status, 200, `GET patient refill after decision should be 200, got ${pListAfter.status}`);
  const afterRow = pListAfter.json.requests.find(r => r.request_id === requestId);
  assert.ok(afterRow, 'patient list should still contain the request after doctor decision');
  assert.equal(afterRow.status, 'approved', `status should now be approved, got ${afterRow.status}`);
  assert.equal(afterRow.doctor_notes, 'OK to refill', 'doctor_notes propagated to patient');
  assert.ok(afterRow.decided_at, 'decided_at should be populated after decision');
  assert.equal(afterRow.decided_by, DEMO_DOCTOR.expected_doctor_id, 'decided_by is d-001');
  ok(`patient GET after decision OK — status=approved, doctor_notes="${afterRow.doctor_notes}", decided_at populated`);

  // ============ STEP 8a: POST /api/patient/refill without pid cookie → 401 ============
  console.log('\n[b2-refill] === step 8a: POST refill without patient auth → 401 ===');
  const noAuth = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/refill',
    headers: { 'x-csrf-token': patientCsrf },
    body: { drug_name: 'Aspirin', requested_qty: 1 },
  });
  assert.equal(noAuth.status, 401, `POST without pid should be 401, got ${noAuth.status} body=${noAuth.body}`);
  ok(`POST without pid → ${noAuth.status} (expected 401)`);

  // ============ STEP 8b: POST /api/patient/refill with cookie but no CSRF → 403 ============
  console.log('\n[b2-refill] === step 8b: POST refill without CSRF → 403 ===');
  const noCsrf = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/refill',
    cookies: patientCookie,
    body: { drug_name: 'Aspirin', requested_qty: 1 },
  });
  assert.equal(noCsrf.status, 403, `POST without csrf should be 403, got ${noCsrf.status} body=${noCsrf.body}`);
  assert.ok(noCsrf.json && noCsrf.json.error === 'csrf_invalid', `expected error=csrf_invalid, got ${JSON.stringify(noCsrf.json)}`);
  ok(`POST without csrf → ${noCsrf.status} csrf_invalid (expected 403)`);

  // ============ STEP 8c: invalid decision value → 400 ============
  console.log('\n[b2-refill] === step 8c: POST decision with bad value → 400 ===');
  // Create a second pending request first so we have something to decide on
  const post2 = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/refill',
    cookies: patientCookie,
    headers: { 'x-csrf-token': patientCsrf },
    body: { drug_name: 'Atorvastatin', requested_qty: 1, urgency: 'high' },
  });
  assert.equal(post2.status, 201, 'second POST should be 201');
  const badDecide = await req(TEST_PORT, {
    method: 'POST', path: `/api/refill/${post2.json.request_id}/decision`,
    cookies: doctorCookie,
    headers: { 'x-csrf-token': doctorCsrf },
    body: { decision: 'maybe_later' },
  });
  assert.equal(badDecide.status, 400, `bad decision value should be 400, got ${badDecide.status}`);
  ok(`bad decision value → ${badDecide.status} (expected 400)`);

  // ============ STEP 8d: invalid transition (approved → approved) → 409 ============
  console.log('\n[b2-refill] === step 8d: POST decision on already-approved → 409 ===');
  const secondApprove = await req(TEST_PORT, {
    method: 'POST', path: `/api/refill/${requestId}/decision`,
    cookies: doctorCookie,
    headers: { 'x-csrf-token': doctorCsrf },
    body: { decision: 'approved' },
  });
  assert.equal(secondApprove.status, 409, `re-approve should be 409, got ${secondApprove.status} body=${secondApprove.body}`);
  ok(`approved → approved transition blocked with 409`);

  // ============ STEP 8e: pending → fulfilled (forward chain) ============
  console.log('\n[b2-refill] === step 8e: POST decision fulfilled on approved → 200 ===');
  const fulfill = await req(TEST_PORT, {
    method: 'POST', path: `/api/refill/${requestId}/decision`,
    cookies: doctorCookie,
    headers: { 'x-csrf-token': doctorCsrf },
    body: { decision: 'fulfilled' },
  });
  assert.equal(fulfill.status, 200, `approved → fulfilled should be 200, got ${fulfill.status}`);
  assert.equal(fulfill.json.status, 'fulfilled', 'status is fulfilled');
  ok(`approved → fulfilled transition OK`);

  console.log('\nAll Week-2 / B2 medication refill request tests passed.');
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
