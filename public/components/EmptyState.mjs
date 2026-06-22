// TatvaCare — EmptyState component (Week-1 frontend polish)
//
// Reusable empty-state for list / detail pages. Renders an icon + title +
// description + optional primary CTA. Used by patients.html (no patients),
// log-vitals.html (no readings), prescriptions tab (no Rx), etc.
//
// Reference: docs/UI_DESIGN_AUDIT.md Finding 4 (no state design).

const SVG_NS = 'http://www.w3.org/2000/svg';

// Minimal inline-SVG icons — kept here so we don't depend on lucide-react
// (project is vanilla HTML/JS, not React). All icons use currentColor so
// the CSS severity class can colour them.
const ICON_PATHS = {
  users:        '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  vitals:       '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  pill:         '<path d="M10.5 20.5L20.5 10.5a4.95 4.95 0 1 0-7-7L3.5 13.5a4.95 4.95 0 1 0 7 7Z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/>',
  notes:        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  inbox:        '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  search:       '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  calendar:     '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y1="10"/>',
  alert:        '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  inboxOpen:    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  default:      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
};

function iconSvg(name) {
  const path = ICON_PATHS[name] || ICON_PATHS.default;
  return `<svg xmlns="${SVG_NS}" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

// Render an empty-state block.
//
//   EmptyState({
//     icon: 'vitals',
//     title: 'No readings yet',
//     description: 'Log your first BP / glucose reading to see trends here.',
//     actionLabel: 'Log vitals now',
//     actionHref: '/patient/log-vitals',
//     lang: 'en',   // optional — when 'hi', marks the wrapper with dir/lang
//   })
//
// Returns an HTML string. Drop it into a card or section.
export function EmptyState({ icon = 'default', title, description = '', actionLabel = '', actionHref = '', actionOnclick = '' } = {}) {
  if (!title) throw new Error('EmptyState: title is required');
  const safeTitle = escapeHtml(title);
  const safeDesc  = description ? `<p class="empty-desc">${escapeHtml(description)}</p>` : '';
  const safeIcon  = iconSvg(icon);
  const actionHtml = actionLabel
    ? (actionOnclick
        ? `<button type="button" class="btn empty-action" onclick="${escapeAttr(actionOnclick)}">${escapeHtml(actionLabel)}</button>`
        : `<a class="btn empty-action" href="${escapeAttr(actionHref || '#')}">${escapeHtml(actionLabel)}</a>`)
    : '';
  return `
    <div class="empty empty-state" role="status" aria-live="polite">
      <div class="empty-icon">${safeIcon}</div>
      <div class="empty-title">${safeTitle}</div>
      ${safeDesc}
      ${actionHtml}
    </div>
  `;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function escapeAttr(s) {
  // Safe to inject into an attribute — same charset as text escape.
  return escapeHtml(s);
}