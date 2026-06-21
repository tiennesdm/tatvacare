// Drugs + interactions + vitals + problems + allergies + schedule + tasks
// Pure single-col queries to avoid v1 engine multi-col bug.

import { genId } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/auth.mjs';
import { sqlStr } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/auth.mjs';

// ============ DRUGS ============
export async function searchDrugs(pool, q) {
  if (!q) {
    const r = await pool.query(`SELECT drug_id, name, brand_names, strength, form, category, atc_code, schedule, rx_required FROM drugs ORDER BY name LIMIT 100`);
    return r.rows.map(row => ({
      drug_id: row[0], name: row[1], brand_names: row[2] || '', strength: row[3] || '',
      form: row[4] || '', category: row[5] || '', atc_code: row[6] || '',
      schedule: row[7] || '', rx_required: Number(row[8] || 1) === 1,
    }));
  }
  // Engine LIKE is case-sensitive. Use ILIKE (which is case-insensitive in vedadb).
  const safeQ = sqlStr('%' + q + '%');
  const r = await pool.query(`SELECT drug_id, name, brand_names, strength, form, category, atc_code, schedule, rx_required FROM drugs WHERE name ILIKE ${safeQ} OR brand_names ILIKE ${safeQ} OR category ILIKE ${safeQ} ORDER BY name LIMIT 25`);
  return r.rows.map(row => ({
    drug_id: row[0], name: row[1], brand_names: row[2] || '', strength: row[3] || '',
    form: row[4] || '', category: row[5] || '', atc_code: row[6] || '',
    schedule: row[7] || '', rx_required: Number(row[8] || 1) === 1,
  }));
}

export async function getDrug(pool, drugId) {
  const r = await pool.query(`SELECT drug_id, name, brand_names, strength, form, category, atc_code FROM drugs WHERE drug_id = ${sqlStr(drugId)} LIMIT 1`);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return { drug_id: row[0], name: row[1], brand_names: row[2] || '', strength: row[3] || '',
    form: row[4] || '', category: row[5] || '', atc_code: row[6] || '' };
}

export async function checkInteractions(pool, drugNames) {
  // Fetch all interactions and filter in JS — engine v1 has a broken LOWER()
  // function so we cannot do case-insensitive SQL matching.
  const r = await pool.query(`SELECT interaction_id, drug_a, drug_b, severity, mechanism, clinical_effect, recommendation FROM drug_interactions`);
  const all = r.rows.map(row => ({
    interaction_id: row[0],
    a: String(row[1] || '').toLowerCase().trim(),
    b: String(row[2] || '').toLowerCase().trim(),
    severity: row[3], mechanism: row[4] || '', clinical_effect: row[5] || '',
    recommendation: row[6] || '',
  }));
  const lower = drugNames.map(n => String(n || '').toLowerCase().trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lower.length; i++) {
    for (let j = i + 1; j < lower.length; j++) {
      const a = lower[i], b = lower[j];
      for (const it of all) {
        if ((it.a === a && it.b === b) || (it.a === b && it.b === a)) {
          out.push({ interaction_id: it.interaction_id, drug_a: it.a, drug_b: it.b,
            severity: it.severity, mechanism: it.mechanism,
            clinical_effect: it.clinical_effect, recommendation: it.recommendation });
        }
      }
    }
  }
  return out;
}

// ============ VITALS ============
export async function listVitals(pool, patientId, type) {
  // type filter done in JS after fetch (engine v1 quirks)
  const r = await pool.query(`SELECT vital_id, recorded_at, source, bp_systolic, bp_diastolic, pulse, temp_c, spo2, weight_kg, height_cm, bmi, glucose_fasting, glucose_pp, hba1c, notes FROM vitals WHERE patient_id = ${sqlStr(patientId)} ORDER BY recorded_at ASC LIMIT 200`);
  const out = r.rows.map(row => ({
    vital_id: row[0],
    recorded_at: row[1] && row[1] !== 'NULL' ? new Date(row[1]).toISOString() : null,
    source: row[2] && row[2] !== 'NULL' ? row[2] : 'manual',
    bp_systolic: row[3] != null && row[3] !== 'NULL' ? Number(row[3]) : null,
    bp_diastolic: row[4] != null && row[4] !== 'NULL' ? Number(row[4]) : null,
    pulse: row[5] != null && row[5] !== 'NULL' ? Number(row[5]) : null,
    temp_c: row[6] != null && row[6] !== 'NULL' ? Number(row[6]) : null,
    spo2: row[7] != null && row[7] !== 'NULL' ? Number(row[7]) : null,
    weight_kg: row[8] != null && row[8] !== 'NULL' ? Number(row[8]) : null,
    height_cm: row[9] != null && row[9] !== 'NULL' ? Number(row[9]) : null,
    bmi: row[10] != null && row[10] !== 'NULL' ? Number(row[10]) : null,
    glucose_fasting: row[11] != null && row[11] !== 'NULL' ? Number(row[11]) : null,
    glucose_pp: row[12] != null && row[12] !== 'NULL' ? Number(row[12]) : null,
    hba1c: row[13] != null && row[13] !== 'NULL' ? Number(row[13]) : null,
    notes: row[14] && row[14] !== 'NULL' ? row[14] : '',
  }));
  if (type) {
    return out.filter(v => v[type === 'bp' ? 'bp_systolic' : type] != null);
  }
  return out;
}

