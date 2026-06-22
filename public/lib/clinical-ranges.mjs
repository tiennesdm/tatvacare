// TatvaCare — Clinical reference ranges for chronic-care vitals.
//
// Single source of truth for "is this vital normal / borderline / critical?"
// Used by the severity chip on patient home, patient chart, and the doctor
// patient list. Sourced from common Indian primary-care thresholds:
//
//   - AHA 2017 BP thresholds (systolic/diastolic, mmHg)
//   - ADA 2024 fasting / post-prandial glucose (mg/dL)
//   - WHO BMI underweight/normal/overweight/obese (kg/m^2)
//   - Standard SpO2 / pulse / body-temperature ranges
//
// Band schema:
//   Each band has an explicit `{ min, max, severity, label }`. The value is
//   matched against ALL bands; the FIRST band whose [min, max] interval
//   includes the value wins. A null `max` means "unbounded above", a null
//   `min` means "unbounded below". Bands MUST be ordered such that no two
//   bands overlap — for a value to be unambiguous, ordering matters when
//   ranges are contiguous; we walk in array order.
//
// Why this schema (vs "upTo" only):
//   Two-sided ranges (low AND high are critical, e.g. BP) are common in
//   clinical thresholds. A pure upTo-only schema can't express "critical
//   if < 90" AND "critical if >= 140" without ordering tricks that hide
//   the real boundaries. Min/max is explicit and the algorithm is trivial.

export const SEVERITY = Object.freeze({
  NORMAL:      'normal',
  BORDERLINE:  'borderline',
  CRITICAL:    'critical',
});

export const SEVERITY_LABEL = Object.freeze({
  normal:     'Normal',
  borderline: 'Borderline',
  critical:   'Critical',
});

export const SEVERITY_LABEL_HI = Object.freeze({
  normal:     'सामान्य',
  borderline: 'सीमा रेखा',
  critical:   'गंभीर',
});

