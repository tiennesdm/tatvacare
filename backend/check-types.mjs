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
      const rowCount = f.body.readUInt32LE(4);
      const colCount = f.body.readUInt16LE(8);
      let off = 10;
      const types = [];
      const widths = [];
      for (let c = 0; c < colCount; c++) {
        const tid = f.body.readUInt16LE(off); off += 2;
        const bmp = f.body.readUInt8(off); off += 1;
        if (bmp > 0) off += bmp;
        const w = ({16:1, 20:8, 21:2, 23:4, 700:4, 701:8, 25:0, 1114:8, 1082:4})[tid] || 0;
        types.push(tid);
        widths.push(w);
        if (w > 0) off += rowCount * w;
        else for (let r = 0; r < rowCount; r++) { const ln = f.body.readUInt32LE(off); off += 4 + ln; }
      }
      console.log(`colCount=${colCount} rowCount=${rowCount} body_len=${f.body.length} off_after=${off}`);
      console.log('types:', types);
      console.log('widths:', widths);
    }
  }
  return r;
};
try {
  const r = await c.query(`SELECT doctor_id, full_name, email, phone, password_hash, specialties, clinic_name, city FROM doctors WHERE phone = '+919876500001' LIMIT 1`);
  console.log('rows:', JSON.stringify(r.rows[0]));
} catch (e) { console.log('FAIL:', e.message); }
process.exit(0);
