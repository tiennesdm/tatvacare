// Centralized config — read once at boot, validated, exported as a frozen object.
//
// Why a config module:
//   - Today: 127.0.0.1, 6381, 7100 are hardcoded across server.mjs, main.py,
//     scripts. A typo in one place silently degrades.
//   - Tomorrow (multi-env): dev/staging/prod need different URLs, secrets,
//     pool sizes, breaker thresholds. We want one file to change.
//
// Boot-time validation:
//   - Each required var has a clear type + range. Failures print a clean
//     error and `process.exit(2)` (NOT 1, which historically means "OK
//     but failed test" in some init systems).
//   - Optional vars get sensible defaults documented inline.
//   - We never read process.env inside request handlers — only here.

function reqStr(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    process.stderr.write(`[config] FATAL: required env var ${name} is missing\n`);
    process.exit(2);
  }
  return v.trim();
}

function optStr(name, dflt) {
  const v = process.env[name];
  return (v && v.trim()) ? v.trim() : dflt;
}

function optInt(name, dflt, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    process.stderr.write(`[config] FATAL: ${name} must be int in [${min}, ${max}], got ${raw}\n`);
    process.exit(2);
  }
  return n;
}

function optBool(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  return /^(1|true|yes|on)$/i.test(raw);
}

const NODE_ENV = optStr('NODE_ENV', 'development');

// === HTTP server ===
const PORT = optInt('PORT', 3000, { min: 1, max: 65535 });
const HOST = optStr('HOST', '127.0.0.1');
const SHUTDOWN_GRACE_MS = optInt('SHUTDOWN_GRACE_MS', 15_000, { min: 1_000, max: 60_000 });

// === Vedadb VBP ===
const VBP_HOST = optStr('VBP_HOST', '127.0.0.1');
const VBP_PORT = optInt('VBP_PORT', 6381, { min: 1, max: 65535 });
const VBP_POOL_MAX = optInt('VBP_POOL_MAX', 12, { min: 1, max: 200 });
const VBP_QUERY_TIMEOUT_MS = optInt('VBP_QUERY_TIMEOUT_MS', 8_000, { min: 100, max: 60_000 });

// === AI service ===
const AI_URL = optStr('AI_URL', 'http://127.0.0.1:7100');
const AI_SERVICE_KEY = optStr('AI_SERVICE_KEY', NODE_ENV === 'production' ? '' : 'dev-only-not-secret');
if (NODE_ENV === 'production' && !AI_SERVICE_KEY) {
  process.stderr.write('[config] FATAL: AI_SERVICE_KEY is required in production\n');
  process.exit(2);
}
const AI_FETCH_TIMEOUT_MS = optInt('AI_FETCH_TIMEOUT_MS', 30_000, { min: 1_000, max: 180_000 });
const AI_BREAKER_THRESHOLD = optInt('AI_BREAKER_THRESHOLD', 5, { min: 1, max: 100 });
const AI_BREAKER_RESET_MS = optInt('AI_BREAKER_RESET_MS', 10_000, { min: 100, max: 600_000 });

// === Rate limiting / CSRF storage ===
const REDIS_URL = optStr('REDIS_URL', '');
const SESSION_COOKIE_SECRET = optStr('SESSION_COOKIE_SECRET', NODE_ENV === 'production' ? '' : 'dev-only-session-secret');
if (NODE_ENV === 'production' && !SESSION_COOKIE_SECRET) {
  process.stderr.write('[config] FATAL: SESSION_COOKIE_SECRET is required in production\n');
  process.exit(2);
}

// === OpenAI / LLM (optional) ===
const OPENAI_API_KEY = optStr('OPENAI_API_KEY', '');
const OPENAI_MODEL = optStr('OPENAI_MODEL', 'gpt-4o-mini');

// === Logging / observability ===
const LOG_LEVEL = optStr('LOG_LEVEL', NODE_ENV === 'production' ? 'info' : 'debug');
const METRICS_ENABLED = optBool('METRICS_ENABLED', true);

// === Feature flags ===
const PHI_ACCESS_LOG_ENABLED = optBool('PHI_ACCESS_LOG_ENABLED', true);

export const config = Object.freeze({
  NODE_ENV,
  PORT, HOST, SHUTDOWN_GRACE_MS,
  VBP_HOST, VBP_PORT, VBP_POOL_MAX, VBP_QUERY_TIMEOUT_MS,
  AI_URL, AI_SERVICE_KEY, AI_FETCH_TIMEOUT_MS, AI_BREAKER_THRESHOLD, AI_BREAKER_RESET_MS,
  REDIS_URL, SESSION_COOKIE_SECRET,
  OPENAI_API_KEY, OPENAI_MODEL,
  LOG_LEVEL, METRICS_ENABLED,
  PHI_ACCESS_LOG_ENABLED,
});

export function logBootBanner() {
  // Banner on stdout so deploy logs catch it. We keep it short and parseable.
  const summary = {
    msg: 'tatvacare_boot',
    env: config.NODE_ENV,
    port: config.PORT,
    host: config.HOST,
    vbp: `${config.VBP_HOST}:${config.VBP_PORT}`,
    vbp_pool_max: config.VBP_POOL_MAX,
    ai_url: config.AI_URL,
    ai_breaker: `${config.AI_BREAKER_THRESHOLD}f/${config.AI_BREAKER_RESET_MS}ms`,
    redis: config.REDIS_URL ? 'enabled' : 'in-memory',
    metrics: config.METRICS_ENABLED,
    phi_access_log: config.PHI_ACCESS_LOG_ENABLED,
    openai: !!config.OPENAI_API_KEY,
  };
  // Plain console.log here — we want it BEFORE the logger module is wired
  // into Express. The logger module itself uses stdout.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', ...summary }));
}
