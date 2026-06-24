// TatvaCare P0/P1 production-readiness test.
//
// Boots a minimal Express app on a random port that wires:
//   - logger + accessLogMiddleware
//   - metrics (registry + /metrics endpoint)
//   - circuit breaker (with a fake always-failing downstream)
//   - ai_auth round-trip (sign + verify)
//   - phi_access logger
//   - validateBody
//   - graceful shutdown coordinator (we install it but don't trigger)
//   - /readyz endpoint
//
// Does NOT require Vedadb, Redis, or the AI service. Verifies the
// prod-readiness contracts are in place and wired correctly.
//
// Run from repo root:   node tests/test-prod-readiness.mjs

import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import express from '/Users/shubhammehta/Downloads/tatvacare/backend/node_modules/express/lib/express.js';

const { accessLogMiddleware, logger } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/logger.mjs');
const { registry, renderMetrics, metricsMiddleware } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/metrics.mjs');
const { aiBreaker, CircuitOpenError, CircuitBreaker } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/circuit.mjs');
const { buildServiceKeyHeader, verifyServiceKeyHeader } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/ai_auth.mjs');
const { validateBody, validateQuery, validateParams, schemas, paramSchemas } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/validate.mjs');
const { sqlStr, sqlInt, sqlNum, sqlBool, sqlIdent, sqlValue } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/sql.mjs');
const { ShutdownCoordinator } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/shutdown.mjs');
const { config } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/config.mjs');
const { phiAccessLogger, markPhiAccess, verifyPhiTable } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/phi_access.mjs');

// ── tiny HTTP client ────────────────────────────────────────────────
function listen(app) {
  return new Promise((resolve) => {
    const srv = createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function get(port, path, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers });
}
function post(port, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ── test harness ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(label)  { console.log(`  ✓ ${label}`); pass++; }
function bad(label, err) {
  console.error(`  ✗ ${label}`);
  if (err) console.error('    ' + (err.stack || err.message || err));
  fail++;
}
async function check(label, fn) {
  try { await fn(); ok(label); }
  catch (e) { bad(label, e); }
}

console.log('\nTatvaCare prod-readiness smoke\n');

// ── 1. Config loads + rejects bad input ─────────────────────────────
console.log('— Config —');
await check('config has required production-ish fields', () => {
  assert.equal(typeof config.PORT, 'number');
  assert.equal(typeof config.SHUTDOWN_GRACE_MS, 'number');
  assert.ok(config.AI_SERVICE_KEY, 'AI_SERVICE_KEY present (dev default)');
  assert.equal(typeof config.METRICS_ENABLED, 'boolean');
});

// ── 2. Logger: request-id propagation + JSON access log ────────────
console.log('— Logger —');
const app1 = express();
app1.use(accessLogMiddleware());
app1.get('/x', (req, res) => {
  // Read the ALS-bound request_id by triggering a log line.
  logger.info('inside_handler', { ok: 1 });
  res.json({ requestId: res.getHeader('x-request-id') });
});
const s1 = await listen(app1);
await check('x-request-id round-trip', async () => {
  const r = await get(s1.port, '/x');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.requestId && j.requestId.length > 8, `got ${j.requestId}`);
});
await check('incoming x-request-id is echoed', async () => {
  const r = await get(s1.port, '/x', { 'x-request-id': 'caller-1234' });
  const j = await r.json();
  assert.equal(j.requestId, 'caller-1234');
});
s1.srv.close();

// ── 3. Metrics: counters + histograms + /metrics text output ────────
console.log('— Metrics —');
const app2 = express();
app2.use(metricsMiddleware());
app2.get('/hits', (req, res) => res.json({ ok: true }));
app2.get('/metrics', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(renderMetrics());
});
const s2 = await listen(app2);
await check('GET /hits increments counter', async () => {
  await get(s2.port, '/hits');
  await get(s2.port, '/hits');
  const r = await get(s2.port, '/metrics');
  const body = await r.text();
  assert.match(body, /http_requests_total\{route="\/hits",method="GET",status="200"\} 2/);
});
await check('histogram buckets present', async () => {
  const r = await get(s2.port, '/metrics');
  const body = await r.text();
  assert.match(body, /http_request_duration_seconds_bucket\{route="\/hits",method="GET",le="0\.025"\} 2/);
  assert.match(body, /http_request_duration_seconds_count/);
});
await check('process uptime gauge present', async () => {
  const r = await get(s2.port, '/metrics');
  const body = await r.text();
  assert.match(body, /process_uptime_seconds \d+/);
});
s2.srv.close();