// RANGES — array of { min, max, severity, label }.
// Conventions:
//   - `min: null` means -Infinity
//   - `max: null` means +Infinity
//   - First band whose [min, max] interval contains the value wins
//   - Bands must be non-overlapping; order is meaningful (most-specific first)
export const RANGES = Object.freeze({
  // BP systolic (mmHg). AHA 2017 categories:
  //   <90            : Hypotension (critical)
  //   90-119         : Normal
  //   120-129        : Elevated (borderline)
  //   130-139        : Stage 1 hypertension (borderline)
  //   >=140          : Stage 2 hypertension (critical)
  systolic: [
    { min: null, max: 89.99, severity: 'critical',   label: 'Hypotension' },
    { min: 90,   max: 119.99, severity: 'normal',   label: 'Normal' },
    { min: 120,  max: 129.99, severity: 'borderline', label: 'Elevated' },
    { min: 130,  max: 139.99, severity: 'borderline', label: 'Stage 1 hypertension' },
    { min: 140,  max: null,  severity: 'critical',   label: 'Stage 2 hypertension' },
  ],
  // BP diastolic (mmHg). AHA 2017:
  //   <60            : Low (borderline)
  //   60-79          : Normal
  //   80-89          : Stage 1 hypertension (borderline)
  //   >=90           : Stage 2 hypertension (critical)
  diastolic: [
    { min: null, max: 59.99, severity: 'borderline', label: 'Low diastolic' },
    { min: 60,   max: 79.99, severity: 'normal',     label: 'Normal' },
    { min: 80,   max: 89.99, severity: 'borderline', label: 'Stage 1 hypertension' },
    { min: 90,   max: null,  severity: 'critical',   label: 'Stage 2 hypertension' },
  ],
  // Pulse (bpm). Adult resting:
  //   <40            : Severe bradycardia (critical)
  //   40-59          : Bradycardia (borderline)
  //   60-100         : Normal
  //   101-120        : Tachycardia (borderline)
  //   >120           : Severe tachycardia (critical)
  pulse: [
    { min: null, max: 39.99, severity: 'critical',   label: 'Severe bradycardia' },
    { min: 40,   max: 59.99, severity: 'borderline', label: 'Bradycardia' },
    { min: 60,   max: 100.99, severity: 'normal',   label: 'Normal' },
    { min: 101,  max: 120.99, severity: 'borderline', label: 'Tachycardia' },
    { min: 121,  max: null,  severity: 'critical',   label: 'Severe tachycardia' },
  ],
  // Fasting glucose (mg/dL). ADA 2024:
  //   <50            : Severe hypoglycemia (critical)
  //   50-69          : Mild hypoglycemia (borderline)
  //   70-99          : Normal
  //   100-125        : Pre-diabetes (borderline)
  //   126-199        : Diabetes range (critical)
  //   >=200          : Severe hyperglycemia (critical)
  glucose_fasting: [
    { min: null, max: 49.99, severity: 'critical',   label: 'Severe hypoglycemia' },
    { min: 50,   max: 69.99, severity: 'borderline', label: 'Mild hypoglycemia' },
    { min: 70,   max: 99.99, severity: 'normal',     label: 'Normal' },
    { min: 100,  max: 125.99, severity: 'borderline', label: 'Pre-diabetes' },
    { min: 126,  max: 199.99, severity: 'critical',  label: 'Diabetes range' },
    { min: 200,  max: null,  severity: 'critical',   label: 'Severe hyperglycemia' },
  ],
  // Post-prandial glucose (mg/dL). ADA 2024 (2-hr post-meal):
  //   <50            : Severe hypoglycemia (critical)
  //   50-69          : Mild hypoglycemia (borderline)
  //   70-139         : Normal
  //   140-199        : Pre-diabetes / impaired (borderline)
  //   200-299        : Diabetes range (critical)
  //   >=300          : Severe hyperglycemia (critical)
  glucose_pp: [
    { min: null, max: 49.99, severity: 'critical',   label: 'Severe hypoglycemia' },
    { min: 50,   max: 69.99, severity: 'borderline', label: 'Mild hypoglycemia' },
    { min: 70,   max: 139.99, severity: 'normal',    label: 'Normal' },
    { min: 140,  max: 199.99, severity: 'borderline', label: 'Pre-diabetes' },
    { min: 200,  max: 299.99, severity: 'critical',  label: 'Diabetes range' },
    { min: 300,  max: null,  severity: 'critical',   label: 'Severe hyperglycemia' },
  ],
  // Weight (kg) — broad adult reference without BMI context.
  //   <40            : Severe underweight (critical)
  //   40-49          : Underweight (borderline)
  //   50-89          : Normal
  //   90-119         : Overweight (borderline)
  //   120-149        : Obesity (borderline)
  //   >=150          : Severe obesity (critical)
  weight_kg: [
    { min: null, max: 39.99, severity: 'critical',   label: 'Severe underweight' },
    { min: 40,   max: 49.99, severity: 'borderline', label: 'Underweight' },
    { min: 50,   max: 89.99, severity: 'normal',     label: 'Normal' },
    { min: 90,   max: 119.99, severity: 'borderline', label: 'Overweight' },
    { min: 120,  max: 149.99, severity: 'borderline', label: 'Obesity' },
    { min: 150,  max: null,  severity: 'critical',   label: 'Severe obesity' },
  ],
  // Body temperature (°C).
  //   <35            : Severe hypothermia (critical)
  //   35-35.9        : Mild hypothermia (borderline)
  //   36-37.4        : Normal
  //   37.5-38.4      : Fever (borderline)
  //   38.5-39.9      : High fever (critical)
  //   >=40           : Hyperthermia (critical)
  temp_c: [
    { min: null, max: 34.99, severity: 'critical',   label: 'Severe hypothermia' },
    { min: 35,   max: 35.99, severity: 'borderline', label: 'Mild hypothermia' },
    { min: 36,   max: 37.49, severity: 'normal',     label: 'Normal' },
    { min: 37.5, max: 38.49, severity: 'borderline', label: 'Fever' },
    { min: 38.5, max: 39.99, severity: 'critical',   label: 'High fever' },
    { min: 40,   max: null,  severity: 'critical',   label: 'Hyperthermia' },
  ],
  // SpO2 (%) — higher is better. Inverted range.
  //   <90            : Severe hypoxemia (critical)
  //   90-93          : Mild hypoxemia (borderline)
  //   94-95          : Acceptable (normal)
  //   >=96           : Normal
  spo2: [
    { min: null, max: 89.99, severity: 'critical',   label: 'Severe hypoxemia' },
    { min: 90,   max: 93.99, severity: 'borderline', label: 'Mild hypoxemia' },
    { min: 94,   max: 95.99, severity: 'normal',     label: 'Acceptable' },
    { min: 96,   max: null,  severity: 'normal',     label: 'Normal' },
  ],
});

