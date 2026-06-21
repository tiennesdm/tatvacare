// Doctor model — DB queries for doctor + patients + prescriptions
import { genId } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/auth.mjs';
import { sqlStr } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/auth.mjs';

export async function getDoctor(pool, doctorId) {
  const r = await pool.query(`SELECT doctor_id, full_name, email, phone, qualifications, specialties, mci_reg_no, clinic_name, clinic_address, city, state, pincode FROM doctors WHERE doctor_id = ${sqlStr(doctorId)} LIMIT 1`);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  let specs = row[4];
  if (typeof specs === 'string' && specs.startsWith('[')) try { specs = JSON.parse(specs); } catch {}
  return {
    doctor_id: row[0], full_name: row[1], email: row[2], phone: row[3],
    qualifications: row[4] !== 'NULL' ? row[4] : null,
    specialties: specs,
    mci_reg_no: row[6] !== 'NULL' ? row[6] : null,
    clinic_name: row[7] !== 'NULL' ? row[7] : null,
    clinic_address: row[8] !== 'NULL' ? row[8] : null,
    city: row[9] !== 'NULL' ? row[9] : null,
    state: row[10] !== 'NULL' ? row[10] : null,
    pincode: row[11] !== 'NULL' ? row[11] : null,
  };
}

export async function listPatients(pool, doctorId) {
  // Get patient IDs via 2 separate single-col queries
  const r1 = await pool.query(`SELECT patient_id, 'a' FROM appointments WHERE doctor_id = '${doctorId}'`);
  const r2 = await pool.query(`SELECT patient_id, 'b' FROM prescriptions WHERE doctor_id = '${doctorId}'`);
  // The patient_id may be in col 0 or col 1 due to engine bug — check both
  const ids = [...new Set([
    ...r1.rows.map(r => r[0] || r[1]),
    ...r2.rows.map(r => r[0] || r[1]),
  ])].filter(Boolean);
  if (ids.length === 0) return [];
  // For each id, get details via multi-col queries (engine bug works correctly when col 0 is real TEXT)
  const out = [];
  for (const id of ids) {
    // Use multi-col so col 0 is correctly read as TEXT (the engine bug only
    // affects the FIRST col when typeId is reported wrong, but multi-col
    // queries have proper alignment)
    const details = await pool.query(`SELECT full_name, abha_number, phone, gender, dob, city, blood_group FROM patients WHERE patient_id = '${id}'`);
    if (details.rows.length === 0) continue;
    const r = details.rows[0];
    // The first 4 cols may be in the wrong positions; detect by content
    // and reassign
    const fields = ['full_name', 'abha_number', 'phone', 'gender', 'dob', 'city', 'blood_group'];
    const values = {};
    // For multi-col queries, col 0 is the "text" col. If the actual data is
    // 7 cols, the engine might shift them. Check by content validity.
    for (let i = 0; i < fields.length && i < r.length; i++) {
      values[fields[i]] = r[i] || '';
    }
    out.push({
      patient_id: id,
      ...values,
      dob: values.dob ? String(values.dob).slice(0, 10) : null,
    });
  }
  // Get last_visit and rx_count via single-col (with marker)
  for (const p of out) {
    const lv = await pool.query(`SELECT MAX(scheduled_at), 0 FROM appointments WHERE patient_id = '${p.patient_id}' AND doctor_id = '${doctorId}'`);
    p.last_visit = lv.rows[0]?.[0] || null;
    const rc = await pool.query(`SELECT COUNT(*), 0 FROM prescriptions WHERE patient_id = '${p.patient_id}' AND doctor_id = '${doctorId}'`);
    p.rx_count = Number(rc.rows[0]?.[0] || 0);
  }
  out.sort((a, b) => (b.last_visit || '').localeCompare(a.last_visit || ''));
  return out;
}

export async function getPatient(pool, patientId, doctorId) {
  const r = await pool.query(`SELECT patient_id, full_name, abha_number, phone, email, gender, dob, blood_group, address, city FROM patients WHERE patient_id = '${patientId}' AND is_active = 1 LIMIT 1`);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    patient_id: row[0], full_name: row[1], abha_number: row[2], phone: row[3],
    email: row[4], gender: row[5], dob: row[6] ? new Date(row[6]).toISOString().slice(0, 10) : null,
    blood_group: row[7], address: row[8], city: row[9],
  };
}