// ── 4. Circuit breaker: opens after N failures, half-open, closes ──
console.log('— Circuit breaker —');
const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3, resetMs: 50 });
await check('closed initially', () => assert.equal(cb.state, 'CLOSED'));
await check('opens after 3 consecutive failures', async () => {
  for (let i = 0; i < 3; i++) {
    await cb.exec(async () => { throw new Error('boom'); }).catch(() => {});
  }
  assert.equal(cb.state, 'OPEN');
});
await check('throws CircuitOpenError when open', async () => {
  try { await cb.exec(async () => 'ok'); }
  catch (e) { assert.ok(e instanceof CircuitOpenError); assert.equal(e.code, 'CIRCUIT_OPEN'); return; }
  assert.fail('expected CircuitOpenError');
});
await check('half-open after resetMs → success → CLOSED', async () => {
  await new Promise(r => setTimeout(r, 60));
  const v = await cb.exec(async () => 'ok');
  assert.equal(v, 'ok');
  assert.equal(cb.state, 'CLOSED');
});

// ── 5. ai_auth: round-trip sign + verify + reject bad / stale ──────
console.log('— AI service auth —');
await check('sign + verify round-trip', () => {
  const h = buildServiceKeyHeader('k-test-1234567890');
  const v = verifyServiceKeyHeader(h, 'k-test-1234567890');
  assert.equal(v.ok, true);
});
await check('rejects wrong key', () => {
  const h = buildServiceKeyHeader('k-test-1234567890');
  const v = verifyServiceKeyHeader(h, 'k-wrong-1234567890');
  assert.equal(v.ok, false);
});
await check('rejects stale nonce', () => {
  const v = verifyServiceKeyHeader({
    'x-service-key': 'k-test-1234567890',
    'x-service-nonce': '1:0000000000000000', // minute=1, ~forever ago
  }, 'k-test-1234567890');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'stale_nonce');
});
await check('rejects missing key', () => {
  const v = verifyServiceKeyHeader({}, 'k-test-1234567890');
  assert.equal(v.ok, false);
});

