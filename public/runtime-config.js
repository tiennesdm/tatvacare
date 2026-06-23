# Frontend runtime config — injected as a global before any other script.
#
# Why a separate file (not inlined in every HTML page):
#   - Single source of truth for the API base URL. In dev we hit
#     http://127.0.0.1:3000, in staging https://api.staging.tatvacare.in,
#     in prod https://api.tatvacare.in. The HTML pages don't change.
#   - window.__TC_CONFIG__ is read by public/app.js (TatvaCare.apiBase)
#     and by the service worker for cache key scoping.
#   - Set via reverse-proxy / CDN edge function in prod. For local dev,
#     the defaults below work out of the box.
#
# Hardening:
#   - apiBase MUST be same-origin (relative) in prod so the auth cookie
#     behaves correctly. Cross-origin requires CORS + explicit credentials
#     handling — out of scope for v4.
#   - If you must set apiBase to a different origin, also set
#     COOKIE_DOMAIN and ensure the backend sends
#     Access-Control-Allow-Credentials: true + a specific origin (not *).
(function () {
  'use strict';
  // Allow override via window.__TC_CONFIG__ (e.g. set by edge function).
  const existing = window.__TC_CONFIG__;
  if (existing && typeof existing === 'object') {
    // Validate keys we care about; fall through to defaults if missing.
    window.__TC_CONFIG__ = Object.assign({
      apiBase: '/api',
      enableSW: true,
      buildId: 'dev',
      env: 'development',
    }, existing);
    return;
  }
  // Default — same-origin /api. Works for local dev (port 3000) AND prod
  // when the backend is reverse-proxied at /api by the same host as the SPA.
  window.__TC_CONFIG__ = {
    apiBase: '/api',
    enableSW: true,
    buildId: 'dev',
    env: 'development',
  };
})();
