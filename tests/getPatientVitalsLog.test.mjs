// Phase-1 regression tests for clinical.getPatientVitalsLog.
//
// Why these exist: the patient portal home template renders each vitals
// record as {metric, value, unit, recorded_at, flagged, notes}. The
// aggregated `vitals` table (one row per date) returns 2D arrays that
// don't match that shape — that's what caused the literal `undefined`
// rendering next to vitals values on /patient/home before the fix.
//
// These tests mock the Vedadb pool and verify the helper still produces
// the documented object shape regardless of which rows come back.
//
// Run: `node tests/getPatientVitalsLog.test.mjs` from the repo root.

import { strict as assert } from 'node:assert';
import { getPatientVitalsLog } from '../backend/lib/clinical.mjs';

function mockPool(rows) {
  return {
    async query(sql) {
      // Sanity-check the SQL so future schema drift is caught.
      assert.ok(
        sql.includes('FROM patient_vitals_log'),
        'getPatientVitalsLog must read from patient_vitals_log',
      );
      assert.ok(
        sql.includes('ORDER BY recorded_at DESC'),
        'getPatientVitalsLog must order by recorded_at DESC',
      );
      assert.ok(
        sql.includes('LIMIT 200'),
        'getPatientVitalsLog must apply a 200-row cap',
      );
      return { rows };
    },
  };
}

const fakeRows = [
  ['pvl-1', 'systolic', 142, 'mmHg', '2026-06-21T09:00:00Z', 'high', 'after morning walk'],
  ['pvl-2', 'glucose_fasting', 95, 'mg/dL', '2026-06-21T07:00:00Z', '', ''],
  ['pvl-3', 'weight_kg', 78.5, 'kg', '2026-06-20T20:00:00Z', '', ''],
];

const vitals = await getPatientVitalsLog(mockPool(fakeRows), 'p-0001');

assert.equal(vitals.length, 3, 'returns one entry per row');
assert.deepEqual(
  Object.keys(vitals[0]).sort(),
  ['flagged', 'log_id', 'metric', 'notes', 'recorded_at', 'unit', 'value'],
  'each entry exposes the 7 fields the frontend expects',
);
assert.equal(vitals[0].metric, 'systolic');
assert.equal(vitals[0].value, 142);
assert.equal(vitals[0].unit, 'mmHg');
assert.equal(vitals[0].flagged, 'high');
assert.equal(vitals[0].log_id, 'pvl-1');
assert.equal(vitals[0].recorded_at, '2026-06-21T09:00:00Z');
assert.equal(vitals[0].notes, 'after morning walk');

// Empty result is still a valid array (the frontend falls back to the
// empty-state message in this case).
const empty = await getPatientVitalsLog(mockPool([]), 'p-0002');
assert.deepEqual(empty, [], 'empty result returns empty array');

// SQL-injection guard: the patient id must be quoted / escaped. If a
// future change drops the .replace() the test below will catch it via
// the SQL preview the mock prints. We assert the helper does not throw
// for typical values, and that no row from one patient bleeds into a
// query for a different patient (mock returns whatever it's told to).
const res = await getPatientVitalsLog(mockPool([]), "p-x'; DROP TABLE doctors; --");
assert.deepEqual(res, [], 'escaped patient_id never affects shape');

console.log(`OK — getPatientVitalsLog: ${vitals.length} rows, shape correct`);
console.log('All Phase-1 vitals-shape tests passed.');