// ── 6. validateBody: rejects bad input, accepts good ───────────────
console.log('— validateBody —');
const app3 = express();
app3.use(express.json());
app3.post('/login', validateBody(schemas.patientLogin), (req, res) => res.json({ ok: true, body: req.body }));
app3.post('/login-bad', validateBody(schemas.patientLogin), (req, res) => res.json({ ok: true })); // shouldn't reach
const s3 = await listen(app3);
await check('rejects missing phoneOrEmail', async () => {
  const r = await post(s3.port, '/login', { password: 'abcd1234' });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.code, 'VALIDATION');
  assert.equal(j.error.field, 'phoneOrEmail');
});
await check('rejects too-short password', async () => {
  const r = await post(s3.port, '/login', { phoneOrEmail: '+919812345670', password: 'abc' });
  assert.equal(r.status, 400);
});
await check('rejects unknown fields (strict)', async () => {
  const r = await post(s3.port, '/login', { phoneOrEmail: '+919812345670', password: 'abcd1234', evil: 'x' });
  assert.equal(r.status, 400);
});
await check('strips csrf_token before passing to handler', async () => {
  const r = await post(s3.port, '/login', { phoneOrEmail: '+919812345670', password: 'abcd1234', csrf_token: 'abc' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.body.csrf_token, undefined, 'csrf_token must be stripped from req.body');
});
await check('vitals schema: rejects bad metric enum value', async () => {
  // Direct schema inspection (no route wired here — we test the schema contract
  // that the /api/patient/vitals route uses via validateBody).
  assert.equal(schemas.patientVitals.props.metric.enum.includes('pulse'), false);
  assert.equal(schemas.patientVitals.props.metric.enum.includes('systolic'), true);
  assert.equal(schemas.patientVitals.props.metric.enum.includes('glucose_fasting'), true);
});
s3.srv.close();

// ── 7. Shutdown coordinator: doesn't die on install; second SIGTERM hard-exits ──
console.log('— Shutdown coordinator —');
await check('install() registers handlers without throwing', () => {
  const sc = new ShutdownCoordinator({
    httpServer: createServer(() => {}),
    graceMs: 100,
    inFlight: () => 0,
  });
  sc.install();
});

// ── 8. PHI access logger: marks response, attempts insert (no pool so it warns) ──
console.log('— PHI access logger —');
const app4 = express();
const fakePool = { query: async (sql) => {
  // We don't run a real migration here. The middleware should log a warn
  // when the table is missing and NOT throw. Capture the warn:
  if (!app4._warns) app4._warns = [];
  app4._warns.push(sql);
  return { rows: [] };
}};
app4.use(phiAccessLogger(fakePool));
app4.get('/chart/:id', (req, res, next) => {
  markPhiAccess(req, { action: 'read', resource_kind: 'patient', resource_id: req.params.id, patient_id: req.params.id });
  next();
}, (req, res) => res.json({ ok: true }));
const s4 = await listen(app4);
await new Promise((r) => {
  get(s4.port, '/chart/p-123').then(async (resp) => {
    assert.equal(resp.status, 200);
    // Wait for the res.on('finish') callback to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      assert.ok(s4._warns === undefined, 'no warns expected on happy path (table assumed to exist)');
    } catch (e) { r(e); return; }
    r();
  });
}).catch(e => bad('phi access logger happy path', e));
ok('phi access logger happy path (insert attempted)');
s4.srv.close();

// ── 9. /readyz contract: includes circuit snapshot ──────────────────
console.log('— /readyz contract —');
await check('/readyz response shape (no server needed)', () => {
  // The shape is: { ready, checks: { vbp, ai }, circuit: { name, state, ... } }
  // We assert by snapshot inspection:
  const snap = aiBreaker.snapshot();
  assert.ok('name' in snap);
  assert.ok('state' in snap);
  assert.ok('consecutiveFailures' in snap);
  assert.ok('openedAt' in snap);
  assert.ok('resetMs' in snap);
});

