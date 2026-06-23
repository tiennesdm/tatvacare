// Service Worker update-prompt glue.
//
// Loaded by app.js in production builds. Listens for the SW's
// `controllerchange` event (fired when a new SW takes over) and shows
// a one-time toast asking the user to reload.
//
// Why a manual reload prompt instead of auto-reload:
//   - Auto-reload during a clinical task (filling a refill form, mid-Rx
//     draft) loses user input and breaks the trust contract.
//   - The toast offers "Reload" (full refresh with new SW active) and
//     "Later" (continue with the current SW; reload on next nav).
//
// Sends `SKIP_WAITING` to the waiting SW only after the user clicks
// Reload, so the swap happens in a moment we control.

(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  if (window.__TC_CONFIG__ && window.__TC_CONFIG__.enableSW === false) return;

  // Register. Use relative path so this works behind any reverse proxy.
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // If a new SW is already waiting (page load after a deploy), surface
    // the prompt immediately so the user knows there's a new version.
    if (reg.waiting) promptReload(reg);
    // Future installs.
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          // A new SW is installed and there's already an active one —
          // surface the update prompt.
          promptReload(reg);
        }
      });
    });
  }).catch((e) => {
    // Service worker registration failure should never crash the app —
    // the page still works online, just no offline shell.
    console.warn('[TatvaCare] service worker registration failed:', e);
  });

  // Helper: show the update prompt as a toast with action button.
  function promptReload(reg) {
    // Avoid duplicate prompts.
    if (document.getElementById('tc-sw-update-toast')) return;
    const toast = document.createElement('div');
    toast.id = 'tc-sw-update-toast';
    toast.setAttribute('role', 'status');
    toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:12px 18px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.2);z-index:99999;display:flex;gap:12px;align-items:center;font:14px/1.4 system-ui;';
    toast.innerHTML = '<span>New version available.</span>';
    const btn = document.createElement('button');
    btn.textContent = 'Reload';
    btn.style.cssText = 'background:#22c55e;color:#052e16;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600;';
    btn.onclick = () => {
      // Ask the waiting SW to take over, then reload once it does.
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
    };
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Later';
    dismiss.style.cssText = 'background:transparent;color:#cbd5e1;border:1px solid #475569;padding:6px 12px;border-radius:6px;cursor:pointer;';
    dismiss.onclick = () => toast.remove();
    toast.appendChild(btn);
    toast.appendChild(dismiss);
    document.body.appendChild(toast);
  }

  // Push the current buildId to the SW so it can scope its cache key.
  if (navigator.serviceWorker.controller) {
    const buildId = (window.__TC_CONFIG__ && window.__TC_CONFIG__.buildId) || 'dev';
    navigator.serviceWorker.controller.postMessage({ type: 'SET_BUILD_ID', buildId });
  }
})();
