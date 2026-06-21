import { VBPPool } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';
const pool = new VBPPool('127.0.0.1', 6381, 1);
const tests = [
  `SELECT drug_id, name FROM drugs WHERE name LIKE '%Amlod%' LIMIT 5`,  // case sensitive exact
  `SELECT drug_id, name FROM drugs WHERE LOWER(name) LIKE '%amlod%' LIMIT 5`,
  `SELECT drug_id, name FROM drugs WHERE name ILIKE '%amlod%' LIMIT 5`,
  `SELECT drug_id, name FROM drugs WHERE name LIKE '%Amlodipine%' LIMIT 5`,
  `SELECT drug_id, name FROM drugs WHERE LOWER(name) LIKE LOWER('%Amlod%') LIMIT 5`,
];
for (const sql of tests) {
  try {
    const r = await pool.query(sql);
    console.log('SQL:', sql.slice(0, 60));
    console.log('  rows:', r.rows);
  } catch (e) { console.log('  ERR:', e.message); }
}
process.exit(0);