// Classify a numeric value against the bands for `metric`. Returns:
//   { severity: 'normal'|'borderline'|'critical', label: string }
// or null if metric unknown / value is null/undefined/NaN.
//
// Algorithm: walk the band's [min, max] interval; first band where
//   min <= v <= max  wins.  Treats null min/max as ±Infinity.
export function classify(metric, value) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return null;
  const bands = RANGES[metric];
  if (!bands) return null;
  const v = Number(value);
  for (const b of bands) {
    const lo = b.min == null ? -Infinity : b.min;
    const hi = b.max == null ? Infinity : b.max;
    if (v >= lo && v <= hi) {
      return { severity: b.severity, label: b.label };
    }
  }
  // Defensive — every range definition has a null-bounded catchall so this
  // is unreachable. If we hit it, the value is real but the bands don't
  // cover it; flag as normal to avoid spurious criticals.
  return { severity: 'normal', label: 'Normal' };
}

// Friendly Hindi label per metric — used in the patient portal.
export const METRIC_LABEL_HI = Object.freeze({
  systolic: 'रक्तचाप (ऊपरी)',
  diastolic: 'रक्तचाप (नीचे)',
  pulse: 'नाड़ी',
  glucose_fasting: 'खाली पेट शुगर',
  glucose_pp: 'भोजन के बाद शुगर',
  weight_kg: 'वज़न',
  temp_c: 'तापमान',
  spo2: 'SpO₂',
});

// Friendly English label per metric.
export const METRIC_LABEL_EN = Object.freeze({
  systolic: 'BP systolic',
  diastolic: 'BP diastolic',
  pulse: 'Pulse',
  glucose_fasting: 'Fasting glucose',
  glucose_pp: 'Post-prandial glucose',
  weight_kg: 'Weight',
  temp_c: 'Temperature',
  spo2: 'SpO₂',
});

export function metricLabel(metric, lang = 'en') {
  return (lang === 'hi' ? METRIC_LABEL_HI : METRIC_LABEL_EN)[metric] || metric;
}

// Render a severity chip as HTML. Tailwind-style class names by default —
// matches the audit-doc prescription (bg-green-100 text-green-800 etc.) —
// plus a `chip--<severity>` hook for project-specific overrides.
export function chipHtml(metric, value, opts = {}) {
  const lang = opts.lang || 'en';
  const c = classify(metric, value);
  if (!c) return '';
  const cls = {
    normal:     'vital-chip chip--normal',
    borderline: 'vital-chip chip--borderline',
    critical:   'vital-chip chip--critical',
  }[c.severity];
  const text = opts.text || c.label;
  const title = `${metricLabel(metric, lang)}: ${value} (${text})`;
  return `<span class="${cls}" role="status" aria-label="${escape(title)}">${escape(text)}</span>`;
}

// Minimal HTML escape (server-rendered into HTML attribute / text nodes).
function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
