// TatvaCare server v2 — sidebar layout, full clinical features
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VBPPool } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';
import * as auth from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/auth.mjs';
import * as doc from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/doctor.mjs';
import * as clinical from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/clinical.mjs';
import { generateRxPdf } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/pdf.mjs';
import { ICD10_CODES } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/icd10.mjs';
import { INDIAN_FORMULARY, searchDrugs, getDrugMonograph, drugsForIndication } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/formulary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const pool = new VBPPool('127.0.0.1', 6381, 12);

// ============ HELPERS ============
async function getSession(req) {
  const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  return sid ? auth.getSession(pool, sid) : null;
}
function jsonRes(res, data, status = 200) { res.status(status).json(data); }
function errRes(res, msg, status = 400, code = 'BAD_REQUEST') { res.status(status).json({ error: { code, message: msg } }); }
function setCookie(res, name, value, days = 7) {
  res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}`);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function requireAuth(req, res, next) {
  getSession(req).then(sess => {
    if (!sess) return errRes(res, 'unauthorized', 401, 'UNAUTHORIZED');
    req.session = sess; next();
  }).catch(e => errRes(res, e.message, 500, 'SERVER_ERROR'));
}

// ============ FRONTEND (static) ============
const pages = ['index', 'login', 'signup', 'dashboard', 'patients', 'patient', 'prescribe', 'calendar', 'inbox', 'drugs', 'formulary', 'ai'];
const authPages = ['dashboard', 'patients', 'patient', 'prescribe', 'calendar', 'inbox', 'drugs', 'formulary', 'ai'];
const servePage = async (p, req, res) => {
  if (authPages.includes(p)) {
    const sess = await getSession(req);
    if (!sess) return res.redirect('/login');
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(readFileSync(join(PUBLIC_DIR, p + '.html'), 'utf-8'));
};
pages.forEach(p => {
  app.get('/' + (p === 'index' ? '' : p), (req, res) => servePage(p, req, res));
  if (p !== 'index') {
    app.get('/' + p + '/:id', (req, res) => servePage(p, req, res));
    app.get('/dashboard/' + p, (req, res) => servePage(p, req, res));
    app.get('/dashboard/' + p + '/:id', (req, res) => servePage(p, req, res));
  }
});
app.get('/static/:f', (req, res) => {
  const path = join(PUBLIC_DIR, req.params.f);
  if (!existsSync(path)) return res.status(404).end();
  const ext = req.params.f.split('.').pop();
  const types = { js: 'application/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml', woff2: 'font/woff2' };
  res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
  res.send(readFileSync(path));
});

// ============ AUTH ============
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { full_name, email, phone, password, mci_reg_no, specialties, qualifications, languages, clinic_name, clinic_address, city, state, pincode } = req.body;
    if (!full_name || !email || !phone || !password) return errRes(res, 'full_name, email, phone, password are required');
    if (password.length < 6) return errRes(res, 'password must be at least 6 characters');
    const check = await pool.query(`SELECT doctor_id FROM doctors WHERE email = ${auth.sqlStr(email)} OR phone = ${auth.sqlStr(phone)} LIMIT 1`);
    if (check.rows.length > 0) return errRes(res, 'email or phone already registered', 409, 'CONFLICT');
    const doctor = await auth.signupDoctor(pool, { full_name, email, phone, password, mci_reg_no, specialties, qualifications, languages, clinic_name, clinic_address, city, state, pincode });
    const sid = await auth.createSession(pool, doctor.doctor_id, req.headers['user-agent'], req.ip);
    setCookie(res, 'sid', sid);
    jsonRes(res, { doctor });
  } catch (e) { errRes(res, e.message, 500, 'SERVER_ERROR'); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phoneOrEmail, password } = req.body;
    if (!phoneOrEmail || !password) return errRes(res, 'phoneOrEmail and password are required');
    const doctor = await auth.loginDoctor(pool, phoneOrEmail, password);
    if (!doctor) return errRes(res, 'invalid credentials', 401, 'INVALID_CREDENTIALS');
    const sid = await auth.createSession(pool, doctor.doctor_id, req.headers['user-agent'], req.ip);
    setCookie(res, 'sid', sid);
    jsonRes(res, { doctor });
  } catch (e) { errRes(res, e.message, 500, 'SERVER_ERROR'); }
});
app.post('/api/auth/logout', async (req, res) => {
  const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  if (sid) await auth.destroySession(pool, sid);
  clearCookie(res, 'sid');
  jsonRes(res, { ok: true });
});
app.get('/api/auth/me', requireAuth, (req, res) => { jsonRes(res, { doctor: req.session }); });

// ============ DASHBOARD ============
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try { const stats = await doc.getDashboardStats(pool, req.session.doctor_id); jsonRes(res, { stats }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.get('/api/dashboard/today', requireAuth, async (req, res) => {
  try {
    const today = await clinical.getTodaySchedule(pool, req.session.doctor_id);
    const tasks = await clinical.listTasks(pool, req.session.doctor_id, 'open');
    const alerts = tasks.filter(t => t.priority === 'high' || t.priority === 'urgent');
    jsonRes(res, { today, tasks: tasks.slice(0, 5), alerts });
  } catch (e) { errRes(res, e.message, 500); }
});

// ============ PATIENTS ============
app.get('/api/patients', requireAuth, async (req, res) => {
  try {
    const q = req.query.q;
    const patients = q ? await doc.searchPatients(pool, String(q)) : await doc.listPatients(pool, req.session.doctor_id);
    jsonRes(res, { patients });
  } catch (e) { errRes(res, e.message, 500); }
});
app.post('/api/patients', requireAuth, async (req, res) => {
  try {
    const { full_name, phone } = req.body;
    if (!full_name || !phone) return errRes(res, 'full_name and phone are required');
    const p = await doc.createPatient(pool, req.body, req.session.doctor_id);
    jsonRes(res, { patient: p }, 201);
  } catch (e) { errRes(res, e.message, 500); }
});
app.get('/api/patients/:id', requireAuth, async (req, res) => {
  try { const p = await clinical.getPatientChart(pool, req.params.id); if (!p) return errRes(res, 'not found', 404); jsonRes(res, { patient: p }); }
  catch (e) { errRes(res, e.message, 500); }
});

// ============ APPOINTMENTS ============
app.get('/api/appointments', requireAuth, async (req, res) => {
  try { const appts = await doc.listAppointments(pool, req.session.doctor_id, req.query.date); jsonRes(res, { appointments: appts }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.get('/api/schedule/today', requireAuth, async (req, res) => {
  try { const today = await clinical.getTodaySchedule(pool, req.session.doctor_id); jsonRes(res, { today }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.get('/api/schedule/week', requireAuth, async (req, res) => {
  try { const week = await clinical.getWeekSchedule(pool, req.session.doctor_id); jsonRes(res, { week }); }
  catch (e) { errRes(res, e.message, 500); }
});

// ============ PRESCRIPTIONS ============
app.get('/api/prescriptions', requireAuth, async (req, res) => {
  try { const rxs = await doc.listPrescriptions(pool, req.session.doctor_id, req.query.patient_id); jsonRes(res, { prescriptions: rxs }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.get('/api/prescriptions/:id', requireAuth, async (req, res) => {
  try { const rx = await doc.getPrescription(pool, req.params.id); if (!rx) return errRes(res, 'not found', 404); if (rx.doctor_id !== req.session.doctor_id) return errRes(res, 'forbidden', 403); jsonRes(res, { prescription: rx }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.post('/api/prescriptions', requireAuth, async (req, res) => {
  try {
    const { patient_id, rx_items, diagnosis_code } = req.body;
    if (!patient_id) return errRes(res, 'patient_id is required');
    if (!diagnosis_code) return errRes(res, 'diagnosis_code is required');
    if (!Array.isArray(rx_items) || rx_items.length === 0) return errRes(res, 'rx_items must be non-empty array');
    const rx = await doc.createPrescription(pool, req.body, req.session.doctor_id);
    jsonRes(res, { prescription: rx }, 201);
  } catch (e) { errRes(res, e.message, 500); }
});

// ============ DRUGS / INTERACTIONS ============
app.get('/api/drugs/search', requireAuth, async (req, res) => {
  try { const q = String(req.query.q || '').trim(); const drugs = await clinical.searchDrugs(pool, q); jsonRes(res, { drugs }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.post('/api/drugs/check-interactions', requireAuth, async (req, res) => {
  try { const drugs = req.body.drugs || []; const interactions = await clinical.checkInteractions(pool, drugs); jsonRes(res, { interactions }); }
  catch (e) { errRes(res, e.message, 500); }
});

// ============ VITALS ============
app.get('/api/patients/:id/vitals', requireAuth, async (req, res) => {
  try { const vitals = await clinical.listVitals(pool, req.params.id, req.query.type); jsonRes(res, { vitals }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.post('/api/vitals', requireAuth, async (req, res) => {
  try {
    if (!req.body.patient_id) return errRes(res, 'patient_id required');
    const v = await clinical.createVital(pool, { ...req.body, recorded_by: req.session.doctor_id });
    jsonRes(res, { vital: v }, 201);
  } catch (e) { errRes(res, e.message, 500); }
});

// ============ TASKS / INBOX ============
app.get('/api/tasks', requireAuth, async (req, res) => {
  try { const tasks = await clinical.listTasks(pool, req.session.doctor_id, req.query.status); jsonRes(res, { tasks }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.post('/api/tasks/:id/complete', requireAuth, async (req, res) => {
  try { await clinical.completeTask(pool, req.params.id); jsonRes(res, { ok: true }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.post('/api/tasks/:id/dismiss', requireAuth, async (req, res) => {
  try { await clinical.dismissTask(pool, req.params.id); jsonRes(res, { ok: true }); }
  catch (e) { errRes(res, e.message, 500); }
});

// ============ ICD-10 SEARCH ============
app.get('/api/icd10/search', requireAuth, (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    if (q.length < 1) return jsonRes(res, { codes: ICD10_CODES.slice(0, 30) });
    const matches = ICD10_CODES.filter(c =>
      c.code.toLowerCase().includes(q) ||
      c.label.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q)
    ).slice(0, 30);
    jsonRes(res, { codes: matches });
  } catch (e) { errRes(res, e.message, 500); }
});

// ============ INDIAN FORMULARY (drug monographs + reverse index) ============
app.get('/api/formulary/search', requireAuth, (req, res) => {
  try {
    const q = String(req.query.q || '');
    const drugs = searchDrugs(q);
    jsonRes(res, { drugs });
  } catch (e) { errRes(res, e.message, 500); }
});
app.get('/api/formulary/drug/:name', requireAuth, (req, res) => {
  try {
    const drug = getDrugMonograph(req.params.name);
    if (!drug) return errRes(res, 'not found', 404);
    jsonRes(res, { drug });
  } catch (e) { errRes(res, e.message, 500); }
});
app.get('/api/formulary/for-indication', requireAuth, (req, res) => {
  try {
    const q = String(req.query.q || '');
    const drugs = drugsForIndication(q);
    jsonRes(res, { drugs });
  } catch (e) { errRes(res, e.message, 500); }
});

// ============ PATIENT NOTES ============
app.get('/api/patients/:id/notes', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT note_id, patient_id, doctor_id, note_type, body, is_pinned, created_at, updated_at FROM patient_notes WHERE patient_id = ${doc.sqlStr ? doc.sqlStr(req.params.id) : `'${req.params.id.replace(/'/g, "''")}'`} ORDER BY is_pinned DESC, created_at DESC`);
    const notes = (r.rows || []).map(row => ({
      note_id: row[0], patient_id: row[1], doctor_id: row[2],
      note_type: row[3] && row[3] !== 'NULL' ? row[3] : 'clinical',
      body: row[4] && row[4] !== 'NULL' ? row[4] : '',
      is_pinned: row[5] === '1' || row[5] === 1,
      created_at: row[6] && row[6] !== 'NULL' ? row[6] : null,
      updated_at: row[7] && row[7] !== 'NULL' ? row[7] : null,
    }));
    jsonRes(res, { notes });
  } catch (e) { errRes(res, e.message, 500); }
});
app.post('/api/patients/:id/notes', requireAuth, async (req, res) => {
  try {
    const { note_type, body, is_pinned } = req.body;
    if (!body) return errRes(res, 'body required');
    const note_id = 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const q = `INSERT INTO patient_notes (note_id, patient_id, doctor_id, note_type, body, is_pinned, created_at, updated_at) VALUES ('${note_id}', '${req.params.id.replace(/'/g, "''")}', '${req.session.doctor_id}', '${(note_type || 'clinical').replace(/'/g, "''")}', ${doc.sqlStr ? doc.sqlStr(body) : `'${body.replace(/'/g, "''")}'`}, '${is_pinned ? '1' : '0'}', '${now}', '${now}')`;
    await pool.query(q);
    jsonRes(res, { note: { note_id, patient_id: req.params.id, doctor_id: req.session.doctor_id, note_type: note_type || 'clinical', body, is_pinned: !!is_pinned, created_at: now, updated_at: now } }, 201);
  } catch (e) { errRes(res, e.message, 500); }
});
app.delete('/api/patients/:pid/notes/:nid', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM patient_notes WHERE note_id = '${req.params.nid.replace(/'/g, "''")}' AND doctor_id = '${req.session.doctor_id}'`);
    jsonRes(res, { ok: true });
  } catch (e) { errRes(res, e.message, 500); }
});

