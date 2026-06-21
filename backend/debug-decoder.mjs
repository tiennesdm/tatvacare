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
      console.log('--- DATA_CHUNK ---');
      console.log('body hex:', f.body.toString('hex'));
      console.log('body length:', f.body.length);
      console.log('rowCount at offset 4:', f.body.readUInt32LE(4));
      console.log('colCount at offset 8:', f.body.readUInt16LE(8));
      let off = 10;
      for (let c = 0; c < f.body.readUInt16LE(8); c++) {
        if (off + 3 > f.body.length) { console.log(`  col ${c}: TRUNCATED at off=${off}`); break; }
        const tid = f.body.readUInt16LE(off); off += 2;
        const bmpSize = f.body.readUInt8(off); off += 1;
        console.log(`  col ${c}: typeId=${tid} (0x${tid.toString(16)}) bmpSize=${bmpSize} off after header=${off}`);
        if (bmpSize > 0) { console.log(`    null bitmap: ${f.body.slice(off, off + bmpSize).toString('hex')}`); off += bmpSize; }
        const w = (tid === 16 ? 1 : tid === 21 ? 2 : tid === 23 ? 4 : tid === 20 ? 8 : tid === 700 ? 4 : tid === 701 ? 8 : tid === 2950 ? 16 : tid === 1114 || tid === 1184 ? 8 : tid === 1082 ? 4 : 0);
        console.log(`    fixed-width: ${w}`);
      }
    }
  }
  return r;
};
try {
  const r = await c.query(`SELECT doctor_id, phone, email FROM doctors LIMIT 1`);
  console.log('result rows:', r.rows);
} catch (e) { console.log('err:', e.message); }
process.exit(0);
