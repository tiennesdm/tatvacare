// Patient auth (separate from doctor auth).
// Patients log in with phone + password (last 6 digits of phone) or PIN.
import crypto from 'node:crypto';

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const PATIENT_COOKIE = 'pid';

async function loginPatient(pool, phone, password) {
  const safePhone = String(phone).replace(/'/g, "''");
  // First get patient
  const pr = await pool.query(
    `SELECT patient_id, full_name, phone, gender, dob FROM patients WHERE phone = '${safePhone}'`
  );
  if (!pr.rows.length) return null;
  const [pid, full_name, phoneDb, gender, dob] = pr.rows[0];
  // Then get credentials (separate query — engine v1 has trouble with LEFT JOIN column refs)
  const cr = await pool.query(
    `SELECT password_hash, pin, failed_attempts, locked_until FROM patient_credentials WHERE patient_id = '${String(pid).replace(/'/g, "''")}'`
  );
  const crow = cr.rows[0] || [null, null, 0, null];
  if (crow[3] && new Date(crow[3]) > new Date()) {
    return { locked: true, until: crow[3] };
  }
  const expected = crow[0] || sha256(String(phoneDb).slice(-6));
  const got = sha256(String(password || ''));
  if (got !== expected) {
    try {
      await pool.query(
        `UPDATE patient_credentials SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN '2026-12-31' ELSE NULL END
         WHERE patient_id = '${String(pid).replace(/'/g, "''")}'`
      );
    } catch {}
    return { wrong: true };
  }
  try {
    await pool.query(
      `UPDATE patient_credentials SET failed_attempts = 0, locked_until = NULL WHERE patient_id = '${String(pid).replace(/'/g, "''")}'`
    );
  } catch {}
  const session_id = crypto.randomBytes(32).toString('hex');
  const expires_at = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO sessions (session_id, doctor_id, created_at, expires_at)
     VALUES ('${session_id}', 'PATIENT:${String(pid).replace(/'/g, "''")}', '2026-06-21', '${expires_at}')`
  );
  return {
    session_id,
    patient: {
      patient_id: pid, full_name, phone: phoneDb, gender, date_of_birth: dob,
    },
  };
}

async function getPatientSession(pool, sid) {
  if (!sid) return null;
  try {
    const r = await pool.query(
      `SELECT session_id, doctor_id, expires_at FROM sessions WHERE session_id = '${sid.replace(/'/g, "''")}'`
    );
    if (!r.rows.length) return null;
    // r.rows[0] is [session_id, doctor_id, expires_at] (positional)
    const [session_id, doctor_id, expires_at] = r.rows[0];
    if (!String(doctor_id).startsWith('PATIENT:')) return null;
    if (expires_at && new Date(expires_at) < new Date()) return null;
    const patient_id = String(doctor_id).slice('PATIENT:'.length);
    const pr = await pool.query(
      `SELECT patient_id, full_name, phone, gender, dob FROM patients WHERE patient_id = '${patient_id.replace(/'/g, "''")}'`
    );
    if (!pr.rows.length) return null;
    const [pid, full_name, phone, gender, dob] = pr.rows[0];
    return {
      session_id,
      patient: { patient_id: pid, full_name, phone, gender, date_of_birth: dob },
    };
  } catch (e) {
    console.error('[patient_auth] ERROR:', e.message);
    return null;
  }
}

async function logoutPatient(pool, sid) {
  if (!sid) return;
  await pool.query(`DELETE FROM sessions WHERE session_id = '${sid.replace(/'/g, "''")}'`);
}

function patientCookieOpts() {
  return { name: PATIENT_COOKIE, days: 7, httpOnly: true };
}

export { loginPatient, getPatientSession, logoutPatient, patientCookieOpts, PATIENT_COOKIE };
