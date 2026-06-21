// Test all 3 engine bug fixes
import { VBPPool } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';
const pool = new VBPPool('127.0.0.1', 6381, 1);
const c = await pool.acquire();
const conn = c.conn;
const mux = conn._mux;
const origCall = mux.call.bind(mux);
mux.call = async function(op, body, opts) {
  const r = await origCall(op, body, opts);
  for (const f of r) {
    if (f.op === 0x0a) {
      // Parse col headers
      const rowCount = f.body.readUInt32LE(4);
      const colCount = f.body.readUInt16LE(8);
      let off = 10;
      const types = [];
      for (let c = 0; c < colCount; c++) {
        const tid = f.body.readUInt16LE(off);
        off += 2;
        const bmp = f.body.readUInt8(off);
        off += 1 + bmp;
        types.push(tid);
      }
      console.log(`[DATA_CHUNK] types: [${types.join(', ')}] (T_TEXT=25, T_INT8=20, T_BOOL=16)`);
    }
  }
  return r;
};

console.log('=== TEST 1: Bug 1 — multi-col SELECT with TEXT first col ===');
try {
  const r = await c.query(`SELECT doctor_id, full_name, email, phone, password_hash, specialties, clinic_name, city FROM doctors WHERE phone = '+919876500001' LIMIT 1`);
  console.log('row[0]:', r.rows[0]);
} catch (e) { console.log('FAIL:', e.message); }

console.log('\n=== TEST 2: Bug 1 — multi-col with patient_id (TEXT but ends in _id) ===');
try {
  const r = await c.query(`SELECT patient_id, full_name, phone FROM patients WHERE phone = '+919812345670' LIMIT 1`);
  console.log('row[0]:', r.rows[0]);
} catch (e) { console.log('FAIL:', e.message); }

console.log('\n=== TEST 3: Bug 3 — is_active stored correctly ===');
try {
  const r = await c.query(`SELECT doctor_id, full_name, is_active FROM doctors WHERE phone = '+919876500001' LIMIT 1`);
  console.log('row[0]:', r.rows[0]);
  console.log('is_active value:', r.rows[0]?.[2]);
} catch (e) { console.log('FAIL:', e.message); }

console.log('\n=== TEST 4: Bug 3 — filter by is_active = 1 (should match) ===');
try {
  const r = await c.query(`SELECT doctor_id FROM doctors WHERE is_active = 1`);
  console.log('rows:', r.rows);
} catch (e) { console.log('FAIL:', e.message); }

console.log('\n=== TEST 5: Bug 2 — ::date cast in WHERE ===');
try {
  // This previously failed with "scalar subquery in SELECT: unexpected operator: ::"
  const r = await c.query(`SELECT doctor_id FROM appointments WHERE scheduled_at::date = CURRENT_DATE LIMIT 5`);
  console.log('rows:', r.rows);
} catch (e) { console.log('FAIL:', e.message); }

console.log('\n=== TEST 6: Bug 2 — :: cast in scalar subquery ===');
try {
  const r = await c.query(`SELECT (SELECT MAX(scheduled_at)::text FROM appointments) AS latest FROM doctors LIMIT 1`);
  console.log('rows:', r.rows);
} catch (e) { console.log('FAIL:', e.message); }

console.log('\n=== TEST 7: Multi-col with COUNT ===');
try {
  const r = await c.query(`SELECT doctor_id, COUNT(*) FROM prescriptions WHERE doctor_id = 'd-001' GROUP BY doctor_id`);
  console.log('rows:', r.rows);
} catch (e) { console.log('FAIL:', e.message); }

process.exit(0);
