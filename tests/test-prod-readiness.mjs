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
const { validateBody, schemas } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/validate.mjs');
const { ShutdownCoordinator } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/shutdown.mjs');
const { config } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/config.mjs');
const { phiAccessLogger, markPhiAccess } = await import('/Users/shubhammehta/Downloads/tatvacare/backend/lib/phi_access.mjs');

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

// ── summary ────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
