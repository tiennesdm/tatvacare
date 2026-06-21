// Phase-1 regression tests for the log-vitals "all metrics in one form"
// fix (audit Bug 4).
//
// Why this exists: the patient portal log-vitals page used to render a
// single number input behind a tab switcher, so patients measuring
// BP + glucose + weight in one morning session had to tab-switch and
// submit 3 separate times. Now it's a single form with all 8 metric
// inputs visible, and the POST endpoint accepts a bulk `readings[]`
// array.
//
// These tests assert:
//   1. Static HTML exposes input[name=<metric>] for all 8 metrics.
//   2. Static HTML no longer has the legacy "metric-tab" switcher.
//   3. The server route handler accepts both the legacy single-reading
//      shape { metric, value } AND the new bulk shape { readings: [...] }.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public', 'patient');
const SERVER = join(__dirname, '..', 'backend', 'server.mjs');

const html = readFileSync(join(PUBLIC, 'log-vitals.html'), 'utf-8');
const serverJs = readFileSync(SERVER, 'utf-8');

// All 8 metrics the audit expected + the doc string already promised.
const EXPECTED_METRICS = [
  'systolic', 'diastolic', 'pulse',
  'glucose_fasting', 'glucose_pp',
  'weight_kg', 'temp_c', 'spo2',
];

for (const m of EXPECTED_METRICS) {
  assert.ok(
    new RegExp(`<input[^>]*data-metric="${m}"`).test(html),
    `log-vitals.html: must expose an <input data-metric="${m}"> so patients can log it directly`,
  );
  assert.ok(
    new RegExp(`<input[^>]*name="${m}"`).test(html),
    `log-vitals.html: must expose <input name="${m}"> (form-submission name)`,
  );
}

// Tab switcher must be gone — the new UX shows all 8 fields at once.
assert.ok(
  !/class="metric-tabs"/.test(html),
  'log-vitals.html: tab switcher removed — single form with all 8 inputs',
);
assert.ok(
  !/class="metric-tab"/.test(html),
  'log-vitals.html: no leftover .metric-tab elements',
);

// The submit handler must POST a bulk `readings` array.
assert.ok(
  /JSON\.stringify\(\{\s*readings\s*\}/.test(html),
  'log-vitals.html: form submit must POST { readings: [...] }',
);

// Backend accepts both shapes — legacy single-reading and bulk.
// Match the handler from app.post through the route's closing }); by
// counting braces (the handler nests audit calls, getSession, etc.).
const handlerStart = serverJs.indexOf("app.post('/api/patient/vitals'");
assert.ok(handlerStart >= 0, 'server.mjs: POST /api/patient/vitals handler present');
let depth = 0, endIdx = -1, started = false;
for (let i = handlerStart; i < serverJs.length; i++) {
  const c = serverJs[i];
  if (c === '{') { depth++; started = true; }
  else if (c === '}') {
    depth--;
    if (started && depth === 0) { endIdx = i + 1; break; }
  }
}
assert.ok(endIdx > handlerStart, 'server.mjs: balanced brace scan found handler end');
const postBlock = serverJs.slice(handlerStart, endIdx + 1);
assert.ok(
  /Array\.isArray\(body\.readings\)/.test(postBlock),
  'server.mjs: handler must branch on Array.isArray(body.readings) for bulk vs single',
);
assert.ok(
  /body\.metric && body\.value !== undefined/.test(postBlock),
  'server.mjs: handler must still accept legacy { metric, value } shape for backwards-compat',
);
assert.ok(
  /isFinite\(numValue\)/.test(postBlock),
  'server.mjs: bulk path must skip non-finite values (defensive)',
);
// Backwards-compat response shape: single-reading callers get the old
// flat shape { log_id, metric, value, flagged }, bulk callers get
// { count, readings: [...] }.
assert.ok(
  /!Array\.isArray\(body\.readings\)[\s\S]{0,200}\.\.\.results\[0\]/.test(postBlock),
  'server.mjs: single-reading callers must get flat { log_id, metric, value, flagged } response',
);

console.log(`OK — verified all ${EXPECTED_METRICS.length} metric inputs present in form`);
console.log('OK — verified legacy tab switcher is gone');
console.log('OK — verified form submits a bulk readings[] array');
console.log('OK — verified server accepts both bulk + legacy single-reading shapes');
console.log('\nAll Phase-1 log-vitals regression tests passed.');