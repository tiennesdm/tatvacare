// Week-2 / B1 — Medication Adherence Backend Tests
//
// Covers the 3 new endpoints on /api/patient/adherence*:
//   POST /api/patient/adherence         (requirePatientAuthCsrf)
//   GET  /api/patient/adherence         (requirePatientAuth)
//   GET  /api/patient/adherence/today   (requirePatientAuth)
//
// Pattern: dep-free, node:assert + node:http + fetch.
// Boots a fresh TatvaCare backend on TEST_PORT, then tears it down.
//
// Auth model under test:
//   - No pid cookie + POST        → 401
//   - pid cookie + POST, no csrf  → 403 (Week-1 PR CSRF in effect)
//   - pid cookie + valid csrf     → 200/201
//
// Seed assumptions (from db/migrations/006 + 002 + README.md):
//   - Patient p-001 (Rakesh Kumar) has phone '+919812345670'.
//   - Password = 'patient123' (sha256(d4587ea9...71e), per README.md line 318
//     and verified against the live Vedadb patient_credentials row).
//     Note: the migration 006 SQL says "phone last 6 digits" but the engine
//     v1 doesn't fully support `encode(sha256(...::bytea), 'hex')` so the
//     actual seeded hash for every patient is sha256('patient123'). The
//     README documents this correctly.
//   - patient_credentials row exists for p-001.
//
// Run: `node tests/test-b1-adherence.mjs` from repo root.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SERVER_ENTRY = join(REPO_ROOT, 'backend', 'server.mjs');
const TEST_PORT = parseInt(process.env.TEST_PORT || '3090', 10);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Patient p-001 from db/migrations/002_seed.sql + README.md
const DEMO_PATIENT = {
  phone: '+919812345670',
  password: 'patient123',         // README.md line 318 — also the actual seeded hash
  expected_patient_id: 'p-001',
};

// ============ HTTP test client (mirrors tests/test-security.mjs) ============

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
    // URL-decode because Set-Cookie values with +/= are percent-encoded
    // by the HTTP layer — mirrors what the browser would do internally.
    out[first.slice(0, eq).trim()] = decodeURIComponent(first.slice(eq + 1).trim());
  }
  return out;
}

