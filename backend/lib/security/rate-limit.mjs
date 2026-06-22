// Rate limiting — per-route-class limits.
//
// Why per-route-class:
//   - Auth endpoints are the highest-value target: a credential-stuffing bot
//     hammering /api/auth/login should be locked out fast and tight. A single
//     IP gets 5 attempts per 15 minutes — well below "user mistyped password
//     a few times" volume but well below "I can brute force this over lunch".
//   - AI endpoints are expensive (Python FastAPI on :7100 doing OCR / DL /
//     LLM). 30/min/IP is generous for normal use (a clinician would not run
//     30 ECG classifications in 60 seconds) but throttles runaway loops.
//   - Vitals writes are the closest thing to a chronic-care hot path —
//     patient logs BP / glucose / weight from their phone via the portal.
//     60/min/IP allows bursty bulk-log (8 metrics in one POST) + retries but
//     caps abuse.
//   - Default covers everything else (read endpoints, static, health).
//
// Why in-memory and where Redis would go:
//   For a single-process Node server (current deployment), the default
//   MemoryStore from express-rate-limit is fine — it gives one Map per
//   limiter and the process is the single source of truth. When we move
//   to multi-process (PM2 cluster) or multi-host, swap to
//   `rate-limit-redis` and pass `store: new RedisStore({ sendCommand: ... })`
//   to each rateLimit() call. The wiring lives entirely in this file — the
//   server.mjs imports `buildRateLimiters()` and applies them per-route-class
//   so the swap is a one-file change.
import rateLimit from 'express-rate-limit';

function reject(_req, res, _next, options) {
  // Per spec: 429 with { error: "rate_limited", retryAfter: <seconds> }
  const retryAfter = Math.ceil(options.windowMs / 1000);
  res.status(options.statusCode).json({
    error: 'rate_limited',
    retryAfter,
    message: 'Too many requests, slow down.',
  });
}

/**
 * Build the per-route-class rate limiters.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.testMode=false] — when true, uses tiny windows so
 *   tests can hit limits fast without waiting 15 minutes. Default false.
 * @returns {{
 *   auth: import('express').RequestHandler,
 *   ai: import('express').RequestHandler,
 *   vitalsWrite: import('express').RequestHandler,
 *   default: import('express').RequestHandler,
 * }}
 */
export function buildRateLimiters(opts = {}) {
  const { testMode = false } = opts;

  // Defaults match the spec.
  const authWindowMs  = testMode ? 1_000     : 15 * 60_000;  // 15 min
  const authMax       = testMode ? 5         : 5;
  const aiWindowMs    = testMode ? 1_000     : 60_000;        // 1 min
  const aiMax         = testMode ? 5         : 30;
  const vitalsWindowMs= testMode ? 1_000     : 60_000;
  const vitalsMax     = testMode ? 10        : 60;
  const defWindowMs   = testMode ? 1_000     : 60_000;
  const defMax        = testMode ? 10        : 120;

  const common = {
    standardHeaders: 'draft-7',  // RateLimit headers per IETF draft
    legacyHeaders: false,        // Disable X-RateLimit-* legacy
    handler: reject,
  };

  return {
    auth: rateLimit({
      windowMs: authWindowMs,
      max: authMax,
      message: { error: 'rate_limited', retryAfter: Math.ceil(authWindowMs / 1000) },
      ...common,
    }),
    ai: rateLimit({
      windowMs: aiWindowMs,
      max: aiMax,
      message: { error: 'rate_limited', retryAfter: Math.ceil(aiWindowMs / 1000) },
      ...common,
    }),
    vitalsWrite: rateLimit({
      windowMs: vitalsWindowMs,
      max: vitalsMax,
      message: { error: 'rate_limited', retryAfter: Math.ceil(vitalsWindowMs / 1000) },
      ...common,
    }),
    default: rateLimit({
      windowMs: defWindowMs,
      max: defMax,
      message: { error: 'rate_limited', retryAfter: Math.ceil(defWindowMs / 1000) },
      ...common,
    }),
  };
}
