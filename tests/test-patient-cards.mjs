// Week-2 Patient Portal — patient home cards smoke test
//
// Verifies the three new section-cards on patient/home.html have a working
// backend to talk to:
//
//   A) Adherence      GET /api/patient/adherence/today   (and range for streak)
//   B) Refill         GET /api/patient/refill
//   C) Appointments   GET /api/patient/appointments
//                     GET /api/patient/appointment-slots
//
// Plus static checks on the source:
//   - public/app.js exposes `getCookie` (the CSRF helper used by API.req)
//   - public/patient/home.html references all three Hindi section titles
//
// Run from repo root:   node tests/test-patient-cards.mjs
// Run from any dir:     node /abs/path/to/tests/test-patient-cards.mjs
//
// Dep-free — only node:assert, node:fs, node:path, global fetch.

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Allow overriding the server via env var. Default: http://127.0.0.1:3000
// (matches the test/all-backend server's default port).
const BASE = process.env.TATVACARE_BASE || 'http://127.0.0.1:3000';

// Seed patient from db/migrations/002_seed.sql — phone +919812345670.
//
// Vedadb VBP engine doesn't support the `encode(sha256(...))::bytea` form used
// by migration 006 to seed per-patient passwords, so all seeded patient
// passwords collapse to sha256('patient123'). The doctor credentials seeded
// earlier (also via encode(sha256(...))) have the same problem and end up
// as sha256('tatva123'). We hardcode the actual working passwords here, not
// the documented 'last 6 digits of phone' (see tests/test-b2-refill.mjs for
// the long-form explanation).
const PATIENT_PHONE = '+919812345670';
const PATIENT_PASS = 'patient123';

let pass = 0, fail = 0;
function ok(label) { console.log(`  ✓ ${label}`); pass++; }
function bad(label, err) {
  console.error(`  ✗ ${label}`);
  if (err) console.error('    ' + (err.stack || err.message || err));
  fail++;
}

async function check(label, fn) {
  try { await fn(); ok(label); }
  catch (e) { bad(label, e); }
}

console.log(`\nTatvaCare patient-cards smoke  →  ${BASE}\n`);

