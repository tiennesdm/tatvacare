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
      console.log('body hex:', f.body.toString('hex'));
    }
  }
  return r;
};
const r = await c.query(`SELECT delivered_at, created_at FROM prescriptions WHERE doctor_id = 'd-001' LIMIT 1`);
console.log('rows:', r.rows);
process.exit(0);