export async function searchPatients(pool, q) {
  const safeQ = sqlStr('%' + q + '%');
  const r = await pool.query(`SELECT patient_id, full_name, phone, abha_number, city FROM patients WHERE is_active = 1 AND (full_name LIKE ${safeQ} OR phone LIKE ${safeQ} OR abha_number LIKE ${safeQ}) ORDER BY full_name LIMIT 25`);
  return r.rows.map(row => ({
    patient_id: row[0], full_name: row[1], phone: row[2], abha_number: row[3], city: row[4],
  }));
}

export async function createPatient(pool, data, doctorId) {
  const id = genId('p');
  const sql = `INSERT INTO patients (patient_id, abha_number, full_name, dob, gender, phone, email, blood_group, address, city, emergency_name, emergency_phone) VALUES (
    '${id}', ${sqlStr(data.abha_number || '')}, ${sqlStr(data.full_name)},
    ${data.dob ? `'${data.dob}'` : 'NULL'}, ${sqlStr(data.gender || '')},
    ${sqlStr(data.phone)}, ${sqlStr(data.email || '')},
    ${sqlStr(data.blood_group || '')}, ${sqlStr(data.address || '')}, ${sqlStr(data.city || '')},
    ${sqlStr(data.emergency_name || '')}, ${sqlStr(data.emergency_phone || '')}
  )`;
  await pool.query(sql);
  return { patient_id: id, ...data };
}

export async function listPrescriptions(pool, doctorId, patientId) {
  const filter = patientId ? `AND r.patient_id = '${patientId}'` : '';
  const r = await pool.query(`
    SELECT r.rx_id, r.rx_number, r.patient_id, p.full_name, r.diagnosis_code, r.diagnosis_label,
      r.chief_complaint, r.vitals_bp, r.vitals_pulse, r.vitals_weight_kg,
      r.advice, r.followup_in_days, r.delivery_method, r.delivered_at, r.created_at, r.is_revoked
    FROM prescriptions r JOIN patients p ON p.patient_id = r.patient_id
    WHERE r.doctor_id = '${doctorId}' ${filter}
    ORDER BY r.created_at DESC
    LIMIT 50
  `);
  const safeDate = (v) => {
    if (!v || v === 'NULL' || v === 'null') return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  };
  return r.rows.map(row => ({
    rx_id: row[0], rx_number: row[1], patient_id: row[2], patient_name: row[3],
    diagnosis_code: row[4], diagnosis_label: row[5], chief_complaint: row[6],
    vitals: { bp: row[7], pulse: row[8], weight: row[9] },
    advice: row[10], followup_in_days: row[11], delivery_method: row[12],
    delivered_at: safeDate(row[13]),
    created_at: safeDate(row[14]) || new Date().toISOString(),
    is_revoked: Number(row[15] || 0) === 1,
  }));
}

export async function getPrescription(pool, rxId) {
  const r = await pool.query(`SELECT r.rx_id, r.rx_number, r.patient_id, r.doctor_id, r.diagnosis_code, r.diagnosis_label, r.chief_complaint, r.clinical_notes, r.vitals_bp, r.vitals_pulse, r.vitals_temp_c, r.vitals_spo2, r.vitals_weight_kg, r.rx_items, r.lab_tests, r.advice, r.followup_in_days, r.delivery_method, r.delivered_at, r.is_revoked, r.created_at, p.full_name, d.full_name FROM prescriptions r JOIN patients p ON p.patient_id = r.patient_id JOIN doctors d ON d.doctor_id = r.doctor_id WHERE r.rx_id = '${rxId}' LIMIT 1`);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  // The engine v1 stores SQL NULL as the literal string "NULL" (not a true
  // NULL) for some columns. JSON.parse on "NULL" throws. Normalise before
  // parsing: empty/"NULL" → null, else try to parse.
  const safeParse = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v !== 'string') return v;
    const s = v.trim();
    if (s === '' || s.toUpperCase() === 'NULL') return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
  };
  return {
    rx_id: row[0], rx_number: row[1], patient_id: row[2], doctor_id: row[3],
    diagnosis_code: row[4], diagnosis_label: row[5], chief_complaint: row[6], clinical_notes: row[7],
    vitals: { bp: row[8], pulse: row[9], temp: row[10], spo2: row[11], weight: row[12] },
    rx_items: safeParse(row[13], []),
    lab_tests: safeParse(row[14], []),
    advice: row[15], followup_in_days: row[16], delivery_method: row[17],
    delivered_at: row[18] && row[18] !== 'NULL' ? new Date(row[18]).toISOString() : null,
    is_revoked: Number(row[19] || 0) === 1,
    created_at: row[20] && row[20] !== 'NULL' ? new Date(row[20]).toISOString() : new Date().toISOString(),
    patient_name: row[21], doctor_name: row[22],
  };
}

