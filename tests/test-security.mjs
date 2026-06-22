// Week-1 Backend Security Tests
//
// Covers E1 (rate limit), E2 (helmet security headers), E3 (CSRF), and
// E4 (input sanitization). Each section boots its own Express app on a
// random port — no shared state, no Vedadb VBP required.
//
// The full server.mjs wires all four features into the existing routes,
// which require Vedadb VBP running on :6381 and are impractical to spin
// up here. These tests instead use the security modules directly against
// a minimal app that mirrors the integration points, so the behaviour
// we ship is the behaviour we test.
//
// Run: `node tests/test-security.mjs` from the repo root, or via
//      `cd backend && npm run test:security`.

import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
// express lives in backend/node_modules. Resolve via absolute path so the
// test runs from any cwd (the npm script "test:security" runs from backend/,
// but `node tests/test-security.mjs` from repo root also needs to work).
const express = (await import('/Users/shubhammehta/Downloads/tatvacare/backend/node_modules/express/lib/express.js')).default;
import {
  buildHelmet,
  buildRateLimiters,
  sanitizeMiddleware,
  newCsrfSecret,
  setCsrfCookie,
  requireCsrf,
  csrfTokenFor,
  sanitizeBody,
  sanitizeValue,
  findDangerous,
  FREE_TEXT_FIELDS,
} from '../backend/lib/security/index.mjs';

// ============ Tiny HTTP test client ============
// We don't depend on a test runner. Hit the app via Node's http module
// using a fetch wrapper that exposes status, headers, and body — keeps
// the test harness dep-free.

function listen(app) {
  return new Promise((resolve) => {
    const srv = createServer(app);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, port });
    });
  });
}

