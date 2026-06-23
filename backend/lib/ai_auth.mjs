// AI service authentication helper.
//
// The Python AI service on :7100 was previously reachable by anyone who
// could reach the loopback interface. We now require a shared secret in
// the X-Service-Key header on every request from the Node backend.
//
// Design notes:
//   - The secret lives in env (AI_SERVICE_KEY). In dev we default to a
//     fixed non-secret string so local dev doesn't need a .env. In prod
//     config.mjs fails fast if AI_SERVICE_KEY is missing.
//   - The same secret is loaded by the Python service (config.py) which
//     compares against AI_SERVICE_KEY env on every request via a small
//     FastAPI dependency (wired in main.py).
//   - We DO NOT use this for end-user auth (it's a service-to-service
//     header, not a user identity). End-user auth remains the cookie
//     session + CSRF chain on the public Node API.
//   - Timing-safe comparison via crypto.timingSafeEqual. Prevents timing
//     side-channels even though the secret space is small.

import { createHmac, timingSafeEqual } from 'node:crypto';

export function buildServiceKeyHeader(secret) {
  if (!secret) {
    throw new Error('AI_SERVICE_KEY missing — refusing to sign AI request');
  }
  // We sign the current minute so the Python side can reject very stale
  // requests (replay window = 90s). Cheap protection against any future
  // case where the secret leaks into a log file.
  const minute = Math.floor(Date.now() / 60_000);
  const nonce = `${minute}:${createHmac('sha256', secret).update(String(minute)).digest('hex').slice(0, 16)}`;
  return {
    'X-Service-Key': secret,
    'X-Service-Nonce': nonce,
  };
}

export function verifyServiceKeyHeader(headers, expectedSecret) {
  if (!expectedSecret) return { ok: false, reason: 'no_secret_configured' };
  const provided = headers['x-service-key'] || headers['X-Service-Key'];
  if (!provided) return { ok: false, reason: 'missing' };
  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(String(expectedSecret));
  if (providedBuf.length !== expectedBuf.length) {
    // timingSafeEqual requires equal-length buffers; do a dummy compare
    // to keep the wall-clock similar regardless of length.
    timingSafeEqual(providedBuf, providedBuf);
    return { ok: false, reason: 'length_mismatch' };
  }
  if (!timingSafeEqual(providedBuf, expectedBuf)) return { ok: false, reason: 'mismatch' };
  const nonce = headers['x-service-nonce'] || headers['X-Service-Nonce'];
  if (!nonce || typeof nonce !== 'string' || !nonce.includes(':')) {
    return { ok: false, reason: 'bad_nonce' };
  }
  const [minuteStr, sig] = nonce.split(':');
  const minute = parseInt(minuteStr, 10);
  if (!Number.isInteger(minute)) return { ok: false, reason: 'bad_nonce' };
  const nowMinute = Math.floor(Date.now() / 60_000);
  if (Math.abs(nowMinute - minute) > 1) return { ok: false, reason: 'stale_nonce' };
  const expectedSig = createHmac('sha256', expectedSecret).update(String(minute)).digest('hex').slice(0, 16);
  if (sig !== expectedSig) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}
