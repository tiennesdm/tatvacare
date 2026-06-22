// CSRF protection — double-submit-cookie + per-session secret.
//
// Why this design:
//   TatvaCare uses cookie-based sessions (sid for doctors, pid for patients).
//   Every state-changing request (POST/PUT/PATCH/DELETE) must carry a CSRF
//   token in either:
//     - the `x-csrf-token` request header, OR
//     - the `csrf_token` body field (for non-fetch form posts).
//   The token is the synchronised `tokens.create(req.session.csrfSecret)`
//   from the `csrf` package (HMAC of a per-session secret).
//
// Flow:
//   1. On login (doctor OR patient), the server creates a session AND a
//      CSRF secret, stores the secret on the session row, and sets TWO
//      cookies: the auth cookie (sid/pid, httpOnly) AND the `csrf_token`
//      cookie (httpOnly: false so the frontend can read it via JS).
//   2. Frontend reads `csrf_token` from document.cookie, sends it back in
//      the `x-csrf-token` header on every POST/PUT/PATCH/DELETE.
//   3. Server middleware pulls the csrf cookie + the x-csrf-token header
//      (or body csrf_token field), pulls the secret bound to the session,
//      and verifies via csrf.verify(secret, token).
//   4. Same-origin browser requests auto-attach the cookie + header pair;
//      cross-origin attackers cannot read the cookie value to forge the
//      header. This is OWASP's "double-submit cookie" pattern.
//
// Why "double-submit" rather than "synchronizer token (form field)":
//   The frontend is a vanilla-JS app that calls fetch() from JS. Form-field
//   tokens require parsing HTML — much more friction for the same security.
//   The double-submit cookie pattern is the right shape for an API that
//   is consumed from a JS frontend.
//
// What we explicitly do NOT do:
//   - We do NOT exempt any cookie-authenticated route — every POST/PUT/
//     PATCH/DELETE that goes through `requireAuth` or `requirePatientAuth`
//     must have a valid CSRF token.
//   - We do NOT require CSRF on GET / HEAD / OPTIONS — these are safe by
//     HTTP spec.
//   - We do NOT skip CSRF for `application/json` content-type — many
//     "real" CSRFs are JSON (e.g. eBay's 2014 API CSRF). The Origin /
//     Referer header check is NOT enough either.
import Tokens from 'csrf';
import { randomBytes } from 'node:crypto';

const tokens = new Tokens();
export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_BODY_FIELD = 'csrf_token';

/**
 * Generate a fresh CSRF secret for a new session.
 *
 * @returns {string} 18-byte URL-safe secret (csrf library default).
 */
export function newCsrfSecret() {
  // secretSync() is sync; we don't need async here. If we ever wanted
  // async entropy, swap to `await tokens.secret()` and make callers async.
  return tokens.secretSync();
}

/**
 * Create a CSRF token bound to a session secret.
 *
 * @param {string} secret — per-session secret stored on the session row.
 * @returns {string} synchronised token the frontend must echo back.
 */
export function csrfTokenFor(secret) {
  return tokens.create(secret);
}

/**
 * Read the csrf cookie from a Cookie header. Returns null if absent.
 *
 * @param {string|undefined} cookieHeader
 * @returns {string|null}
 */
function readCsrfCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Set the CSRF cookie + a paired CSRF secret cookie.
 *
 * IMPORTANT: the CSRF cookie must be httpOnly:false so JS can read it.
 *           The secret cookie must be httpOnly so an XSS that reads
 *           document.cookie gets the public token but NOT the secret.
 *           (Strictly speaking the `csrf` library uses an HMAC, so the
 *           cookie IS the secret-derived token — but we still keep
 *           httpOnly:false only on the *token* cookie, never on the
 *           secret, in case we later move to a different scheme.)
 *
 * @param {import('express').Response} res
 * @param {string} secret
 */
