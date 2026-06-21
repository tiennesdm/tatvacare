import { VBPPool } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';
const pool = new VBPPool('127.0.0.1', 6381, 1);
await pool.query('DELETE FROM prescriptions');
await pool.query('DELETE FROM appointments');
await pool.query('DELETE FROM patients');
await pool.query('DELETE FROM doctors');
await pool.query('DELETE FROM sessions');
console.log('cleared');
process.exit(0);