// ============ 1. Login as p-001 ============
let sessionCookies = '';
let csrfToken = '';
await check('login as p-001', async () => {
  const r = await fetch(`${BASE}/api/patient/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneOrEmail: PATIENT_PHONE, password: PATIENT_PASS }),
  });
  assert.equal(r.status, 200, `login returned ${r.status}`);
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  // Fallback for older Node — parse raw Set-Cookie header.
  const cookies = setCookies.length ? setCookies : (r.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/);
  // Collect BOTH the session cookie AND the CSRF cookie so state-changing
  // requests can satisfy the double-submit (cookie value must equal the
  // x-csrf-token header value).
  const cookieParts = [];
  for (const c of cookies) {
    const m = c.split(';')[0];
    if (m.startsWith('pid=')) {
      cookieParts.push(m);
      sessionCookies = m;
    }
    if (m.startsWith('csrf_token=')) {
      cookieParts.push(m);
      csrfToken = m.split('=')[1];
    }
  }
  sessionCookies = cookieParts.join('; ');
  assert.ok(sessionCookies.includes('pid='), 'expected pid session cookie');
  assert.ok(csrfToken, 'expected csrf_token cookie for state-changing calls');
});

const authHeaders = { Cookie: sessionCookies };

// ============ 2. Card A — Adherence today + range (streak) ============
await check('GET /api/patient/adherence/today returns 200 with rows[]', async () => {
  const r = await fetch(`${BASE}/api/patient/adherence/today`, { headers: authHeaders });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.rows), 'response.rows must be an array');
  // If there are rows, each must have the fields the JS reads.
  for (const row of j.rows.slice(0, 5)) {
    assert.ok('adherence_id' in row, 'row.adherence_id missing');
    assert.ok('drug_name' in row, 'row.drug_name missing');
    assert.ok('schedule_slot' in row, 'row.schedule_slot missing');
    assert.ok('status' in row, 'row.status missing');
  }
});

await check('GET /api/patient/adherence (range) returns streak_days', async () => {
  const r = await fetch(`${BASE}/api/patient/adherence`, { headers: authHeaders });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.rows), 'response.rows must be an array');
  assert.ok('streak_days' in j, 'response.streak_days missing (needed for 🔥 badge)');
  assert.equal(typeof j.streak_days, 'number', 'streak_days must be a number');
});

await check('POST /api/patient/adherence (taken) with CSRF works', async () => {
  const now = new Date();
  const slot = 'morning';
  const r = await fetch(`${BASE}/api/patient/adherence`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({
      drug_name: 'Metformin',
      dose: '500mg',
      schedule_slot: slot,
      scheduled_at: now.toISOString(),
      status: 'taken',
      taken_at: now.toISOString(),
    }),
  });
  assert.equal(r.status, 201, `expected 201 got ${r.status}`);
  const j = await r.json();
  assert.ok(j.adherence_id, 'response.adherence_id missing');
  assert.equal(j.status, 'taken');
});

await check('POST /api/patient/adherence without CSRF returns 403', async () => {
  const now = new Date();
  const r = await fetch(`${BASE}/api/patient/adherence`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drug_name: 'Metformin',
      schedule_slot: 'morning',
      scheduled_at: now.toISOString(),
      status: 'taken',
    }),
  });
  assert.equal(r.status, 403, `expected 403 (csrf_invalid) got ${r.status}`);
});

// ============ 3. Card B — Refill ============
await check('GET /api/patient/refill returns 200 with requests[]', async () => {
  const r = await fetch(`${BASE}/api/patient/refill`, { headers: authHeaders });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.requests), 'response.requests must be an array');
});

await check('POST /api/patient/refill with CSRF works', async () => {
  const r = await fetch(`${BASE}/api/patient/refill`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({
      drug_name: 'Amlodipine',
      current_stock: 3,
      requested_qty: 30,
      urgency: 'normal',
      patient_notes: 'smoke test',
    }),
  });
  assert.equal(r.status, 201, `expected 201 got ${r.status}`);
  const j = await r.json();
  assert.ok(j.request_id, 'response.request_id missing');
  assert.equal(j.status, 'pending');
});

// ============ 4. Card C — Appointments ============
await check('GET /api/patient/appointments returns 200 with appointments[]', async () => {
  const r = await fetch(`${BASE}/api/patient/appointments`, { headers: authHeaders });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.appointments), 'response.appointments must be an array');
});

await check('GET /api/patient/appointment-slots returns slots[]', async () => {
  const today = new Date();
  const in7 = new Date(today.getTime() + 7 * 86400 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const r = await fetch(
    `${BASE}/api/patient/appointment-slots?from=${fmt(today)}&to=${fmt(in7)}`,
    { headers: authHeaders },
  );
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.slots), 'response.slots must be an array');
});

// ============ 5. Static checks on source ============
const appJsPath = join(REPO_ROOT, 'public/app.js');
const homeHtmlPath = join(REPO_ROOT, 'public/patient/home.html');

await check('public/app.js exists and defines getCookie()', async () => {
  assert.ok(existsSync(appJsPath), `${appJsPath} not found`);
  const src = readFileSync(appJsPath, 'utf8');
  assert.match(src, /function\s+getCookie\s*\(/, 'getCookie() not defined in public/app.js');
  assert.match(src, /x-csrf-token/, 'x-csrf-token header not referenced');
  assert.match(src, /csrf_token/, 'csrf_token cookie name not referenced');
});

await check('public/app.js exports getCookie on window.TatvaCare', async () => {
  const src = readFileSync(appJsPath, 'utf8');
  // Either comma-form (multi-line) or last-item form.
  assert.match(src, /TatvaCare\s*=\s*\{[\s\S]*?\bgetCookie\b/, 'getCookie missing from window.TatvaCare export');
});

await check('public/patient/home.html has all 3 section titles + load functions', async () => {
  assert.ok(existsSync(homeHtmlPath), `${homeHtmlPath} not found`);
  const src = readFileSync(homeHtmlPath, 'utf8');
  assert.ok(src.includes('आज की दवाई'), 'Hindi title "आज की दवाई" missing');
  assert.ok(src.includes('दवाई रिफ़िल'), 'Hindi title "दवाई रिफ़िल" missing');
  assert.ok(src.includes('अपॉइंटमेंट'), 'Hindi title "अपॉइंटमेंट" missing');
  assert.match(src, /function\s+loadAdherenceCard\s*\(/, 'loadAdherenceCard() not defined');
  assert.match(src, /function\s+loadRefillCard\s*\(/, 'loadRefillCard() not defined');
  assert.match(src, /function\s+loadAppointmentCard\s*\(/, 'loadAppointmentCard() not defined');
});

await check('home.html wires the 3 loaders via Promise.allSettled', async () => {
  const src = readFileSync(homeHtmlPath, 'utf8');
  // Tolerate whitespace + newlines around the loader calls in the source.
  // Actual source: Promise.allSettled([ loadAdherenceCard(), loadRefillCard(), loadAppointmentCard() ])
  assert.match(src, /Promise\.allSettled\(\[\s*loadAdherenceCard\s*\(\s*\)\s*,\s*loadRefillCard\s*\(\s*\)\s*,\s*loadAppointmentCard\s*\(\s*\)\s*,?\s*\]/, 'parallel loader trigger missing');
});

// ============ Summary ============
console.log(`\n${pass + fail} checks  ·  ${pass} passed  ·  ${fail} failed`);
if (fail > 0) {
  console.error('\nFAIL — see ✗ lines above.\n');
  process.exit(1);
}
console.log('PASS\n');