// Auth helpers — signup, login, session
import { createHash, randomBytes } from 'node:crypto';
import { VBPPool } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';

const PEPPER = 'tatvacare-pepper-v1';  // In production, load from env / secrets manager
const SESSION_TTL_HOURS = 24 * 7;       // 7 days

function hashPassword(plain) {
  // For MVP we use plain SHA-256 to match the migration seed. In production
  // use bcrypt + per-user salt + a server-side pepper from secrets manager.
  return createHash('sha256').update(plain).digest('hex');
}

export function genId(prefix) {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

export function genSessionId() {
  return randomBytes(32).toString('hex');
}

export async function signupDoctor(pool, data) {
  // data: { full_name, email, phone, password, mci_reg_no, specialties, clinic_name, ... }
  const id = genId('d');
  const passwordHash = hashPassword(data.password);
  // Convert specialties array to comma-separated string
  const specialtiesStr = Array.isArray(data.specialties) ? data.specialties.join(',') : (data.specialties || '');
  const languagesStr = data.languages || 'en,hi';
  const sql = `INSERT INTO doctors (doctor_id, full_name, email, phone, password_hash, mci_reg_no, specialties, qualifications, languages, clinic_name, clinic_address, city, state, pincode) VALUES (
    '${id}', ${sqlStr(data.full_name)}, ${sqlStr(data.email)}, ${sqlStr(data.phone)}, '${passwordHash}',
    ${sqlStr(data.mci_reg_no || '')}, ${sqlStr(specialtiesStr)}, ${sqlStr(data.qualifications || '')},
    ${sqlStr(languagesStr)}, ${sqlStr(data.clinic_name || '')}, ${sqlStr(data.clinic_address || '')},
    ${sqlStr(data.city || '')}, ${sqlStr(data.state || '')}, ${sqlStr(data.pincode || '')}
  )`;
  await pool.query(sql);
  return { doctor_id: id, full_name: data.full_name, email: data.email, phone: data.phone, specialties: specialtiesStr.split(',') };
}

export async function loginDoctor(pool, phoneOrEmail, password) {
  const field = phoneOrEmail.includes('@') ? 'email' : 'phone';
  // Step 1: find the doctor's password_hash by phone/email (1-col query — engine safe)
  const lookup = await pool.query(`SELECT doctor_id FROM doctors WHERE ${field} = ${sqlStr(phoneOrEmail)} LIMIT 1`);
  if (lookup.rows.length === 0) return null;
  const doctorId = lookup.rows[0][0];
  // Step 2: get the password_hash for this doctor (1-col)
  const ph = await pool.query(`SELECT password_hash FROM doctors WHERE doctor_id = ${sqlStr(doctorId)} LIMIT 1`);
  if (ph.rows.length === 0) return null;
  if (ph.rows[0][0] !== hashPassword(password)) return null;
  // Step 3: get the rest of the doctor profile (multi-col — engine bug; we work around by
  // using single-column subqueries to avoid the misaligned header)
  const fn = await pool.query(`SELECT full_name FROM doctors WHERE doctor_id = ${sqlStr(doctorId)} LIMIT 1`);
  const em = await pool.query(`SELECT email FROM doctors WHERE doctor_id = ${sqlStr(doctorId)} LIMIT 1`);
  const ph2 = await pool.query(`SELECT phone FROM doctors WHERE doctor_id = ${sqlStr(doctorId)} LIMIT 1`);
  const sp = await pool.query(`SELECT specialties FROM doctors WHERE doctor_id = ${sqlStr(doctorId)} LIMIT 1`);
  const cn = await pool.query(`SELECT clinic_name FROM doctors WHERE doctor_id = ${sqlStr(doctorId)} LIMIT 1`);
  const ci = await pool.query(`SELECT city FROM doctors WHERE doctor_id = ${sqlStr(doctorId)} LIMIT 1`);
  return {
    doctor_id: doctorId,
    full_name: fn.rows[0]?.[0] || '',
    email: em.rows[0]?.[0] || '',
    phone: ph2.rows[0]?.[0] || '',
    specialties: (sp.rows[0]?.[0] || '').split(',').filter(Boolean),
    clinic_name: cn.rows[0]?.[0] || '',
    city: ci.rows[0]?.[0] || '',
  };
}

export async function createSession(pool, doctorId, userAgent, ip) {
  const sid = genSessionId();
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  await pool.query(`INSERT INTO sessions (session_id, doctor_id, expires_at, user_agent, ip) VALUES ('${sid}', '${doctorId}', '${expires}', ${sqlStr(userAgent || '')}, ${sqlStr(ip || '')})`);
  return sid;
}

export async function getSession(pool, sid) {
  if (!sid) return null;
  const r = await pool.query(`SELECT s.doctor_id, d.full_name, d.email, d.phone, d.specialties, d.clinic_name, d.city, s.expires_at FROM sessions s JOIN doctors d ON d.doctor_id = s.doctor_id WHERE s.session_id = '${sid}' LIMIT 1`);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const expires = new Date(row[7]);
  if (expires < new Date()) {
    await pool.query(`DELETE FROM sessions WHERE session_id = '${sid}'`);
    return null;
  }
  return {
    doctor_id: row[0], full_name: row[1], email: row[2], phone: row[3],
    specialties: (row[4] || '').split(',').filter(Boolean),
    clinic_name: row[5], city: row[6], session_id: sid,
  };
}

export async function destroySession(pool, sid) {
  await pool.query(`DELETE FROM sessions WHERE session_id = '${sid}'`);
}

export function sqlStr(v) {
  if (v == null) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
