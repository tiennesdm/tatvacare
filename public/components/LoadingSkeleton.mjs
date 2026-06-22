// TatvaCare — LoadingSkeleton component (Week-1 frontend polish)
//
// Reusable loading-skeleton for initial-mount fetch. Renders shimmer rows
// in list / card / table-row variants. Use while data is in-flight so the
// user sees structure rather than a blank card.
//
//   LoadingSkeleton({
//     variant: 'list',     // 'list' | 'card' | 'table-row' | 'kpi'
//     count: 5,            // number of rows
//     height: 14,          // px (overridden per variant)
//     ariaLabel: 'Loading patients', // a11y label
//   })

const VARIANT_DEFAULTS = {
  list:       { count: 5, height: 14, gap: 10 },
  card:       { count: 1, height: 120, gap: 0 },
  'table-row':{ count: 5, height: 18, gap: 8 },
  kpi:        { count: 4, height: 28, gap: 16 },
};

// Render a loading skeleton block. Returns an HTML string.
export function LoadingSkeleton({ variant = 'list', count, height, ariaLabel = 'Loading…' } = {}) {
  const cfg = VARIANT_DEFAULTS[variant] || VARIANT_DEFAULTS.list;
  const n = Math.max(1, Number(count) || cfg.count);
  const h = Number(height) || cfg.height;

  let rows = '';
  if (variant === 'list') {
    rows = Array.from({ length: n }).map((_, i) => `
      <div class="skeleton-row" style="height:${h}px;width:${i % 2 === 0 ? '90%' : '70%'};margin-bottom:${cfg.gap}px"></div>
    `).join('');
  } else if (variant === 'card') {
    rows = Array.from({ length: n }).map(() => `
      <div class="skeleton skeleton-card" style="height:${h}px"></div>
    `).join('');
  } else if (variant === 'table-row') {
    rows = Array.from({ length: n }).map(() => `
      <div class="skeleton skeleton-row" style="height:${h}px;margin-bottom:${cfg.gap}px"></div>
    `).join('');
  } else if (variant === 'kpi') {
    rows = Array.from({ length: n }).map(() => `
      <div class="skeleton skeleton-kpi" style="height:${h}px"></div>
    `).join('');
  }

  return `<div class="loading-skeleton" role="status" aria-label="${escapeAttr(ariaLabel)}" aria-busy="true">${rows}</div>`;
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}