// ============ PDF PRESCRIPTION EXPORT ============
app.get('/api/prescriptions/:id/pdf', requireAuth, async (req, res) => {
  try {
    const rx = await doc.getPrescription(pool, req.params.id);
    if (!rx) return errRes(res, 'not found', 404);
    if (rx.doctor_id !== req.session.doctor_id) return errRes(res, 'forbidden', 403);
    const patient = await doc.getPatient(pool, rx.patient_id);
    if (!patient) return errRes(res, 'patient not found', 404);
    const fullDoctor = await doc.getDoctor(pool, req.session.doctor_id);
    if (!fullDoctor) return errRes(res, 'doctor not found', 404);
    const pdfBuffer = await generateRxPdf(pool, rx, fullDoctor, patient);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${rx.rx_number}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (e) { errRes(res, e.message, 500); }
});

// ============ HEALTH ============
app.get('/api/health', async (req, res) => {
  try { const pong = await pool.query('SELECT 1 AS ok'); const r = pong.rows[0]?.[0]; jsonRes(res, { status: r === '1' ? 'ok' : 'degraded', vbp: '127.0.0.1:6381' }); }
  catch (e) { errRes(res, e.message, 500, 'VBP_DOWN'); }
});

// ============ AI SERVICE PROXY (Python FastAPI on :7100) ============
const AI_URL = process.env.AI_URL || 'http://127.0.0.1:7100';

// OCR
app.post('/api/ai/ocr/prescription', requireAuth, async (req, res) => {
  try {
    const { image } = req.body; // base64 data URL or raw base64
    if (!image) return errRes(res, 'image required');
    const b64 = image.replace(/^data:image\/\w+;base64,/, '');
    const r = await fetch(`${AI_URL}/ocr/prescription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64 }),
    });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

app.post('/api/ai/ocr/lab-report', requireAuth, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return errRes(res, 'image required');
    const b64 = image.replace(/^data:image\/\w+;base64,/, '');
    const r = await fetch(`${AI_URL}/ocr/lab-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64 }),
    });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

// NLP — extract entities / suggest ICD-10
app.post('/api/ai/nlp/entities', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    const r = await fetch(`${AI_URL}/nlp/extract-entities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text || '' }),
    });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

app.post('/api/ai/nlp/icd10', requireAuth, async (req, res) => {
  try {
    const { text, top_k } = req.body;
    const r = await fetch(`${AI_URL}/nlp/suggest-icd10`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text || '', top_k: top_k || 5 }),
    });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

// Voice — proxy multipart
import('node:buffer').then(() => {});

app.post('/api/ai/voice/transcribe', requireAuth, async (req, res) => {
  try {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart/form-data')) return errRes(res, 'multipart/form-data required');
    // Forward the raw body as multipart to AI service
    const r = await fetch(`${AI_URL}/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': ct },
      body: req,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.send(buf);
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

// ML — risk / anomaly / forecast
app.post('/api/ai/ml/risk', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${AI_URL}/ml/risk`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patient_id: req.body.patient_id }),
    });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

app.post('/api/ai/ml/anomaly', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${AI_URL}/ml/anomaly`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patient_id: req.body.patient_id, metric: req.body.metric || 'systolic' }),
    });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

