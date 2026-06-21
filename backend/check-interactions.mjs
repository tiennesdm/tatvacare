import { VBPPool } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';
const pool = new VBPPool('127.0.0.1', 6381, 1);
const tests = [
  `SELECT drug_a, drug_b FROM drug_interactions WHERE drug_a = 'Amlodipine' AND drug_b = 'Simvastatin'`,
  `SELECT drug_a, drug_b FROM drug_interactions WHERE LOWER(drug_a) = 'amlodipine'`,
  `SELECT drug_a, drug_b FROM drug_interactions WHERE LOWER(drug_a) = 'Amlodipine'`,
  `SELECT drug_a, drug_b FROM drug_interactions WHERE LOWER(drug_a) LIKE 'amlodipine'`,
  `SELECT drug_a, drug_b FROM drug_interactions WHERE drug_a ILIKE 'amlodipine'`,
];
for (const sql of tests) {
  try {
    const r = await pool.query(sql);
    console.log('SQL:', sql);
    console.log('  rows:', r.rows.length, r.rows.slice(0, 3));
  } catch (e) { console.log('  ERR:', e.message); }
}
process.exit(0);