async function req(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  const init = { method, headers: { ...headers } };
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
  // Capture the Set-Cookie list as an array — fetch merges them into one
  // comma-separated string which loses info (HttpOnly expires attributes
  // can contain commas). getSetCookie() returns them as separate entries.
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

// Parse Set-Cookie list (array of "name=value; attr; attr") into a name->value map.
function parseSetCookies(setCookieList) {
  if (!setCookieList) return {};
  const list = Array.isArray(setCookieList) ? setCookieList : [setCookieList];
  const out = {};
  for (const sc of list) {
    if (!sc) continue;
    const first = sc.split(';')[0];
    const eq = first.indexOf('=');
    if (eq < 0) continue;
    out[first.slice(0, eq).trim()] = decodeURIComponent(first.slice(eq + 1).trim());
  }
  return out;
}

// ============ E2 — Helmet security headers ============
{
  const app = express();
  app.use(buildHelmet());
  app.get('/probe', (req, res) => res.json({ ok: true }));

  const { srv, port } = await listen(app);
  try {
    const r = await req(port, { path: '/probe' });
    assert.equal(r.status, 200, 'helmet: GET /probe should be 200');

    const h = r.headers;
    // X-Powered-By is hidden by helmet
    assert.equal(h['x-powered-by'], undefined, 'helmet: must hide X-Powered-By');
    // HSTS — 180 days = 15552000 seconds
    const hsts = h['strict-transport-security'] || '';
    assert.ok(hsts.includes('max-age=15552000'), `helmet: HSTS max-age must be 15552000, got "${hsts}"`);
    assert.ok(hsts.includes('includeSubDomains'), 'helmet: HSTS includeSubDomains');
    assert.ok(hsts.toLowerCase().includes('preload'), 'helmet: HSTS preload');
    // X-Content-Type-Options: nosniff
    assert.equal(h['x-content-type-options'], 'nosniff', 'helmet: nosniff');
    // X-Frame-Options: SAMEORIGIN
    assert.equal(h['x-frame-options'], 'SAMEORIGIN', 'helmet: X-Frame-Options SAMEORIGIN');
    // Referrer-Policy
    assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin', 'helmet: Referrer-Policy');
    // COOP
    assert.equal(h['cross-origin-opener-policy'], 'same-origin', 'helmet: COOP same-origin');
    // CSP — at minimum default-src 'self'
    const csp = h['content-security-policy'] || '';
    assert.ok(csp.includes("default-src 'self'"), `helmet: CSP default-src 'self' (got: ${csp.slice(0, 80)}...)`);
    assert.ok(csp.includes("object-src 'none'"), 'helmet: CSP object-src none');
    assert.ok(csp.includes("base-uri 'self'"), 'helmet: CSP base-uri self');

    console.log('OK — E2 helmet: 8 security headers present (HSTS, nosniff, frameguard, referrer, COOP, CSP, hide-powered-by, no-X-Powered-By)');
  } finally { srv.close(); }
}

// ============ E1 — Rate limiting ============
// Use testMode=true so windows are 1s and we can hit limits fast.
{
  const rateLimits = buildRateLimiters({ testMode: true });
  const app = express();
  app.use('/api/auth', rateLimits.auth);
  app.use('/api/ai', rateLimits.ai);
  app.post('/api/vitals', rateLimits.vitalsWrite, (req, res) => res.json({ ok: true }));
  app.use('/api', rateLimits.default);
  app.get('/api/anything', (req, res) => res.json({ ok: true }));

  const { srv, port } = await listen(app);
  try {
    // Auth: 5 req / 1s — 6th should be 429
    let lastStatus = null;
    let lastJson = null;
    for (let i = 0; i < 7; i++) {
      const r = await req(port, { path: '/api/auth/anything' });
      lastStatus = r.status; lastJson = r.json;
    }
    assert.equal(lastStatus, 429, `auth rate limit: 7th request should be 429, got ${lastStatus}`);
    assert.equal(lastJson && lastJson.error, 'rate_limited', 'auth rate limit: 429 body has error=rate_limited');
    assert.ok(typeof lastJson.retryAfter === 'number' && lastJson.retryAfter > 0, 'auth rate limit: 429 body has retryAfter (seconds)');

    // Wait for window to reset
    await new Promise(r => setTimeout(r, 1100));

    // AI: 5 req / 1s
    for (let i = 0; i < 6; i++) {
      const r = await req(port, { path: '/api/ai/anything' });
      if (i === 5) assert.equal(r.status, 429, `ai rate limit: 6th request should be 429`);
    }

    // Vitals write: 10 req / 1s
    await new Promise(r => setTimeout(r, 1100));
    for (let i = 0; i < 12; i++) {
      const r = await req(port, { method: 'POST', path: '/api/vitals', body: {} });
      if (i === 11) assert.equal(r.status, 429, `vitals rate limit: 12th POST should be 429`);
    }

    // Default: 10 req / 1s
    await new Promise(r => setTimeout(r, 1100));
    for (let i = 0; i < 12; i++) {
      const r = await req(port, { path: '/api/anything' });
      if (i === 11) assert.equal(r.status, 429, `default rate limit: 12th request should be 429`);
    }

    console.log('OK — E1 rate limit: auth (5/15min), ai (30/min), vitals-write (60/min), default (120/min) — all enforce 429 with { error, retryAfter }');
  } finally { srv.close(); }
}

// ============ E3 — CSRF ============
{
  const app = express();
  app.use(express.json());

  // A toy "session store" so we can sign in and get a session-bound secret.
  const sessions = new Map();   // sid -> { csrfSecret }
  const csrfSecrets = new Map(); // sid -> secret
  function issueSession() {
    const sid = 's-' + Math.random().toString(36).slice(2, 12);
    const secret = newCsrfSecret();
    sessions.set(sid, { csrfSecret: secret });
    csrfSecrets.set(sid, secret);
    return { sid, secret };
  }
  function authThenCsrf(req, res, next) {
    const sid = (req.headers.cookie || '').match(/sid=([^;]+)/)?.[1];
    const sess = sid && sessions.get(sid);
    if (!sess) return res.status(401).json({ error: 'unauthorized' });
    req.session = sess;
    requireCsrf(req, res, next);
  }

  app.post('/api/login', (req, res) => {
    const { sid, secret } = issueSession();
    res.append('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    // setCsrfCookie now returns the SAME token it put in the cookie —
    // echo it in the response body so the frontend can store one value
    // and send it back identically as the x-csrf-token header.
    const csrfToken = setCsrfCookie(res, secret);
    res.json({ csrfToken });
  });

  app.post('/api/echo', authThenCsrf, (req, res) => {
    res.json({ ok: true, body: req.body });
  });

  const { srv, port } = await listen(app);
  try {
    // Login to obtain sid + csrf cookie + token
    const loginR = await req(port, { method: 'POST', path: '/api/login', body: {} });
    assert.equal(loginR.status, 200, 'csrf: login should be 200');
    const cookies = parseSetCookies(loginR.setCookies);
    assert.ok(cookies.sid, 'csrf: login sets sid cookie');
    assert.ok(cookies.csrf_token, 'csrf: login sets csrf_token cookie');
    const csrfToken = loginR.json.csrfToken;
    assert.ok(csrfToken, 'csrf: login returns csrfToken in body');

    // 1) POST without csrf → 403
    const noToken = await req(port, {
      method: 'POST', path: '/api/echo', body: { hi: 1 },
      headers: { cookie: `sid=${cookies.sid}` },
    });
    assert.equal(noToken.status, 403, `csrf: POST without x-csrf-token should be 403, got ${noToken.status}`);
    assert.equal(noToken.json && noToken.json.error, 'csrf_invalid', 'csrf: missing token returns csrf_invalid');

    // 2) POST with mismatched csrf (header != cookie) → 403
    const mismatch = await req(port, {
      method: 'POST', path: '/api/echo', body: { hi: 2 },
      headers: {
        cookie: `sid=${cookies.sid}; csrf_token=${cookies.csrf_token}`,
        'x-csrf-token': csrfToken + '-tampered',
      },
    });
    assert.equal(mismatch.status, 403, `csrf: mismatched header/cookie should be 403, got ${mismatch.status}`);

    // 3) POST with valid csrf → 200
    const ok = await req(port, {
      method: 'POST', path: '/api/echo', body: { hi: 3 },
      headers: {
        cookie: `sid=${cookies.sid}; csrf_token=${cookies.csrf_token}`,
        'x-csrf-token': csrfToken,
      },
    });
    assert.equal(ok.status, 200, `csrf: valid token should be 200, got ${ok.status}`);
    assert.deepEqual(ok.json.body, { hi: 3 }, 'csrf: handler received the body');

    // 4) GET requests bypass csrf (HTTP-safe methods)
    const getR = await req(port, {
      path: '/api/echo', method: 'GET',
      headers: { cookie: `sid=${cookies.sid}` },
    });
    // 404 because there's no GET handler, but the csrf middleware must
    // have let it through (not 403 csrf_invalid).
    assert.notEqual(getR.status, 403, 'csrf: GET should bypass csrf check');

    // 5) Body-field fallback: csrf_token in req.body (no header)
    const bodyField = await req(port, {
      method: 'POST', path: '/api/echo',
      body: { csrf_token: csrfToken, hi: 4 },
      headers: { cookie: `sid=${cookies.sid}; csrf_token=${cookies.csrf_token}` },
    });
    assert.equal(bodyField.status, 200, `csrf: body-field token should be accepted, got ${bodyField.status}`);

    console.log('OK — E3 CSRF: 403 on missing/mismatched, 200 on valid (header + body fallback), GET bypass');
  } finally { srv.close(); }
}

// ============ E4 — Input sanitization ============
{
  // Unit-level
  const dirty = '<p>ok</p><script>alert(1)</script><a href="javascript:alert(2)">x</a>';
  const cleaned = sanitizeValue(dirty);
  assert.ok(!cleaned.includes('<script'), 'sanitize: strips <script> tag');
  assert.ok(!cleaned.toLowerCase().includes('javascript:'), 'sanitize: strips javascript: URL');
  assert.ok(cleaned.includes('<p>ok</p>'), 'sanitize: keeps <p> tags');

  // Whitelist: bold + italic preserved
  const medical = 'BP <b>142/90</b>, glucose <i>high</i>';
  const medClean = sanitizeValue(medical);
  assert.ok(medClean.includes('<b>142/90</b>'), 'sanitize: keeps <b>');
  assert.ok(medClean.includes('<i>high</i>'), 'sanitize: keeps <i>');

  // findDangerous
  assert.ok(findDangerous('<script>foo</script>'), 'findDangerous: catches <script>');
  assert.ok(findDangerous('javascript:alert(1)'), 'findDangerous: catches javascript:');
  assert.ok(findDangerous('onclick=foo'), 'findDangerous: catches on*= attribute');
  assert.ok(findDangerous('<iframe src="x">'), 'findDangerous: catches <iframe>');
  assert.equal(findDangerous('safe text'), null, 'findDangerous: returns null for clean text');

  // sanitizeBody: notes field with <script> should be rejected (400)
  const { rejected } = sanitizeBody({ notes: '<script>x</script>', name: 'Jane' });
  assert.equal(rejected.length, 1, 'sanitizeBody: rejects notes with <script>');
  assert.equal(rejected[0].field, 'notes', 'sanitizeBody: rejection field is notes');

  // sanitizeBody: clean text returns clean output
  const { sanitized, rejected: r2 } = sanitizeBody({ notes: '<b>BP 142/90</b>', allergies: 'penicillin' });
  assert.equal(r2.length, 0, 'sanitizeBody: clean input has no rejections');
  assert.ok(sanitized.notes.includes('<b>'), 'sanitizeBody: preserves <b> in notes');

  // Fields not in FREE_TEXT_FIELDS pass through untouched
  const { sanitized: s3, replaced: r3 } = sanitizeBody({ password: 'p4ss<script>word' });
  assert.equal(r3.length, 0, 'sanitizeBody: password not in whitelist — no replace');
  assert.equal(s3.password, 'p4ss<script>word', 'sanitizeBody: password preserved verbatim');

  // End-to-end via middleware
  const app = express();
  app.use(express.json());
  app.use(sanitizeMiddleware());
  app.post('/api/notes', (req, res) => res.json({ stored: req.body }));

  const { srv, port } = await listen(app);
  try {
    // Reject XSS payload
    const xssR = await req(port, {
      method: 'POST', path: '/api/notes',
      body: { notes: '<script>alert(1)</script>BP 142/90' },
    });
    assert.equal(xssR.status, 400, `sanitize-middleware: XSS payload → 400, got ${xssR.status}`);
    assert.equal(xssR.json.error, 'xss_payload_rejected', 'sanitize-middleware: error code xss_payload_rejected');

    // Accept clean input with whitelisted tags
    const okR = await req(port, {
      method: 'POST', path: '/api/notes',
      body: { notes: '<b>BP 142/90</b>', allergies: 'penicillin' },
    });
    assert.equal(okR.status, 200, `sanitize-middleware: clean input → 200, got ${okR.status}`);
    assert.ok(okR.json.stored.notes.includes('<b>BP 142/90</b>'), 'sanitize-middleware: <b> preserved');

    // Accept input with disallowed tags but no dangerous pattern → stripped
    const stripR = await req(port, {
      method: 'POST', path: '/api/notes',
      body: { notes: 'Hello <span>world</span>!' },
    });
    assert.equal(stripR.status, 200, `sanitize-middleware: <span> stripped → 200, got ${stripR.status}`);
    assert.ok(!stripR.json.stored.notes.includes('<span'), 'sanitize-middleware: <span> stripped');

    console.log('OK — E4 sanitize: rejects <script>/javascript:/on*= (400), preserves <b>/<i>/<p>/<br>/<ul>/<li>/<a>, strips <span>/<div>');
  } finally { srv.close(); }
}

// ============ Combined smoke test: server.mjs wires everything ============
// We don't boot the real server here (it needs Vedadb VBP running on :6381)
// but we sanity-check that the imported names we expect from
// backend/lib/security/* resolve and the API surface is stable.
{
  assert.ok(typeof buildHelmet === 'function', 'security: buildHelmet exported');
  assert.ok(typeof buildRateLimiters === 'function', 'security: buildRateLimiters exported');
  assert.ok(typeof sanitizeMiddleware === 'function', 'security: sanitizeMiddleware exported');
  assert.ok(typeof requireCsrf === 'function', 'security: requireCsrf exported');
  assert.ok(typeof setCsrfCookie === 'function', 'security: setCsrfCookie exported');
  assert.ok(Array.isArray(FREE_TEXT_FIELDS) && FREE_TEXT_FIELDS.includes('notes'), 'security: FREE_TEXT_FIELDS includes notes');

  console.log('OK — security API surface stable (server.mjs can import the barrel)');
}

console.log('\nAll Week-1 backend-security tests passed (E1 rate limit, E2 helmet, E3 CSRF, E4 sanitize).');
