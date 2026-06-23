// TatvaCare structured logger.
//
// Goals (zero-dep, JSON line per event to stdout):
//   - Every log line is a single-line JSON object so log shippers (Loki,
//     Datadog, CloudWatch Insights) can ingest without parsers.
//   - request_id is propagated via AsyncLocalStorage so every log line
//     inside a request handler automatically carries the same id. The id
//     is also sent to the client via the `x-request-id` response header
//     so a user-reported error can be traced end-to-end.
//   - Two channels:
//       * logger.*  — application-level (info/warn/error), with optional
//                     structured fields. Goes to stdout.
//       * accessLog — per-request summary (method, path, status, duration,
//                     bytes). Goes to stdout with a `kind: "access"` marker
//                     so a log shipper can route it differently if desired.
//   - Never log raw PHI (patient_id is fine; names/phones/notes are NOT).
//     The `redact()` helper strips common PHI fields before serialisation.
//
// What we explicitly do NOT do:
//   - We do NOT add a log-level env switch yet — log everything at info+;
//     in prod the log shipper can drop debug. Keeps the deploy story simple.
//   - We do NOT use pino/winston/bunyan — adds 1-2 deps for ~80 LOC of work.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// --------- request-id propagation ---------
const als = new AsyncLocalStorage();

export function withRequestContext(ctx, fn) {
  return als.run({ requestId: ctx.requestId || randomUUID(), ...ctx }, fn);
}

export function currentRequestId() {
  return als.getStore()?.requestId;
}

// --------- redactor ---------
// Strips common PHI field names from any object before logging. Walks
// nested objects/arrays up to depth 3 to avoid infinite loops.
const PHI_KEYS = new Set([
  'name', 'full_name', 'first_name', 'last_name',
  'phone', 'phoneOrEmail', 'mobile',
  'email', 'email_address',
  'address', 'street', 'city', 'zip', 'pincode', 'postal_code',
  'aadhaar', 'aadhar', 'abha', 'abha_id',
  'dob', 'date_of_birth', 'birthdate',
  'notes', 'chief_complaint', 'history', 'advice', 'body',
  'password', 'passwd', 'pwd', 'secret', 'token', 'csrf', 'csrf_token',
  'image', 'audio', 'file', 'photo', 'signature',
]);
const REDACTED = '[REDACTED]';

function redact(value, depth = 0) {
  if (depth > 3) return '[depth-truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Coarse PII detection: strings longer than 200 chars that look like
    // free-text (not a UUID/identifier) get truncated. Cheap heuristic;
    // better than nothing.
    if (value.length > 500) return value.slice(0, 200) + '…[truncated]';
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = PHI_KEYS.has(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

// --------- core logger ---------
function emit(level, msg, fields) {
  const ctx = als.getStore() || {};
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    pid: process.pid,
    ...(ctx.requestId ? { request_id: ctx.requestId } : {}),
    ...(ctx.doctorId ? { doctor_id: ctx.doctorId } : {}),
    ...(ctx.patientId ? { patient_id: ctx.patientId } : {}),
    ...(fields ? redact(fields) : {}),
  };
  // Use stdout for info/access; stderr for warn/error so docker logs
  // --stderr-only can grab just errors when triaging.
  const stream = (level === 'warn' || level === 'error') ? process.stderr : process.stdout;
  try {
    stream.write(JSON.stringify(line) + '\n');
  } catch (e) {
    // Last-resort: never let a logger failure take down a request handler.
    stream.write(JSON.stringify({ ts: line.ts, level: 'error', msg: 'logger_serialize_failed', err: e.message }) + '\n');
  }
}

export const logger = {
  info:  (msg, fields) => emit('info',  msg, fields),
  warn:  (msg, fields) => emit('warn',  msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
  child: (extra) => ({
    info:  (msg, fields) => emit('info',  msg, { ...extra, ...fields }),
    warn:  (msg, fields) => emit('warn',  msg, { ...extra, ...fields }),
    error: (msg, fields) => emit('error', msg, { ...extra, ...fields }),
    debug: (msg, fields) => emit('debug', msg, { ...extra, ...fields }),
  }),
  redact,
};

// --------- access log ---------
// Express middleware factory. Adds x-request-id to res (echoes incoming
// or generates new), starts a timer, logs on response 'finish'.
export function accessLogMiddleware() {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const requestId = (typeof incoming === 'string' && incoming.length < 200)
      ? incoming
      : randomUUID();
    res.setHeader('x-request-id', requestId);
    const t0 = process.hrtime.bigint();
    // Run the rest of the request inside the ALS context so logger.* inside
    // any handler picks up the same request_id.
    withRequestContext({ requestId }, () => {
      res.on('finish', () => {
        const durMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
        const length = Number(res.getHeader('content-length') || 0);
        emit('info', 'http_access', {
          kind: 'access',
          method: req.method,
          path: req.originalUrl?.split('?')[0] || req.path,
          status: res.statusCode,
          duration_ms: durMs,
          bytes: length,
          ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().slice(0, 64),
          ua: (req.headers['user-agent'] || '').slice(0, 120),
        });
      });
      next();
    });
  };
}

// --------- Express error catcher ---------
// Catches anything errRes() didn't already swallow (sync throws, missed
// promise rejections). Logs with full request context, returns 500.
export function errorLogMiddleware() {
  return (err, req, res, next) => {
    logger.error('http_unhandled', {
      kind: 'unhandled',
      method: req.method,
      path: req.originalUrl?.split('?')[0] || req.path,
      err: err?.message,
      stack: err?.stack?.split('\n').slice(0, 5).join(' | '),
    });
    if (res.headersSent) return next(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal server error' } });
  };
}
