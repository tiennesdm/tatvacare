// TatvaCare — public components barrel (Week-1 frontend polish)
//
// Single import path so HTML pages can `<script type="module">` this and
// pull in the EmptyState / ErrorState / LoadingSkeleton + clinical-ranges
// helpers without four separate <script> tags.
//
// Usage from an HTML page:
//
//   <script type="module">
//     import { EmptyState, ErrorState, LoadingSkeleton, classify, chipHtml } from '/static/components/index.mjs';
//     document.getElementById('list').innerHTML = EmptyState({ icon: 'vitals', title: 'No readings' });
//   </script>

export { EmptyState }        from './EmptyState.mjs';
export { ErrorState }        from './ErrorState.mjs';
export { LoadingSkeleton }   from './LoadingSkeleton.mjs';
export {
  classify,
  chipHtml,
  metricLabel,
  METRIC_LABEL_EN,
  METRIC_LABEL_HI,
  SEVERITY,
  SEVERITY_LABEL,
  SEVERITY_LABEL_HI,
  RANGES,
} from '../lib/clinical-ranges.mjs';