function cookieHeader(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ============ Spawn the TatvaCare backend on TEST_PORT ============

console.log(`[b1-adherence] booting server.mjs on :${TEST_PORT} …`);
const child = spawn(process.execPath, [SERVER_ENTRY], {
  env: { ...process.env, PORT: String(TEST_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: REPO_ROOT,
});

let serverLog = '';
child.stdout.on('data', (b) => { serverLog += b.toString(); process.stdout.write(`  [srv] ${b}`); });
child.stderr.on('data', (b) => { serverLog += b.toString(); process.stderr.write(`  [srv!] ${b}`); });
child.on('exit', (code) => { console.log(`[b1-adherence] server exited code=${code}`); });

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

  // Clean up any leftover med_adherence rows for p-001 from previous test
  // runs so the rollup assertion (50% adherence with 1 taken + 1 missed) is
  // deterministic. This is a test-only side-effect on the local DB.
  try {
    const cleanRes = await req(TEST_PORT, {
      method: 'DELETE', path: '/api/__test__/reset-adherence',
    });
    // Ignore — endpoint may not exist; we'll fall through to direct VBP cleanup.
    void cleanRes;
  } catch {}

  // Direct VBP cleanup of p-001 adherence rows so the range-query
  // assertion in step 5 sees exactly the rows this test inserted.
  {
    const { VBPPool } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs');
    const cleanupPool = new VBPPool('127.0.0.1', 6381, 2);
    await cleanupPool.query("DELETE FROM med_adherence WHERE patient_id = 'p-001'");
    await cleanupPool.closeAll();
  }

  // ===== 1. Patient login =====
  console.log('\n[b1-adherence] === step 1: patient login ===');
  const login = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/auth/login',
    body: { phoneOrEmail: DEMO_PATIENT.phone, password: DEMO_PATIENT.password },
  });
  assert.equal(login.status, 200, `login should be 200, got ${login.status} body=${login.body}`);
  assert.ok(login.json && login.json.patient, 'login response missing patient');
  assert.equal(login.json.patient.patient_id, DEMO_PATIENT.expected_patient_id, `expected ${DEMO_PATIENT.expected_patient_id}`);
  const cookies = parseCookies(login.setCookies);
  assert.ok(cookies.pid, 'login sets pid cookie');
  assert.ok(cookies.csrf_token, 'login sets csrf_token cookie');
  assert.ok(login.json.csrfToken, 'login returns csrfToken in body');
  const pidCookie = `pid=${cookies.pid}`;
  const csrfCookie = `csrf_token=${cookies.csrf_token}`;
  const fullCookie = `${pidCookie}; ${csrfCookie}`;
  ok(`login OK — patient_id=${login.json.patient.patient_id}, csrf token issued`);

  // ===== 2. POST /api/patient/adherence — today morning, taken =====
  console.log('\n[b1-adherence] === step 2: POST today morning, status=taken ===');
  const todayMorning = new Date();
  todayMorning.setUTCHours(8, 0, 0, 0);
  const todayMorningISO = todayMorning.toISOString();
  const takenAtISO = new Date().toISOString();

  const post1 = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/adherence',
    cookies: fullCookie,
    headers: { 'x-csrf-token': login.json.csrfToken },
    body: {
      drug_name: 'Metformin',
      dose: '500mg',
      schedule_slot: 'morning',
      scheduled_at: todayMorningISO,
      status: 'taken',
      taken_at: takenAtISO,
      notes: 'After breakfast',
    },
  });
  assert.equal(post1.status, 201, `POST should be 201, got ${post1.status} body=${post1.body}`);
  assert.ok(post1.json && post1.json.adherence_id, 'POST response missing adherence_id');
  assert.equal(post1.json.drug_name, 'Metformin', 'drug_name echoed back');
  assert.equal(post1.json.status, 'taken', 'status echoed back');
  const adherenceIdToday = post1.json.adherence_id;
  ok(`POST today/taken OK — adherence_id=${adherenceIdToday}`);

  // ===== 3. GET /api/patient/adherence/today — must contain the row =====
  console.log('\n[b1-adherence] === step 3: GET /adherence/today ===');
  const today = await req(TEST_PORT, {
    path: '/api/patient/adherence/today',
    cookies: fullCookie,
  });
  assert.equal(today.status, 200, `GET today should be 200, got ${today.status}`);
  assert.ok(Array.isArray(today.json.rows), 'today response rows should be array');
  const foundToday = today.json.rows.find(r => r.adherence_id === adherenceIdToday);
  assert.ok(foundToday, 'today response should contain the row we just inserted');
  assert.equal(foundToday.status, 'taken', 'today row status should be taken');
  assert.equal(foundToday.schedule_slot, 'morning', 'today row schedule_slot should be morning');
  ok(`GET today OK — found ${today.json.rows.length} row(s) for today, includes our insert`);

  // ===== 4. POST yesterday morning, status=missed =====
  console.log('\n[b1-adherence] === step 4: POST yesterday, status=missed ===');
  const yesterdayMorning = new Date(todayMorning);
  yesterdayMorning.setUTCDate(yesterdayMorning.getUTCDate() - 1);

  const post2 = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/adherence',
    cookies: fullCookie,
    headers: { 'x-csrf-token': login.json.csrfToken },
    body: {
      drug_name: 'Metformin',
      dose: '500mg',
      schedule_slot: 'morning',
      scheduled_at: yesterdayMorning.toISOString(),
      status: 'missed',
      notes: 'Forgot before breakfast',
    },
  });
  assert.equal(post2.status, 201, `POST yesterday should be 201, got ${post2.status} body=${post2.body}`);
  assert.ok(post2.json.adherence_id, 'POST yesterday response missing adherence_id');
  const adherenceIdYesterday = post2.json.adherence_id;
  ok(`POST yesterday/missed OK — adherence_id=${adherenceIdYesterday}`);

  // ===== 5. GET /api/patient/adherence?from=...&to=... — adherence_pct < 100 =====
  console.log('\n[b1-adherence] === step 5: GET range, expect adherence_pct < 100 ===');
  const fromStr = new Date(yesterdayMorning.getTime() - 86400 * 1000).toISOString().slice(0, 10);
  const toStr = new Date(todayMorning.getTime() + 86400 * 1000).toISOString().slice(0, 10);
  const range = await req(TEST_PORT, {
    path: `/api/patient/adherence?from=${fromStr}&to=${toStr}`,
    cookies: fullCookie,
  });
  assert.equal(range.status, 200, `GET range should be 200, got ${range.status}`);
  assert.ok(Array.isArray(range.json.rows), 'range response rows should be array');
  assert.equal(typeof range.json.adherence_pct, 'number', 'adherence_pct should be a number');
  assert.ok(range.json.adherence_pct < 100, `adherence_pct should be < 100 with 1 missed, got ${range.json.adherence_pct}`);
  assert.ok(range.json.adherence_pct >= 0 && range.json.adherence_pct <= 100, 'adherence_pct should be 0..100');
  assert.equal(typeof range.json.streak_days, 'number', 'streak_days should be a number');
  assert.ok(range.json.streak_days >= 0, 'streak_days should be ≥ 0');
  // 1 taken / 2 total (taken + missed) = 50%
  assert.equal(range.json.adherence_pct, 50, `expected 50% with 1 taken + 1 missed, got ${range.json.adherence_pct}`);
  assert.equal(range.json.totals.taken, 1, 'totals.taken should be 1');
  assert.equal(range.json.totals.missed, 1, 'totals.missed should be 1');
  ok(`GET range OK — pct=${range.json.adherence_pct}%, streak_days=${range.json.streak_days}, totals=${JSON.stringify(range.json.totals)}`);

  // ===== 6. POST without auth cookie → 401 =====
  console.log('\n[b1-adherence] === step 6: POST without auth cookie → 401 ===');
  const noAuth = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/adherence',
    headers: { 'x-csrf-token': login.json.csrfToken },
    body: {
      drug_name: 'Metformin', schedule_slot: 'morning',
      scheduled_at: todayMorningISO, status: 'taken',
    },
  });
  assert.equal(noAuth.status, 401, `POST without auth should be 401, got ${noAuth.status} body=${noAuth.body}`);
  ok(`POST without auth → ${noAuth.status} (expected 401)`);

  // ===== 7. POST with patient cookie but NO CSRF header → 403 =====
  console.log('\n[b1-adherence] === step 7: POST with cookie but no csrf → 403 ===');
  const noCsrf = await req(TEST_PORT, {
    method: 'POST', path: '/api/patient/adherence',
    cookies: fullCookie,  // pid + csrf_token cookie, but no x-csrf-token header
    body: {
      drug_name: 'Metformin', schedule_slot: 'morning',
      scheduled_at: todayMorningISO, status: 'taken',
    },
  });
  assert.equal(noCsrf.status, 403, `POST without csrf should be 403, got ${noCsrf.status} body=${noCsrf.body}`);
  assert.ok(noCsrf.json && noCsrf.json.error === 'csrf_invalid', `expected error=csrf_invalid, got ${JSON.stringify(noCsrf.json)}`);
  ok(`POST without csrf → ${noCsrf.status} csrf_invalid (expected 403)`);

  console.log('\nAll Week-2 / B1 medication adherence tests passed.');
} catch (e) {
  console.error('\nTEST ERROR:', e.stack || e.message);
  exitCode = 1;
} finally {
  // Tear down: SIGINT the server.
  try { child.kill('SIGINT'); } catch {}
  // Give it up to 3s to exit cleanly.
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
  process.exit(exitCode);
}