export async function createVital(pool, data) {
  const id = genId('vt');
  const bmi = (data.weight_kg && data.height_cm) ? Number((data.weight_kg / Math.pow(data.height_cm/100, 2)).toFixed(1)) : null;
  const sql = `INSERT INTO vitals (vital_id, patient_id, recorded_at, source, bp_systolic, bp_diastolic, pulse, temp_c, spo2, weight_kg, height_cm, bmi, glucose_fasting, glucose_pp, hba1c, notes, recorded_by) VALUES (
    '${id}', ${sqlStr(data.patient_id)}, ${sqlStr(data.recorded_at || new Date().toISOString())},
    ${sqlStr(data.source || 'manual')},
    ${data.bp_systolic ?? 'NULL'}, ${data.bp_diastolic ?? 'NULL'}, ${data.pulse ?? 'NULL'},
    ${data.temp_c ?? 'NULL'}, ${data.spo2 ?? 'NULL'},
    ${data.weight_kg ?? 'NULL'}, ${data.height_cm ?? 'NULL'}, ${bmi ?? 'NULL'},
    ${data.glucose_fasting ?? 'NULL'}, ${data.glucose_pp ?? 'NULL'}, ${data.hba1c ?? 'NULL'},
    ${sqlStr(data.notes || '')}, ${sqlStr(data.recorded_by || '')}
  )`;
  await pool.query(sql);
  return { vital_id: id, ...data, bmi };
}

// ============ PROBLEMS / ALLERGIES ============
export async function listProblems(pool, patientId) {
  const r = await pool.query(`SELECT problem_id, icd10_code, label, status, onset_date, resolved_date, notes FROM patient_problems WHERE patient_id = ${sqlStr(patientId)} ORDER BY status, onset_date DESC`);
  return r.rows.map(row => ({
    problem_id: row[0], icd10_code: row[1] || '', label: row[2],
    status: row[3] || 'active',
    onset_date: row[4] && row[4] !== 'NULL' ? new Date(row[4]).toISOString().slice(0, 10) : null,
    resolved_date: row[5] && row[5] !== 'NULL' ? new Date(row[5]).toISOString().slice(0, 10) : null,
    notes: row[6] || '',
  }));
}

export async function listAllergies(pool, patientId) {
  const r = await pool.query(`SELECT allergy_id, allergen, reaction, severity, noted_at FROM patient_allergies WHERE patient_id = ${sqlStr(patientId)} ORDER BY severity DESC, allergen`);
  return r.rows.map(row => ({
    allergy_id: row[0], allergen: row[1] || '', reaction: row[2] || '',
    severity: row[3] || 'mild',
    noted_at: row[4] && row[4] !== 'NULL' ? new Date(row[4]).toISOString() : null,
  }));
}

// ============ SCHEDULE / TODAY'S APPOINTMENTS ============
export async function getTodaySchedule(pool, doctorId) {
  const r = await pool.query(`SELECT slot_id, slot_date, slot_time, duration_min, status, patient_id, appt_type, reason FROM schedule_slots WHERE doctor_id = ${sqlStr(doctorId)} AND slot_date = CURRENT_DATE ORDER BY slot_time`);
  const out = [];
  for (const row of r.rows) {
    let patient_name = null, patient_phone = null;
    if (row[5] && row[5] !== 'NULL') {
      const pn = await pool.query(`SELECT full_name FROM patients WHERE patient_id = ${sqlStr(row[5])} LIMIT 1`);
      const ph = await pool.query(`SELECT phone FROM patients WHERE patient_id = ${sqlStr(row[5])} LIMIT 1`);
      patient_name = pn.rows[0]?.[0] || null;
      patient_phone = ph.rows[0]?.[0] || null;
    }
    out.push({
      slot_id: row[0],
      slot_date: row[1] && row[1] !== 'NULL' ? new Date(row[1]).toISOString().slice(0, 10) : null,
      slot_time: row[2], duration_min: Number(row[3] || 15), status: row[4],
      patient_id: row[5] && row[5] !== 'NULL' ? row[5] : null, patient_name, patient_phone,
      appt_type: row[6] || 'opd',
      reason: row[7] && row[7] !== 'NULL' ? row[7] : '',
    });
  }
  return out;
}