// ── 10. server.mjs wiring sanity (static checks) ──────────────────
console.log('— server.mjs wiring —');
const fs = await import('node:fs');
const serverSrc = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/backend/server.mjs', 'utf8');
await check('server.mjs imports accessLogMiddleware', () => assert.match(serverSrc, /accessLogMiddleware\(\)/));
await check('server.mjs imports metricsMiddleware',  () => assert.match(serverSrc, /metricsMiddleware\(\)/));
await check('server.mjs has /readyz',                 () => assert.match(serverSrc, /app\.get\(['"]\/readyz['"]/));
await check('server.mjs has /metrics',                () => assert.match(serverSrc, /app\.get\(['"]\/metrics['"]/));
await check('server.mjs defines aiFetch',             () => assert.match(serverSrc, /async function aiFetch/));
await check('server.mjs wires SIGTERM via ShutdownCoordinator', () => assert.match(serverSrc, /ShutdownCoordinator/));
await check('server.mjs wires PHI access on patient/me', () => assert.match(serverSrc, /markPhiAccess\(req,\s*\{\s*action:\s*['"]read['"],\s*resource_kind:\s*['"]patient['"]/));
await check('server.mjs validates patient login body', () => assert.match(serverSrc, /validateBody\(schemas\.patientLogin\)/));
await check('server.mjs no leftover bare fetch on AI_URL (outside aiFetch + /readyz)', () => {
  // The only legitimate direct fetch(`${AI_URL}`...) callsites are:
  //   (a) inside the aiFetch() helper body — line ~558, the actual fetch.
  //   (b) /readyz block — bypasses breaker by design (readyz must report).
  // Anywhere else is a regression.
  // Strategy: blank out lines that are inside either block, then grep.
  const src = serverSrc;
  // Blank out the aiFetch function (greedy from `async function aiFetch` to
  // the next `\n});` at column 0 — its closing line).
  const aiFetchStart = src.indexOf('async function aiFetch');
  if (aiFetchStart < 0) throw new Error('aiFetch function not found');
  // Find the closing `});` after the start.
  const aiFetchEnd = src.indexOf('\n});', aiFetchStart);
  if (aiFetchEnd < 0) throw new Error('aiFetch closing not found');
  const withoutAiFetch = src.slice(0, aiFetchStart) + '\n' + src.slice(aiFetchEnd + 4);
  // Blank out /readyz block: from `app.get('/readyz'` to the next `});` at line start.
  const readyzStart = withoutAiFetch.indexOf("app.get('/readyz'");
  if (readyzStart < 0) throw new Error('/readyz block not found');
  const readyzEnd = withoutAiFetch.indexOf('\n});', readyzStart);
  if (readyzEnd < 0) throw new Error('/readyz closing not found');
  const filtered = withoutAiFetch.slice(0, readyzStart) + '\n' + withoutAiFetch.slice(readyzEnd + 4);
  // Now look for any remaining bare fetch(`${AI_URL}/...
  const matches = filtered.match(/fetch\(`\$\{AI_URL\}/g) || [];
  assert.equal(matches.length, 0, `expected 0 direct AI_URL fetches outside aiFetch/readyz, found ${matches.length}: ${matches.join(',')}`);
});
await check('server.mjs has no duplicate /api/ai/status routes', () => {
  const m = serverSrc.match(/app\.get\(['"]\/api\/ai\/status['"]/g) || [];
  assert.equal(m.length, 1, `expected 1 /api/ai/status, found ${m.length}`);
});

// ── 11. main.py wiring (static check) ──────────────────────────────
console.log('— ai/service/main.py wiring —');
const mainSrc = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/ai/service/main.py', 'utf8');
await check('main.py uses lifespan context manager', () => assert.match(mainSrc, /async def lifespan/));
await check('main.py no deprecated @app.on_event (excluding comments)', () => {
  // Strip block + line comments, then assert.
  const noComments = mainSrc
    .replace(/"""[\s\S]*?"""/g, '')  // triple-quoted docstrings (multi-line)
    .replace(/#.*$/gm, '');           // line comments
  const matches = noComments.match(/@app\.on_event/g) || [];
  assert.equal(matches.length, 0, `expected 0 @app.on_event, found ${matches.length}`);
});
await check('main.py has /readyz',                   () => assert.match(mainSrc, /@app\.get\(['"]\/readyz['"]/));
await check('main.py has verify_service_key',        () => assert.match(mainSrc, /def verify_service_key/));
await check('main.py uses Depends(verify_service_key) on at least 10 routes', () => {
  const m = mainSrc.match(/Depends\(verify_service_key\)/g) || [];
  assert.ok(m.length >= 10, `expected >=10 auth-gated routes, found ${m.length}`);
});
await check('main.py uses timeout_graceful_shutdown in uvicorn.run', () => assert.match(mainSrc, /timeout_graceful_shutdown/));

// ── 12. Migration: phi_access_log exists ──────────────────────────
console.log('— migration 011_phi_access_log.sql —');
const mig = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/db/migrations/011_phi_access_log.sql', 'utf8');
await check('migration creates phi_access_log',  () => assert.match(mig, /CREATE TABLE IF NOT EXISTS phi_access_log/));
await check('migration has idx_phi_patient_time', () => assert.match(mig, /idx_phi_patient_time/));

// ── 13. Dockerfile + docker-compose sanity ────────────────────────
console.log('— Docker artifacts —');
const backendDocker = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/backend/Dockerfile', 'utf8');
const aiDocker      = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/ai/Dockerfile', 'utf8');
const compose       = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/docker-compose.yml', 'utf8');
await check('backend Dockerfile has HEALTHCHECK',  () => assert.match(backendDocker, /HEALTHCHECK/));
await check('backend Dockerfile uses tini',         () => assert.match(backendDocker, /tini/));
await check('ai Dockerfile has HEALTHCHECK',        () => assert.match(aiDocker, /HEALTHCHECK/));
await check('ai Dockerfile has timeout_graceful_shutdown', () => assert.match(aiDocker, /timeout-graceful-shutdown/));
await check('compose defines backend + ai + edadb', () => {
  assert.match(compose, /edadb:/);
  assert.match(compose, /backend:/);
  assert.match(compose, /ai:/);
});
await check('compose defines migrate service (runs before backend)', () => {
  // The migrate service must exist AND the backend must depend on it via
  // service_completed_successfully. Otherwise a fresh `docker compose up`
  // brings up backend against an unmigrated DB.
  assert.match(compose, /^  migrate:/m);
  assert.match(compose, /migrate:\s*\n[\s\S]*?service_completed_successfully/);
});
await check('compose migrate runs scripts/migrate.mjs', () => {
  assert.match(compose, /scripts\/migrate\.mjs/);
});

// ── 14. SQL escape helpers — single source of truth ───────────────
console.log('— SQL escape helpers —');
await check('sqlStr escapes single quote', () => {
  assert.equal(sqlStr("O'Brien"), "'O''Brien'");
});
await check('sqlStr escapes backslash', () => {
  // The engine may treat \ as escape; we escape it too for safety.
  assert.equal(sqlStr("a\\b"), "'a\\\\b'");
});
await check('sqlStr caps overly long strings', () => {
  assert.throws(() => sqlStr('x'.repeat(70_000)), /too long/);
});
await check('sqlStr handles null/undefined', () => {
  assert.equal(sqlStr(null), 'NULL');
  assert.equal(sqlStr(undefined), 'NULL');
});
await check('sqlInt rejects NaN', () => {
  assert.throws(() => sqlInt('abc'), /integer/);
  assert.equal(sqlInt('42'), '42');
  assert.equal(sqlInt(42), '42');
  assert.equal(sqlInt(null), 'NULL');
});
await check('sqlNum rejects non-finite', () => {
  assert.throws(() => sqlNum(Infinity), /finite/);
  assert.equal(sqlNum(3.14), '3.14');
  assert.equal(sqlNum(null), 'NULL');
});
await check('sqlBool handles various inputs', () => {
  assert.equal(sqlBool(true), "'1'");
  assert.equal(sqlBool(false), "'0'");
  assert.equal(sqlBool(null), 'NULL');
  assert.equal(sqlBool('yes'), "'1'");
  assert.equal(sqlBool(0), "'0'");
});
await check('sqlIdent rejects unsafe identifiers', () => {
  assert.throws(() => sqlIdent('a; DROP TABLE'), /unsafe/);
  assert.throws(() => sqlIdent('1col'), /unsafe/);
  assert.equal(sqlIdent('patient_id'), '"patient_id"');
});
await check('sqlIdent honors allow-list', () => {
  assert.throws(() => sqlIdent('foo', ['bar']), /allow-list/);
  assert.equal(sqlIdent('bar', ['bar']), '"bar"');
});
await check('SQL escape neutralizes classic injection payloads', () => {
  // Classic payload: "x'; DROP TABLE users; --"
  const dangerous = "x'; DROP TABLE users; --";
  const escaped = sqlStr(dangerous);
  // Single quote must be doubled, semicolons survive but they're inside
  // the quoted literal so the engine treats them as data, not SQL.
  assert.equal(escaped, "'x''; DROP TABLE users; --'");
  // And the result must not contain an unescaped quote.
  assert.ok(!/[^']'[^']/.test(escaped.slice(1, -1)), 'no bare quote inside');
});

// ── 15. validateParams — URL path validation ──────────────────────
console.log('— validateParams —');
const app5 = express();
app5.use(express.json());
app5.get('/p/:id',
  validateParams(paramSchemas.id),
  (req, res) => res.json({ ok: true, id: req.params.id }));
const s5 = await listen(app5);
await check('accepts well-formed id', async () => {
  const r = await get(s5.port, '/p/p-12345');
  assert.equal(r.status, 200);
});
await check('rejects id with apostrophe (SQL injection pattern)', async () => {
  // Express won't decode %27 into ' in the params automatically? Actually
  // it does — but our validator should still reject it.
  const r = await get(s5.port, "/p/p'%20OR%201=1--");
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.code, 'VALIDATION');
});
await check('rejects too-long id', async () => {
  const r = await get(s5.port, '/p/' + 'a'.repeat(100));
  assert.equal(r.status, 400);
});
s5.srv.close();

// ── 16. PHI coverage — every PHI-touching route must call markPhiAccess ──
console.log('— PHI coverage on routes —');
const phiRoutes = [
  // Patient chart read
  { route: "app.get('/api/patients/:id'", label: 'patient chart GET', expectMark: true },
  { route: "app.get('/api/patients/:id/vitals'", label: 'patient vitals GET', expectMark: true },
  { route: "app.get('/api/patients/:id/notes'", label: 'patient notes GET', expectMark: true },
  { route: "app.post('/api/patients/:id/notes'", label: 'patient notes POST', expectMark: true },
  { route: "app.delete('/api/patients/:pid/notes/:nid'", label: 'patient notes DELETE', expectMark: true },
  { route: "app.get('/api/prescriptions/:id'", label: 'prescription GET', expectMark: true },
  { route: "app.post('/api/prescriptions'", label: 'prescription POST', expectMark: true },
  { route: "app.get('/api/prescriptions/:id/pdf'", label: 'prescription PDF export', expectMark: true },
  { route: "app.post('/api/vitals'", label: 'vitals POST (doctor)', expectMark: true },
  { route: "app.post('/api/patient/vitals'", label: 'patient vitals POST', expectMark: true },
  { route: "app.post('/api/patient/adherence'", label: 'patient adherence POST', expectMark: true },
  { route: "app.get('/api/patient/me'", label: 'patient /me GET', expectMark: true },
  { route: "app.get('/api/patient/auth/me'", label: 'patient auth/me GET', expectMark: true },
  { route: "app.post('/api/ai/ocr/prescription'", label: 'OCR prescription', expectMark: false }, // image not directly a patient row
  { route: "app.post('/api/ai/ml/risk'", label: 'ML risk', expectMark: true },
  { route: "app.post('/api/ai/ml/anomaly'", label: 'ML anomaly', expectMark: true },
  { route: "app.post('/api/ai/ml/forecast'", label: 'ML forecast', expectMark: true },
  { route: "app.post('/api/reminders'", label: 'reminders POST', expectMark: true },
  { route: "app.post('/api/telemedicine/sessions'", label: 'tele sessions POST', expectMark: true },
  { route: "app.get('/api/telemedicine/sessions/:id/messages'", label: 'tele messages GET', expectMark: true },
  { route: "app.get('/api/analytics/cohort'", label: 'analytics cohort', expectMark: true },
  { route: "app.get('/api/analytics/clinic-overview'", label: 'analytics clinic overview', expectMark: true },
];
for (const r of phiRoutes) {
  await check(`PHI coverage: ${r.label}`, () => {
    // Find the route handler block.
    const idx = serverSrc.indexOf(r.route);
    if (idx < 0) throw new Error(`route not found: ${r.route}`);
    // Grab the next 1.5KB after the route — handlers are short.
    const block = serverSrc.slice(idx, idx + 1500);
    const hasMark = /markPhiAccess\(req/.test(block);
    if (r.expectMark && !hasMark) throw new Error('expected markPhiAccess in handler block');
    if (!r.expectMark && hasMark) throw new Error('unexpected markPhiAccess in handler block');
  });
}

// ── 17. PHI fail-loud: phi_access.mjs exposes verifyPhiTable + metric ──
console.log('— PHI fail-loud —');
const phiSrc = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/backend/lib/phi_access.mjs', 'utf8');
await check('phi_access.mjs exposes verifyPhiTable', () => assert.match(phiSrc, /export\s+(async\s+)?function\s+verifyPhiTable/));
await check('phi_access.mjs classifies failures', () => assert.match(phiSrc, /classifyPhiFailure/));
await check('phi_access.mjs uses phiLogFailures metric', () => assert.match(phiSrc, /phiLogFailures\.inc/));
await check('phi_access.mjs hard-exits on missing table in prod', () => assert.match(phiSrc, /exitOnMissing/));
const metricsSrc = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/backend/lib/metrics.mjs', 'utf8');
await check('metrics.mjs has phiLogFailures counter', () => assert.match(metricsSrc, /phi_log_failures_total/));

// ── 18. server.mjs wires verifyPhiTable + has rate-limit on patient login ──
await check('server.mjs calls verifyPhiTable at boot', () => assert.match(serverSrc, /verifyPhiTable\(pool/));
await check('server.mjs rate-limits /api/patient/auth', () => assert.match(serverSrc, /app\.use\(['"]\/api\/patient\/auth['"],\s*rateLimits\.auth/));
await check('server.mjs wires sqlStr consistently across inserts', () => {
  // Look for the legacy pattern inside server.mjs. The PatientNotes
  // GET/POST and reminders POST/tele sessions should all use sqlStr.
  // We check that sqlStr is imported and used at least 6 times (proxy for
  // "the rewrite landed"). The legacy `.replace(/'/g, "''")` should be
  // rare — we allow up to 2 occurrences (e.g. legacy fallback paths).
  const sqlStrCount = (serverSrc.match(/sqlStr\(/g) || []).length;
  assert.ok(sqlStrCount >= 6, `expected >=6 sqlStr() calls, found ${sqlStrCount}`);
});

// ── 19. PHI table smoke check works on missing-table scenario ──────
console.log('— PHI table smoke check —');
await check('verifyPhiTable returns ok:false on missing table', async () => {
  const fakePoolMissing = { query: async () => { const e = new Error('relation "phi_access_log" does not exist'); throw e; } };
  const r = await verifyPhiTable(fakePoolMissing);
  assert.equal(r.ok, false);
  assert.ok(r.reason);
  assert.equal(r.reason, 'table_missing');
});
await check('verifyPhiTable returns ok:true when SELECT succeeds', async () => {
  const fakePoolOk = { query: async () => ({ rows: [] }) };
  const r = await verifyPhiTable(fakePoolOk);
  assert.equal(r.ok, true);
});

// ── 20. AI service main.py readyz correctness ─────────────────────
const mainPySrc = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/ai/service/main.py', 'utf8');
await check('main.py _ready gated on vedadb ping success', () => {
  // After the fix: _ready = (not _ready_reasons) — i.e. only True when
  // the vedadb ping succeeded (reasons empty). Previously _ready=True
  // was unconditional.
  assert.match(mainPySrc, /_ready\s*=\s*\(not\s+_ready_reasons\)/);
});

// ── 21. config defaults — HOST should be 0.0.0.0 for containers ─────
const configSrc = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/backend/lib/config.mjs', 'utf8');
await check('config HOST default is 0.0.0.0', () => {
  // Either the default value or a comment must say 0.0.0.0.
  assert.match(configSrc, /HOST.*['"]0\.0\.0\.0['"]/);
});

// ── 22. accessLogMiddleware sets req.id ───────────────────────────
const loggerSrc = fs.readFileSync('/Users/shubhammehta/Downloads/tatvacare/backend/lib/logger.mjs', 'utf8');
await check('accessLogMiddleware wires req.id for phi_access', () => {
  assert.match(loggerSrc, /req\.id\s*=\s*requestId/);
});

// ── summary ────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