app.post('/api/ai/ml/forecast', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${AI_URL}/ml/forecast`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_id: req.body.patient_id,
        metric: req.body.metric || 'systolic',
        horizon_days: req.body.horizon_days || 7,
      }),
    });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

// Agents
app.post('/api/ai/agents/run', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${AI_URL}/agents/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

app.get('/api/ai/agents/activity', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${AI_URL}/agents/activity?limit=${parseInt(req.query.limit) || 20}`);
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

app.get('/api/ai/agents/list', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${AI_URL}/agents/list`);
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

// DL — ECG + retinopathy
app.post('/api/ai/dl/ecg', requireAuth, async (req, res) => {
  try {
    const ct = req.headers['content-type'] || '';
    const r = await fetch(`${AI_URL}/dl/ecg/classify`, {
      method: 'POST', headers: { 'Content-Type': ct }, body: req,
    });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

app.post('/api/ai/dl/retinopathy', requireAuth, async (req, res) => {
  try {
    const ct = req.headers['content-type'] || '';
    const r = await fetch(`${AI_URL}/dl/retinopathy/screen`, {
      method: 'POST', headers: { 'Content-Type': ct }, body: req,
    });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + e.message, 502); }
});

// AI service status
app.get('/api/ai/status', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${AI_URL}/health`, { signal: AbortSignal.timeout(2000) });
    jsonRes(res, await r.json());
  } catch (e) {
    jsonRes(res, { status: 'down', error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[tatvacare] listening on http://127.0.0.1:${PORT}`);
  console.log(`[tatvacare] VBP pool → 127.0.0.1:6381 (12 conns max)`);
  console.log(`[tatvacare] PG-wire: NOT USED (per user policy)`);
});
process.on('SIGINT', async () => { await pool.closeAll(); process.exit(0); });
process.on('SIGTERM', async () => { await pool.closeAll(); process.exit(0); });