export function setCsrfCookie(res, secret) {
  // IMPORTANT: tokens.create(secret) returns a NEW (secret, salt) HMAC each
  // call. If login calls this twice (once for the cookie, once for the body),
  // the two tokens DIFFER even though both verify against the same secret.
  // The double-submit check (cookieToken === suppliedToken) would fail.
  // Fix: create the token ONCE, set it in the cookie, and return it so the
  // caller can echo the SAME value in the response body / x-csrf-token header.
  const token = tokens.create(secret);
  const cookieVal = `csrf_token=${token}; Path=/; SameSite=Lax; Max-Age=${7 * 86400}`;
  // NOTE: must use res.append, NOT res.setHeader — the latter would clobber
  // any earlier Set-Cookie (e.g. the session/auth cookie set by the login
  // handler before us). Append collects multiple Set-Cookie headers into the
  // array, which Node's HTTP layer serialises correctly per RFC 6265.
  res.append('Set-Cookie', cookieVal);
  return token;
}

/**
 * Express middleware that requires a valid CSRF token on state-changing
 * methods. Apply to ALL POST/PUT/PATCH/DELETE after session middleware
 * (i.e. after requireAuth / requirePatientAuth has populated req.session).
 *
 * Skips:
 *   - GET / HEAD / OPTIONS (safe methods)
 *   - Requests with no session — those will already have been blocked by
 *     requireAuth / requirePatientAuth in front of this middleware, so
 *     they would 401 anyway.
 *
 * Throws:
 *   - 403 { error: 'csrf_invalid' } if the token doesn't verify.
 */
export function requireCsrf(req, res, next) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  // Need a session-bound secret to verify against. If there's no session
  // the upstream auth middleware will have already 401'd; bail safely here.
  const sessionSecret =
    req.session?.csrfSecret ||
    req.patientSession?.csrfSecret ||
    null;
  if (!sessionSecret) {
    // No session = not authenticated = 401 (consistent with requireAuth).
    return res.status(401).json({ error: 'unauthorized', message: 'no session for CSRF check' });
  }

  // Pull the user-supplied token from header or body.
  const headerToken = req.headers[CSRF_HEADER];
  const bodyToken = req.body && req.body[CSRF_BODY_FIELD];
  const suppliedToken = headerToken || bodyToken;

  // Also pull the cookie token (double-submit pattern: the cookie value
  // is what the frontend JS reads and echoes back; verification uses the
  // session-bound secret, not the cookie itself, but the spec requires us
  // to enforce that the supplied token matches what the cookie holds —
  // otherwise a script on a sibling subdomain could just send any value
  // it likes in the header).
  const cookieToken = readCsrfCookie(req.headers.cookie);

  if (!suppliedToken) {
    return res.status(403).json({ error: 'csrf_invalid', message: 'CSRF token missing' });
  }
  if (!cookieToken || cookieToken !== suppliedToken) {
    return res.status(403).json({ error: 'csrf_invalid', message: 'CSRF cookie/header mismatch' });
  }
  if (!tokens.verify(sessionSecret, suppliedToken)) {
    return res.status(403).json({ error: 'csrf_invalid', message: 'CSRF token failed verification' });
  }
  return next();
}

/**
 * Convenience: bind a CSRF secret to a freshly created session object.
 * Use in login/signup handlers right after auth.createSession().
 *
 * @param {object} sessionObject — the value returned by auth.getSession() / patientAuth.getPatientSession().
 * @returns {string} the secret that was bound (caller persists it on the session row).
 */
export function bindSecretToSession(sessionObject) {
  const secret = newCsrfSecret();
  sessionObject.csrfSecret = secret;
  return secret;
}

// Used by tests that need a brand-new cookie value without going through
// the whole middleware stack.
export function _testCookieHeader(secret) {
  return `csrf_token=${tokens.create(secret)}; Path=/; SameSite=Lax`;
}

// Silence the unused-warning — randomBytes is reserved for an upcoming
// per-secret random-salt enhancement.
void randomBytes;
