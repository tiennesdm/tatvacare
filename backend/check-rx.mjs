import { VBPPool } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';
const pool = new VBPPool('127.0.0.1', 6381, 1);
const c = await pool.acquire();
const r = await c.query(`SELECT rx_id, rx_number, patient_id, doctor_id, appt_id, diagnosis_code, diagnosis_label, chief_complaint, clinical_notes, vitals_bp, vitals_pulse, vitals_temp_c, vitals_spo2, vitals_weight_kg, rx_items, lab_tests, advice, followup_in_days, delivery_method, delivered_at, is_revoked, created_at FROM prescriptions WHERE doctor_id = 'd-001' ORDER BY created_at DESC LIMIT 5`);
console.log('rows:', r.rows);
console.log('first row[19] (delivered_at):', r.rows[0]?.[19], typeof r.rows[0]?.[19]);
console.log('first row[21] (created_at):', r.rows[0]?.[21], typeof r.rows[0]?.[21]);
process.exit(0);