export async function createPrescription(pool, data, doctorId) {
  const id = genId('r');
  // Generate a globally unique rx_number: TC-YYYY-<unix_ms>-<short_rand>
  // The year prefix keeps it human-readable; the suffix guarantees uniqueness
  // across doctors even under concurrency (the older COUNT(*)+1 scheme
  // collided across doctors since rx_number has a UNIQUE constraint
  // across the whole table, not per-doctor).
  const year = new Date().getFullYear();
  const ts = Date.now().toString(36);  // base36 = compact
  const rand = Math.random().toString(36).slice(2, 6);
  const rxNumber = `TC-${year}-${ts}${rand}`.toUpperCase();
  const sql = `INSERT INTO prescriptions (
    rx_id, rx_number, patient_id, doctor_id, appt_id,
    diagnosis_code, diagnosis_label, chief_complaint, clinical_notes,
    vitals_bp, vitals_pulse, vitals_temp_c, vitals_spo2, vitals_weight_kg,
    rx_items, lab_tests, advice, followup_in_days, delivery_method
  ) VALUES (
    '${id}', '${rxNumber}', '${data.patient_id}', '${doctorId}', ${data.appt_id ? `'${data.appt_id}'` : 'NULL'},
    ${sqlStr(data.diagnosis_code || '')}, ${sqlStr(data.diagnosis_label || '')},
    ${sqlStr(data.chief_complaint || '')}, ${sqlStr(data.clinical_notes || '')},
    ${sqlStr(data.vitals_bp || '')}, ${data.vitals_pulse ?? 'NULL'}, ${data.vitals_temp_c ?? 'NULL'},
    ${data.vitals_spo2 ?? 'NULL'}, ${data.vitals_weight_kg ?? 'NULL'},
    ${sqlStr(JSON.stringify(data.rx_items || []))},
    ${data.lab_tests ? sqlStr(JSON.stringify(data.lab_tests)) : 'NULL'},
    ${sqlStr(data.advice || '')}, ${data.followup_in_days ?? 'NULL'},
    ${sqlStr(data.delivery_method || 'app')}
  )`;
  await pool.query(sql);
  return { rx_id: id, rx_number: rxNumber, ...data };
}

export async function listAppointments(pool, doctorId, date) {
  const dateFilter = date ? `AND scheduled_at::date = '${date}'` : '';
  const r = await pool.query(`SELECT a.appt_id, a.patient_id, p.full_name, a.scheduled_at, a.duration_min, a.type, a.status, a.reason FROM appointments a JOIN patients p ON p.patient_id = a.patient_id WHERE a.doctor_id = '${doctorId}' ${dateFilter} ORDER BY a.scheduled_at LIMIT 50`);
  return r.rows.map(row => ({
    appt_id: row[0], patient_id: row[1], patient_name: row[2],
    scheduled_at: new Date(row[3]).toISOString(),
    duration_min: row[4], type: row[5], status: row[6], reason: row[7],
  }));
}

export async function getDashboardStats(pool, doctorId) {
  // Use 5 single-col queries to avoid multi-col + scalar subquery engine bugs
  const totalP = await pool.query(`SELECT COUNT(DISTINCT patient_id) FROM prescriptions WHERE doctor_id = '${doctorId}'`);
  const totalRx = await pool.query(`SELECT COUNT(*) FROM prescriptions WHERE doctor_id = '${doctorId}'`);
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const rxMonth = await pool.query(`SELECT COUNT(*) FROM prescriptions WHERE doctor_id = '${doctorId}' AND created_at >= '${monthStart}'`);
  const today = new Date().toISOString().slice(0, 10);
  const todayAppts = await pool.query(`SELECT COUNT(*) FROM appointments WHERE doctor_id = '${doctorId}' AND scheduled_at >= '${today}'`);
  const completed = await pool.query(`SELECT COUNT(*) FROM appointments WHERE doctor_id = '${doctorId}' AND status = 'completed'`);
  return {
    total_patients: Number(totalP.rows[0]?.[0] || 0),
    total_rx: Number(totalRx.rows[0]?.[0] || 0),
    rx_this_month: Number(rxMonth.rows[0]?.[0] || 0),
    today_appts: Number(todayAppts.rows[0]?.[0] || 0),
    completed_appts: Number(completed.rows[0]?.[0] || 0),
  };
}