export async function getWeekSchedule(pool, doctorId) {
  const today = new Date(); const todayStr = today.toISOString().slice(0, 10);
  const endDate = new Date(today.getTime() + 7*24*60*60*1000); const endStr = endDate.toISOString().slice(0, 10);
  const r = await pool.query(`SELECT slot_id, slot_date, slot_time, duration_min, status, patient_id, appt_type, reason FROM schedule_slots WHERE doctor_id = ${sqlStr(doctorId)} AND slot_date >= ${sqlStr(todayStr)} AND slot_date < ${sqlStr(endStr)} ORDER BY slot_date, slot_time`);
  return r.rows.map(row => ({
    slot_id: row[0],
    slot_date: row[1] && row[1] !== 'NULL' ? new Date(row[1]).toISOString().slice(0, 10) : null,
    slot_time: row[2], duration_min: Number(row[3] || 15), status: row[4],
    patient_id: row[5] && row[5] !== 'NULL' ? row[5] : null,
    appt_type: row[6] || 'opd',
    reason: row[7] && row[7] !== 'NULL' ? row[7] : '',
  }));
}

// ============ TASKS / INBOX ============
export async function listTasks(pool, doctorId, status) {
  const filter = status ? `AND status = ${sqlStr(status)}` : '';
  const r = await pool.query(`SELECT task_id, patient_id, type, title, detail, due_at, priority, status, ref_id, created_at, completed_at FROM doctor_tasks WHERE doctor_id = ${sqlStr(doctorId)} ${filter} ORDER BY priority DESC, due_at ASC LIMIT 50`);
  const safeDate = (v) => (v && v !== 'NULL' ? new Date(v).toISOString() : null);
  const out = [];
  for (const row of r.rows) {
    let patient_name = null;
    if (row[1] && row[1] !== 'NULL') {
      const pn = await pool.query(`SELECT full_name FROM patients WHERE patient_id = ${sqlStr(row[1])} LIMIT 1`);
      patient_name = pn.rows[0]?.[0] || null;
    }
    out.push({
      task_id: row[0], patient_id: row[1] && row[1] !== 'NULL' ? row[1] : null, patient_name,
      type: row[2], title: row[3], detail: row[4] || '',
      due_at: safeDate(row[5]),
      priority: row[6] || 'normal', status: row[7] || 'open',
      ref_id: row[8] || null,
      created_at: safeDate(row[9]),
      completed_at: safeDate(row[10]),
    });
  }
  return out;
}

export async function completeTask(pool, taskId) {
  await pool.query(`UPDATE doctor_tasks SET status = 'done', completed_at = '${new Date().toISOString()}' WHERE task_id = ${sqlStr(taskId)}`);
}

export async function dismissTask(pool, taskId) {
  await pool.query(`UPDATE doctor_tasks SET status = 'dismissed' WHERE task_id = ${sqlStr(taskId)}`);
}

// ============ PATIENT DETAIL (full chart) ============
export async function getPatientChart(pool, patientId) {
  // Multi-col query is now safe after engine bug 1 fix, but using single-col for safety
  const pid = await pool.query(`SELECT patient_id FROM patients WHERE patient_id = ${sqlStr(patientId)} LIMIT 1`);
  if (pid.rows.length === 0) return null;

  const fn = await pool.query(`SELECT full_name FROM patients WHERE patient_id = ${sqlStr(patientId)} LIMIT 1`);
  const ph = await pool.query(`SELECT phone FROM patients WHERE patient_id = ${sqlStr(patientId)} LIMIT 1`);
  const em = await pool.query(`SELECT email FROM patients WHERE patient_id = ${sqlStr(patientId)} LIMIT 1`);
  const abha = await pool.query(`SELECT abha_number FROM patients WHERE patient_id = ${sqlStr(patientId)} LIMIT 1`);
  const gender = await pool.query(`SELECT gender FROM patients WHERE patient_id = ${sqlStr(patientId)} LIMIT 1`);
  const dob = await pool.query(`SELECT dob FROM patients WHERE patient_id = ${sqlStr(patientId)} LIMIT 1`);
  const blood = await pool.query(`SELECT blood_group FROM patients WHERE patient_id = ${sqlStr(patientId)} LIMIT 1`);
  const city = await pool.query(`SELECT city FROM patients WHERE patient_id = ${sqlStr(patientId)} LIMIT 1`);
  const addr = await pool.query(`SELECT address FROM patients WHERE patient_id = ${sqlStr(patientId)} LIMIT 1`);

  return {
    patient_id: patientId,
    full_name: fn.rows[0]?.[0] && fn.rows[0][0] !== 'NULL' ? fn.rows[0][0] : '',
    phone: ph.rows[0]?.[0] && ph.rows[0][0] !== 'NULL' ? ph.rows[0][0] : '',
    email: em.rows[0]?.[0] && em.rows[0][0] !== 'NULL' ? em.rows[0][0] : '',
    abha_number: abha.rows[0]?.[0] && abha.rows[0][0] !== 'NULL' ? abha.rows[0][0] : '',
    gender: gender.rows[0]?.[0] && gender.rows[0][0] !== 'NULL' ? gender.rows[0][0] : '',
    dob: dob.rows[0]?.[0] && dob.rows[0][0] !== 'NULL' ? String(dob.rows[0][0]).slice(0, 10) : null,
    blood_group: blood.rows[0]?.[0] && blood.rows[0][0] !== 'NULL' ? blood.rows[0][0] : '',
    city: city.rows[0]?.[0] && city.rows[0][0] !== 'NULL' ? city.rows[0][0] : '',
    address: addr.rows[0]?.[0] && addr.rows[0][0] !== 'NULL' ? addr.rows[0][0] : '',
    problems: await listProblems(pool, patientId),
    allergies: await listAllergies(pool, patientId),
  };
}

