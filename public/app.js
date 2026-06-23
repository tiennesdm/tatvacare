// TatvaCare v2 — sidebar layout, toasts, modals, autocomplete, tabs
//
// Boot-time: ensure runtime-config.js + sw-update.js are loaded.
// runtime-config.js sets window.__TC_CONFIG__ BEFORE this file runs
// (loaded via <script> tag in every HTML page, OR injected below as a
// fallback). sw-update.js registers the service worker after DOMContentLoaded.
(function ensureDeps() {
  // If runtime-config didn't load (older HTML pages that don't reference it),
  // inline the defaults so the rest of this file can read window.__TC_CONFIG__.
  if (!window.__TC_CONFIG__) {
    window.__TC_CONFIG__ = { apiBase: '/api', enableSW: true, buildId: 'dev', env: 'development' };
  }
  // Lazy-load sw-update.js after DOMContentLoaded so the toast helpers
  // it calls (showToast from this file) are defined. Skip if explicitly
  // disabled by config (e.g. embedded preview windows).
  if (window.__TC_CONFIG__.enableSW !== false) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectSW);
    } else {
      injectSW();
    }
  }
  function injectSW() {
    const s = document.createElement('script');
    s.src = '/static/sw-update.js';
    s.defer = true;
    document.head.appendChild(s);
  }
})();
const SVG = (path) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">${path}</svg>`;
const ICONS = {
  dashboard: SVG('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'),
  patients:  SVG('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  prescribe:  SVG('<path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/><path d="M8 12h8"/><path d="M8 8h8"/><path d="M8 16h6"/>'),
  calendar:  SVG('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  inbox:     SVG('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  drugs:     SVG('<path d="M10.5 20.5L20.5 10.5a4.95 4.95 0 1 0-7-7L3.5 13.5a4.95 4.95 0 1 0 7 7Z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/>'),
  logout:    SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  alert:     SVG('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  user:      SVG('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  search:    SVG('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  plus:      SVG('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  x:         SVG('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  pill:      SVG('<path d="M10.5 20.5L20.5 10.5a4.95 4.95 0 1 0-7-7L3.5 13.5a4.95 4.95 0 1 0 7 7Z"/>'),
  chart:     SVG('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
  heart:     SVG('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>'),
  vitals:    SVG('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  notes:     SVG('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  bell:      SVG('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  settings:  SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  chevron:   SVG('<polyline points="9 18 15 12 9 6"/>'),
  check:     SVG('<polyline points="20 6 9 17 4 12"/>'),
};

// CSRF helper — read a cookie value by name. The backend's
// /api/patient/auth/login (and /api/auth/login) set a non-httpOnly
// `csrf_token` cookie on success; the matching value is also returned in
// the response body and verified against the per-session secret on every
// state-changing request. API.req injects the value into the `x-csrf-token`
// header below so callers can use POST/PUT/PATCH/DELETE without thinking
// about CSRF plumbing.
function getCookie(name) {
  if (!name) return null;
  // document.cookie is `name=value; name2=value2; ...`. Match on the exact
  // name prefix and stop at `;` or end-of-string. Skip leading whitespace.
  const re = new RegExp('(?:^|;\\s*)' + name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '=([^;]*)');
  const m = document.cookie.match(re);
  return m ? decodeURIComponent(m[1]) : null;
}

// One-shot console.warn the first time a state-changing call goes out
// without a csrf_token cookie. Don't spam — subsequent misses stay quiet
// so the console stays useful for real errors.
let _csrfMissingWarned = false;

// `API.req` — fetch wrapper used by every page. Auto-attaches:
//   - `Content-Type: application/json` (unless caller overrides)
//   - `credentials: 'same-origin'` so cookies travel
//   - `x-csrf-token: <csrf_token cookie value>` on non-GET methods, when the
//     cookie is present. Missing cookie on a POST/PUT/PATCH/DELETE logs a
//     one-time warning and proceeds — the backend will 403 csrf_invalid, which
//     is the right signal to the caller.
//   - prepends `window.__TC_CONFIG__.apiBase` (default '/api') to the path
//     so the same HTML works in dev (same origin :3000), staging (api.* subdomain),
//     and prod (path-based reverse proxy). Pass `apiBase: false` in opts to
//     skip the prefix (e.g. for absolute URLs to a CDN).
const API = {
  async req(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrfToken = getCookie('csrf_token');
      if (csrfToken) {
        headers['x-csrf-token'] = csrfToken;
      } else if (!_csrfMissingWarned) {
        _csrfMissingWarned = true;
        console.warn('[TatvaCare] csrf_token cookie missing — state-changing requests will 403. Are you logged in?');
      }
    }
    // Resolve URL. If caller passes an absolute URL (http(s)://...), use it
    // as-is. Otherwise prepend the runtime apiBase so the same page works
    // against any backend origin (dev :3000, prod api.tatvacare.in, etc).
    let url = path;
    if (opts.apiBase !== false && !/^https?:\/\//i.test(path)) {
      const base = (window.__TC_CONFIG__ && window.__TC_CONFIG__.apiBase) || '/api';
      url = base.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
    }
    const r = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
    return data;
  },
  get: (p) => API.req(p),
  post: (p, body) => API.req(p, { method: 'POST', body: JSON.stringify(body) }),
  // Convenience verbs for callers that want to be explicit.
  put: (p, body) => API.req(p, { method: 'PUT', body: JSON.stringify(body) }),
  patch: (p, body) => API.req(p, { method: 'PATCH', body: JSON.stringify(body) }),
  del: (p) => API.req(p, { method: 'DELETE' }),
};

function showToast(message, type = 'success', duration = 3500) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
}

function showModal(title, bodyHtml, footerHtml = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>${title}</h3>
          <button class="icon-btn" data-action="close">${ICONS.x}</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.dataset.action === 'close') {
        overlay.remove();
        resolve(null);
      }
    });
    overlay._modal = overlay.querySelector('.modal');
    overlay._resolve = resolve;
    return overlay;
  });
}

function showSkeleton(target, type = 'text', count = 3) {
  target.innerHTML = Array(count).fill('').map(() => `<div class="skeleton ${type}"></div>`).join('');
}

function fmtDate(d) {
  if (!d || d === 'NULL') return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(d) {
  if (!d || d === 'NULL') return '—';
  return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(d) {
  if (!d) return '';
  return d.toString().slice(0, 5);
}
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function initials(name) { return (name || '?').split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase(); }

// Build sidebar (called from each page)
function renderSidebar(active) {
  return `
    <aside class="sidebar">
      <a href="/dashboard" class="brand">
        <div class="logo">T</div>
        <span>TatvaCare</span>
      </a>
      <div class="nav-section">Workspace</div>
      <a href="/dashboard" class="nav-link ${active === 'dashboard' ? 'active' : ''}">${ICONS.dashboard}<span>Dashboard</span></a>
      <a href="/dashboard/patients" class="nav-link ${active === 'patients' ? 'active' : ''}">${ICONS.patients}<span>Patients</span></a>
      <a href="/dashboard/prescribe" class="nav-link ${active === 'prescribe' ? 'active' : ''}">${ICONS.prescribe}<span>New Rx</span></a>
      <a href="/dashboard/calendar" class="nav-link ${active === 'calendar' ? 'active' : ''}">${ICONS.calendar}<span>Calendar</span></a>
      <div class="nav-section">Clinical</div>
      <a href="/dashboard/inbox" class="nav-link ${active === 'inbox' ? 'active' : ''}" id="nav-inbox">${ICONS.inbox}<span>Inbox</span><span class="badge" id="inbox-count" style="display:none">0</span></a>
      <a href="/dashboard/drugs" class="nav-link ${active === 'drugs' ? 'active' : ''}">${ICONS.drugs}<span>Drug DB</span></a>
      <a href="/dashboard/formulary" class="nav-link ${active === 'formulary' ? 'active' : ''}">${ICONS.drugs}<span>Drug Monographs</span></a>
      <div class="nav-section">Care Ops</div>
      <a href="/dashboard/analytics" class="nav-link ${active === 'analytics' ? 'active' : ''}">${ICONS.dashboard}<span>Analytics</span></a>
      <a href="/dashboard/reminders" class="nav-link ${active === 'reminders' ? 'active' : ''}">${ICONS.inbox}<span>Reminders</span></a>
      <a href="/dashboard/telemedicine" class="nav-link ${active === 'telemedicine' ? 'active' : ''}">📞<span>Tele-health</span></a>
      <a href="/dashboard/audit" class="nav-link ${active === 'audit' ? 'active' : ''}">🔍<span>Audit Log</span></a>
      <div class="nav-section">AI Assistant <span class="ai-badge">βeta</span></div>
      <a href="/ai" class="nav-link ${active === 'ai' ? 'active' : ''}" id="nav-ai">${ICONS.dashboard}<span>AI Hub</span></a>
      <div class="user-card" id="user-card">
        <div class="avatar" id="user-avatar">?</div>
        <div class="info">
          <div class="name" id="user-name">Loading…</div>
          <div class="role">Doctor</div>
        </div>
      </div>
    </aside>
  `;
}

function buildTopbar(crumbs, actions = '') {
  return `
    <div class="topbar">
      <div class="crumbs">${crumbs}</div>
      <div class="actions">
        <span class="vbp-pill"><span class="dot"></span>VBP · 6381</span>
        ${actions}
        <button class="icon-btn" title="Notifications" onclick="window.TatvaCare.showToast('No new notifications', 'info')">${ICONS.bell}</button>
        <button class="icon-btn" onclick="TatvaCare.logout()" title="Logout">${ICONS.logout}</button>
      </div>
    </div>
  `;
}

async function loadMe() {
  try { const { doctor } = await API.get('/api/auth/me'); return doctor; }
  catch { return null; }
}

async function loadInboxCount() {
  try {
    const { tasks } = await API.get('/api/tasks?status=open');
    const el = document.getElementById('inbox-count');
    if (el) {
      if (tasks.length > 0) { el.textContent = tasks.length; el.style.display = 'inline-block'; }
      else el.style.display = 'none';
    }
  } catch {}
}

async function logout() {
  try { await API.post('/api/auth/logout', {}); } catch {}
  window.location.href = '/login';
}

async function initPage(active) {
  const me = await loadMe();
  if (!me) { window.location.href = '/login'; return null; }
  // Auto-inject sidebar if missing
  const app = document.getElementById('app');
  if (app && !app.querySelector('.sidebar')) {
    const main = app.querySelector('main');
    app.innerHTML = renderSidebar(active) + (main ? main.outerHTML : '');
  }
  const avatar = document.getElementById('user-avatar');
  const name = document.getElementById('user-name');
  if (avatar) avatar.textContent = initials(me.full_name);
  if (name) name.textContent = me.full_name;
  loadInboxCount();
  return me;
}

window.TatvaCare = { API, showToast, showModal, showSkeleton, loadMe, loadInboxCount, initPage, logout,
  fmtDate, fmtDateTime, fmtTime, escapeHtml, initials, ICONS, SVG, renderSidebar, buildTopbar,
  getCookie };
