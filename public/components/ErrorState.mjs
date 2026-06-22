// TatvaCare — ErrorState component (Week-1 frontend polish)
//
// Reusable error-state for failed API calls / 4xx-5xx responses. Renders
// a warning icon + title + message + optional retry CTA. The retry CTA
// can be either a link (actionHref) or an in-page callback (onRetry).

const SVG_NS = 'http://www.w3.org/2000/svg';

function iconSvg() {
  return `<svg xmlns="${SVG_NS}" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
}

// Render an error-state block.
//
//   ErrorState({
//     title: 'Could not load vitals',
//     message: 'Network error. Please retry.',
//     retryLabel: 'Retry',
//     retryHref: '',           // optional
//     onRetry: 'loadVitals()', // optional inline handler
//     variant: 'block',        // 'block' | 'inline' (compact for table rows)
//   })
export function ErrorState({ title = 'Something went wrong', message = '', retryLabel = 'Retry', retryHref = '', onRetry = '', variant = 'block' } = {}) {
  const cls = variant === 'inline' ? 'empty error-state error-state--inline' : 'empty error-state';
  const safeTitle = escapeHtml(title);
  const safeMsg   = message ? `<p class="empty-desc">${escapeHtml(message)}</p>` : '';
  const safeIcon  = iconSvg();
  const retryHtml = (retryHref || onRetry)
    ? (onRetry
        ? `<button type="button" class="btn btn-secondary error-state-retry" onclick="${escapeAttr(onRetry)}">${escapeHtml(retryLabel)}</button>`
        : `<a class="btn btn-secondary error-state-retry" href="${escapeAttr(retryHref || '#')}">${escapeHtml(retryLabel)}</a>`)
    : '';
  return `
    <div class="${cls}" role="alert">
      <div class="empty-icon empty-icon--danger">${safeIcon}</div>
      <div class="empty-title">${safeTitle}</div>
      ${safeMsg}
      ${retryHtml}
    </div>
  `;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s); }