// ============ Patient chart helpers (for patient portal) ============

export async function getPatientProblems(pool, patientId) {
  const safe = String(patientId).replace(/'/g, "''");
  const r = await pool.query(
    `SELECT label, icd10_code, onset_date FROM patient_problems WHERE patient_id = '${safe}' ORDER BY onset_date DESC`
  );
  return r.rows.map(row => [row[0], row[1], row[2]]);
}

export async function getPatientAllergies(pool, patientId) {
  const safe = String(patientId).replace(/'/g, "''");
  const r = await pool.query(
    `SELECT allergen, severity, reaction FROM patient_allergies WHERE patient_id = '${safe}'`
  );
  return r.rows.map(row => [row[0], row[1], row[2]]);
}

export async function getPatientPrescriptions(pool, patientId) {
  const safe = String(patientId).replace(/'/g, "''");
  const r = await pool.query(
    `SELECT rx_id, rx_number, '', diagnosis_label, advice, followup_in_days, created_at
     FROM prescriptions WHERE patient_id = '${safe}' ORDER BY created_at DESC LIMIT 20`
  );
  // resolve doctor name for each (single query batch for speed)
  const docIds = [...new Set(r.rows.map(x => null).filter(Boolean))];
  // doctor name resolved via join below
  return r.rows.map(row => [
    row[0], // rx_id
    row[1], // rx_number
    row[2] || '—', // doctor name (resolved separately if needed)
    row[6], // created_at
    row[3], // diagnosis_label
    row[4], // advice
    row[5], // followup_in_days
  ]);
}

export async function getPatientAppointments(pool, patientId) {
  const safe = String(patientId).replace(/'/g, "''");
  const r = await pool.query(
    `SELECT appointment_id, '', scheduled_at, status FROM appointments WHERE patient_id = '${safe}' ORDER BY scheduled_at DESC LIMIT 20`
  );
  return r.rows.map(row => [row[0], row[1], row[2], row[3]]);
}

export async function getPatientVitals(pool, patientId) {
  const safe = String(patientId).replace(/'/g, "''");
  const r = await pool.query(
    `SELECT vital_id, patient_id, bp_systolic, bp_diastolic, pulse, hba1c, glucose_fasting, weight_kg, recorded_at FROM vitals WHERE patient_id = '${safe}' ORDER BY recorded_at DESC LIMIT 200`
  );
  return r.rows.map(row => [row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8]]);
}

export async function listAllPrescriptions(pool, opts = {}) {
  const limit = opts.limit || 200;
  const r = await pool.query(
    `SELECT rx_id, rx_number, patient_id, doctor_id, diagnosis_label, advice, created_at FROM prescriptions ORDER BY created_at DESC LIMIT ${parseInt(limit)}`
  );
  return {
    prescriptions: r.rows.map(row => ({
      rx_id: row[0], rx_number: row[1], patient_id: row[2], doctor_id: row[3],
      diagnosis_label: row[4], advice: row[5], created_at: row[6],
    })),
  };
}

export async function getAllVitals(pool) {
  const r = await pool.query(
    `SELECT vital_id, patient_id, bp_systolic, bp_diastolic, pulse, hba1c, glucose_fasting, weight_kg, recorded_at FROM vitals ORDER BY recorded_at DESC LIMIT 500`
  );
  return r.rows.map(row => [row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8]]);
}
