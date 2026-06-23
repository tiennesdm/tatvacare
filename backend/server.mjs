// TatvaCare server v4 — production-readiness pass (P0..P2).
//
// What's new in v4 (see todo list in PR description for the full list):
//   - Centralised config (lib/config.mjs) with boot-time validation.
//   - Structured JSON logger with request-id propagation (lib/logger.mjs).
//   - Prometheus text-format /metrics endpoint (lib/metrics.mjs).
//   - /readyz endpoint separate from /api/health (liveness vs readiness).
//   - AI service calls wrapped in AbortSignal.timeout + circuit breaker
//     (lib/circuit.mjs) so a hung Python process can't pile up Node fetches.
//   - Shared-secret service-to-service auth on every AI call (lib/ai_auth.mjs).
//   - Graceful shutdown coordinator (lib/shutdown.mjs) handles SIGTERM
//     (not just SIGINT) and drains in-flight requests before closing the
//     VBP pool.
//   - Zod-style body validation on critical write routes (lib/validate.mjs).
//   - HIPAA §164.312(b) PHI access logger (lib/phi_access.mjs) writes every
//     patient resource read/write to phi_access_log.

import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VBPPool } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';
import * as auth from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/auth.mjs';
import * as doc from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/doctor.mjs';
import * as clinical from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/clinical.mjs';
import { generateRxPdf } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/pdf.mjs';
import { ICD10_CODES } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/icd10.mjs';
import { INDIAN_FORMULARY, searchDrugs, getDrugMonograph, drugsForIndication } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/formulary.mjs';
import * as patientAuth from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/patient_auth.mjs';
import { audit } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/audit.mjs';
import { llmComplete, logUsage, isEnabled as llmEnabled, formatPatientContext } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/llm.mjs';
import { augmentPrompt, retrieve as ragRetrieve } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/rag.mjs';
import * as i18n from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/i18n.mjs';
import * as remindersLib from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/reminders.mjs';

import { config, logBootBanner } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/config.mjs';
import { logger, accessLogMiddleware, errorLogMiddleware } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/logger.mjs';
import { registry as metrics, renderMetrics, metricsMiddleware } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/metrics.mjs';
import { aiBreaker, CircuitOpenError } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/circuit.mjs';
import { buildServiceKeyHeader } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/ai_auth.mjs';
import { ShutdownCoordinator } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/shutdown.mjs';
import { phiAccessLogger, markPhiAccess } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/phi_access.mjs';
import { validateBody, validateQuery, schemas } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/validate.mjs';

// ============ SECURITY MIDDLEWARE (E1 rate limit, E2 helmet, E4 sanitize) ============
import {
  buildHelmet,
  buildRateLimiters,
  sanitizeMiddleware,
  newCsrfSecret,
  setCsrfCookie,
  requireCsrf,
  csrfTokenFor,
} from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/security/index.mjs';

// ============ BOOT BANNER (before Express so deploy logs catch it) ============
logBootBanner();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const app = express();

// ============ OBSERVABILITY (must run FIRST so every request gets a request-id) ============
// Generates x-request-id, propagates it via AsyncLocalStorage, logs a single
// JSON access line per request on res.finish. Errors caught here are logged
// and turned into a generic 500 — they don't leak stack traces to clients.
app.use(accessLogMiddleware());

// E2 — Security headers first (before everything else; helmet sets CSP, HSTS,
// X-Frame-Options, Referrer-Policy, COOP, X-Content-Type-Options, hides
// X-Powered-By, etc.). See lib/security/headers.mjs for per-directive rationale.
app.use(buildHelmet());

// Body parsers
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// E4 — Input sanitization (must run AFTER body parsers, BEFORE handlers).
// Strips disallowed HTML from whitelisted free-text fields in req.body
// (notes, advice, allergies, rx_instructions, body, message, title, etc.)
// and 400s on obvious XSS payloads (<script>, javascript:, on*=).
app.use(sanitizeMiddleware());

// E1 — Rate limiters (per-route-class). In-memory MemoryStore for now;
// swap to rate-limit-redis when we go multi-process. See
// lib/security/rate-limit.mjs for the swap point.
const rateLimits = buildRateLimiters();
// Auth:    /api/auth/*           →  5 req / 15 min / IP
// AI:      /api/ai/*             → 30 req / min / IP
// Vitals:  POST /api/vitals      → 60 req / min / IP  (writes only)
// Default: everything else       → 120 req / min / IP
app.use('/api/auth', rateLimits.auth);
app.use('/api/ai', rateLimits.ai);
// Default limiter covers everything else under /api/* that doesn't have
// a stricter limiter. It also runs for /api/auth/* and /api/ai/* but
// with a wider window (120/min vs 5/15min or 30/min), so the tighter
// per-class limit always wins. Static pages and /patient/* pages are
// NOT rate-limited (they don't go through /api/*).
app.use('/api', rateLimits.default);
// vitals write limiter is applied per-route below (POST /api/vitals only).

// Metrics — per-request http_requests_total + http_request_duration_seconds.
// Mounted after routing (it's app.use, but req.route is only populated by
// the router when the response finishes), so the labels work correctly.
app.use(metricsMiddleware());

const pool = new VBPPool(config.VBP_HOST, config.VBP_PORT, config.VBP_POOL_MAX);
// Inject pool into metrics so /metrics can show vbp_pool_* gauges.
globalThis.__tatvacare_metrics_deps = { pool };

// HIPAA §164.312(b) — every patient-resource read/write goes here.
// MUST be registered AFTER `const pool = ...` (the PHI logger needs pool
// to insert rows; ES module const declarations don't hoist). Registering
// before the const was a ReferenceError that took down the whole server.
app.use(phiAccessLogger(pool));

// ============ CSRF SECRET STORE ============
// In-memory Map keyed by session id. Single-process Node so this is fine;
// for multi-process / multi-host swap to Redis (see lib/security/csrf.mjs).
// Keyed by EITHER a doctor sid OR a patient sid (they share the same
// sessions table).
const csrfSecrets = new Map();
function bindCsrfToSession(sid, secret = newCsrfSecret()) {
  csrfSecrets.set(sid, secret);
  return secret;
}
function clearCsrfForSession(sid) {
  if (sid) csrfSecrets.delete(sid);
}
function lookupCsrfSecret(sid) {
  return sid ? csrfSecrets.get(sid) || null : null;
}

// ============ HELPERS ============
async function getSession(req) {
  const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  if (!sid) return null;
  const sess = await auth.getSession(pool, sid);
  if (!sess) return null;
  // Attach CSRF secret so requireCsrf can verify without a second lookup.
  sess.csrfSecret = lookupCsrfSecret(sid);
  return sess;
}
async function getPatientSession(req) {
  const sid = req.headers.cookie?.match(/pid=([^;]+)/)?.[1];
  if (!sid) return null;
  const sess = await patientAuth.getPatientSession(pool, sid);
  if (!sess) return null;
  sess.csrfSecret = lookupCsrfSecret(sid);
  return sess;
}
function jsonRes(res, data, status = 200) { res.status(status).json(data); }
function errRes(res, msg, status = 400, code = 'BAD_REQUEST') { res.status(status).json({ error: { code, message: msg } }); }
function setCookie(res, name, value, days = 7) {
  // Append (not setHeader) so we can stack multiple Set-Cookie headers
  // on the same response (e.g. sid + csrf_token on /api/auth/login).
  res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}`);
}
function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function requireAuth(req, res, next) {
  getSession(req).then(sess => {
    if (!sess) return errRes(res, 'unauthorized', 401, 'UNAUTHORIZED');
    req.session = sess; next();
  }).catch(e => errRes(res, e.message, 500, 'SERVER_ERROR'));
}
// E3 — Chain requireAuth + requireCsrf for state-changing routes that need
// a doctor session. requireAuth populates req.session (incl. csrfSecret);
// requireCsrf then verifies the supplied token against it.
function requireAuthCsrf(req, res, next) {
  requireAuth(req, res, () => requireCsrf(req, res, next));
}
function requirePatientAuthCsrf(req, res, next) {
  requirePatientAuth(req, res, () => requireCsrf(req, res, next));
}

// ============ FRONTEND (static) ============
const pages = ['index', 'login', 'signup', 'dashboard', 'patients', 'patient', 'prescribe', 'calendar', 'inbox', 'drugs', 'formulary', 'ai', 'analytics', 'reminders', 'telemedicine', 'audit', 'clinic'];
const authPages = ['dashboard', 'patients', 'patient', 'prescribe', 'calendar', 'inbox', 'drugs', 'formulary', 'ai', 'analytics', 'reminders', 'telemedicine', 'audit'];
const patientPages = ['patient/login', 'patient/home', 'patient/log-vitals', 'patient/telemedicine'];

// Register patient pages directly (before generic routes catch them)
patientPages.forEach(p => {
  app.get('/' + p.replace(/^patient\//, 'patient/'), (req, res) => servePage(p, req, res));
});
// /patient itself → patient/login (the entry)
app.get('/patient', (req, res) => res.redirect('/patient/login'));
const servePage = async (p, req, res) => {
  // Patient pages are public (patient logs in via /api/patient/auth/login)
  if (patientPages.includes(p)) {
    res.setHeader('Content-Type', 'text/html');
    const file = join(PUBLIC_DIR, p + '.html');
    if (existsSync(file)) {
      return res.send(readFileSync(file));
    }
    return res.status(404).send('Patient page not found');
  }
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
    const csrfSecret = bindCsrfToSession(sid);
    setCookie(res, 'sid', sid);
    const csrfToken = setCsrfCookie(res, csrfSecret);
    jsonRes(res, { doctor, csrfToken });
  } catch (e) { errRes(res, e.message, 500, 'SERVER_ERROR'); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phoneOrEmail, password } = req.body;
    if (!phoneOrEmail || !password) return errRes(res, 'phoneOrEmail and password are required');
    const doctor = await auth.loginDoctor(pool, phoneOrEmail, password);
    if (!doctor) return errRes(res, 'invalid credentials', 401, 'INVALID_CREDENTIALS');
    const sid = await auth.createSession(pool, doctor.doctor_id, req.headers['user-agent'], req.ip);
    const csrfSecret = bindCsrfToSession(sid);
    setCookie(res, 'sid', sid);
    // Use the SAME token that setCsrfCookie put in the cookie for the body —
    // csrfTokenFor() generates a fresh token (different salt) so the cookie
    // and body would disagree and the double-submit check would always 403.
    const csrfToken = setCsrfCookie(res, csrfSecret);
    jsonRes(res, { doctor, csrfToken });
  } catch (e) { errRes(res, e.message, 500, 'SERVER_ERROR'); }
});
app.post('/api/auth/logout', requireAuthCsrf, async (req, res) => {
  const sid = req.session?.session_id || req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  if (sid) {
    await auth.destroySession(pool, sid);
    clearCsrfForSession(sid);
  }
  clearCookie(res, 'sid');
  // Clear the CSRF cookie too.
  res.append('Set-Cookie', `csrf_token=; Path=/; SameSite=Lax; Max-Age=0`);
  jsonRes(res, { ok: true });
});
app.get('/api/auth/me', requireAuth, (req, res) => {
  jsonRes(res, {
    doctor: req.session,
    csrfToken: req.session?.csrfSecret ? csrfTokenFor(req.session.csrfSecret) : null,
  });
});

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
app.post('/api/patients', requireAuthCsrf, async (req, res) => {
  try {
    const { full_name, phone } = req.body;
    if (!full_name || !phone) return errRes(res, 'full_name and phone are required');
    const p = await doc.createPatient(pool, req.body, req.session.doctor_id);
    jsonRes(res, { patient: p }, 201);
  } catch (e) { errRes(res, e.message, 500); }
});
app.get('/api/patients/:id', requireAuth, async (req, res) => {
  markPhiAccess(req, { action: 'read', resource_kind: 'patient', resource_id: req.params.id, patient_id: req.params.id });
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
  try {
    const rx = await doc.getPrescription(pool, req.params.id);
    if (!rx) return errRes(res, 'not found', 404);
    if (rx.doctor_id !== req.session.doctor_id) return errRes(res, 'forbidden', 403);
    markPhiAccess(req, { action: 'read', resource_kind: 'prescription', resource_id: req.params.id, patient_id: rx.patient_id });
    jsonRes(res, { prescription: rx });
  } catch (e) { errRes(res, e.message, 500); }
});
app.post('/api/prescriptions', requireAuthCsrf, async (req, res) => {
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
app.post('/api/drugs/check-interactions', requireAuthCsrf, async (req, res) => {
  try { const drugs = req.body.drugs || []; const interactions = await clinical.checkInteractions(pool, drugs); jsonRes(res, { interactions }); }
  catch (e) { errRes(res, e.message, 500); }
});

// ============ VITALS ============
app.get('/api/patients/:id/vitals', requireAuth, async (req, res) => {
  markPhiAccess(req, { action: 'read', resource_kind: 'patient_vitals_log', patient_id: req.params.id });
  try { const vitals = await clinical.listVitals(pool, req.params.id, req.query.type); jsonRes(res, { vitals }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.post('/api/vitals', rateLimits.vitalsWrite, requireAuthCsrf, async (req, res) => {
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
app.post('/api/tasks/:id/complete', requireAuthCsrf, async (req, res) => {
  try { await clinical.completeTask(pool, req.params.id); jsonRes(res, { ok: true }); }
  catch (e) { errRes(res, e.message, 500); }
});
app.post('/api/tasks/:id/dismiss', requireAuthCsrf, async (req, res) => {
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
  markPhiAccess(req, { action: 'read', resource_kind: 'patient_notes', patient_id: req.params.id });
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
app.post('/api/patients/:id/notes', requireAuthCsrf, async (req, res) => {
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
app.delete('/api/patients/:pid/notes/:nid', requireAuthCsrf, async (req, res) => {
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
    markPhiAccess(req, { action: 'export', resource_kind: 'prescription_pdf', resource_id: req.params.id, patient_id: rx.patient_id });
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
// /api/health     — liveness. Returns 200 if the process is alive and can
//                   reach Vedadb. Cheap (SELECT 1). Used by Docker HEALTHCHECK
//                   and by load balancers for "is this process responding".
// /readyz         — readiness. Returns 200 only if (a) Vedadb is reachable,
//                   (b) AI service is reachable (or breaker is half-open),
//                   (c) shutdown is NOT in progress. Used by k8s readiness
//                   probe so traffic stops arriving BEFORE we close the
//                   pool. Returns 503 during graceful shutdown.
// /metrics        — Prometheus text exposition. NOT authenticated by design
//                   (cluster-internal scrape). Restrict via network policy
//                   in production.
let shuttingDown = false;
app.get('/api/health', async (req, res) => {
  try {
    const pong = await pool.query('SELECT 1 AS ok');
    const r = pong.rows[0]?.[0];
    jsonRes(res, {
      status: r === '1' ? 'ok' : 'degraded',
      vbp: `${config.VBP_HOST}:${config.VBP_PORT}`,
      pool: pool._stats(),
      uptime_seconds: Math.floor(process.uptime()),
    });
  } catch (e) {
    res.status(503).json({ status: 'unhealthy', vbp: 'down', error: e.message });
  }
});

app.get('/readyz', async (req, res) => {
  if (shuttingDown) return res.status(503).json({ ready: false, reason: 'shutting_down' });
  const checks = { vbp: 'unknown', ai: 'unknown' };
  let ready = true;
  try {
    const pong = await pool.query('SELECT 1 AS ok');
    checks.vbp = pong.rows[0]?.[0] === '1' ? 'ok' : 'degraded';
    if (checks.vbp !== 'ok') ready = false;
  } catch (e) {
    checks.vbp = 'down';
    ready = false;
  }
  // AI check is best-effort; the breaker itself is enough signal in prod.
  if (aiBreaker.state === 'OPEN') {
    checks.ai = 'circuit_open';
    // Don't mark not-ready on AI breaker — many endpoints don't need AI.
    // If you want stricter readiness, flip this to `ready = false`.
  } else {
    try {
      const r = await fetch(`${AI_URL}/health`, { signal: AbortSignal.timeout(2000) });
      checks.ai = r.ok ? 'ok' : `http_${r.status}`;
    } catch (e) {
      checks.ai = 'down';
    }
  }
  res.status(ready ? 200 : 503).json({ ready, checks, circuit: aiBreaker.snapshot() });
});

if (config.METRICS_ENABLED) {
  app.get('/metrics', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(renderMetrics());
  });
}

// ============ AI SERVICE PROXY (Python FastAPI on :7100) ============
// Every AI call goes through aiFetch() which:
//   - signs the request with X-Service-Key + X-Service-Nonce (lib/ai_auth)
//   - enforces a hard timeout via AbortSignal.timeout(config.AI_FETCH_TIMEOUT_MS)
//   - runs through the circuit breaker (lib/circuit.mjs)
//   - emits a metrics counter per (endpoint, outcome)
const AI_URL = config.AI_URL;
async function aiFetch(aiPath, init = {}) {
  const endpoint = aiPath.replace(/\?.*$/, '').replace(/[^a-z0-9]+/gi, '_') || 'unknown';
  const headers = {
    'Content-Type': 'application/json',
    ...buildServiceKeyHeader(config.AI_SERVICE_KEY),
    ...(init.headers || {}),
  };
  // When init.body is a stream (req itself for multipart), don't pre-stringify.
  const initWithTimeout = { ...init, headers, signal: init.signal || AbortSignal.timeout(config.AI_FETCH_TIMEOUT_MS) };
  return aiBreaker.exec(async () => {
    let r;
    try {
      r = await fetch(`${AI_URL}${aiPath}`, initWithTimeout);
    } catch (e) {
      const outcome = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network_error';
      metrics.aiCalls.inc({ endpoint, outcome });
      throw e;
    }
    if (r.status >= 500) {
      metrics.aiCalls.inc({ endpoint, outcome: '5xx' });
      const err = new Error(`AI ${endpoint} ${r.status}`);
      err.status = r.status;
      throw err;
    }
    if (!r.ok) {
      metrics.aiCalls.inc({ endpoint, outcome: '4xx' });
    } else {
      metrics.aiCalls.inc({ endpoint, outcome: 'ok' });
    }
    return r;
  }).catch((e) => {
    if (e instanceof CircuitOpenError) {
      // Convert breaker-open into a clean 503 the client can retry.
      const err = new Error('AI service temporarily unavailable');
      err.status = 503;
      err.code = 'AI_CIRCUIT_OPEN';
      throw err;
    }
    throw e;
  });
}

// OCR
app.post('/api/ai/ocr/prescription', requireAuthCsrf, async (req, res) => {
  try {
    const { image } = req.body; // base64 data URL or raw base64
    if (!image) return errRes(res, 'image required');
    const b64 = image.replace(/^data:image\/\w+;base64,/, '');
    const r = await aiFetch('/ocr/prescription', { method: 'POST', body: JSON.stringify({ image: b64 }) });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

app.post('/api/ai/ocr/lab-report', requireAuthCsrf, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return errRes(res, 'image required');
    const b64 = image.replace(/^data:image\/\w+;base64,/, '');
    const r = await aiFetch('/ocr/lab-report', { method: 'POST', body: JSON.stringify({ image: b64 }) });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

// NLP — extract entities / suggest ICD-10
app.post('/api/ai/nlp/entities', requireAuthCsrf, async (req, res) => {
  try {
    const { text } = req.body;
    const r = await aiFetch('/nlp/extract-entities', { method: 'POST', body: JSON.stringify({ text: text || '' }) });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

app.post('/api/ai/nlp/icd10', requireAuthCsrf, async (req, res) => {
  try {
    const { text, top_k } = req.body;
    const r = await aiFetch('/nlp/suggest-icd10', { method: 'POST', body: JSON.stringify({ text: text || '', top_k: top_k || 5 }) });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

// Voice — proxy multipart. Forward raw stream; aiFetch passes through signal.
app.post('/api/ai/voice/transcribe', requireAuthCsrf, async (req, res) => {
  try {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart/form-data')) return errRes(res, 'multipart/form-data required');
    const r = await aiFetch('/voice/transcribe', { method: 'POST', headers: { 'Content-Type': ct }, body: req });
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.send(buf);
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

// ML — risk / anomaly / forecast
app.post('/api/ai/ml/risk', requireAuthCsrf, async (req, res) => {
  try {
    const r = await aiFetch('/ml/risk', { method: 'POST', body: JSON.stringify({ patient_id: req.body.patient_id }) });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

app.post('/api/ai/ml/anomaly', requireAuthCsrf, async (req, res) => {
  try {
    const r = await aiFetch('/ml/anomaly', { method: 'POST', body: JSON.stringify({ patient_id: req.body.patient_id, metric: req.body.metric || 'systolic' }) });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

app.post('/api/ai/ml/forecast', requireAuthCsrf, validateBody(schemas.mlForecast), async (req, res) => {
  try {
    const r = await aiFetch('/ml/forecast', {
      method: 'POST',
      body: JSON.stringify({
        patient_id: req.body.patient_id,
        metric: req.body.metric || 'systolic',
        horizon_days: req.body.horizon_days || 7,
      }),
    });
    markPhiAccess(req, { action: 'read', resource_kind: 'ml_forecast', patient_id: req.body.patient_id });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

// Agents
app.post('/api/ai/agents/run', requireAuthCsrf, async (req, res) => {
  try {
    const r = await aiFetch('/agents/run', { method: 'POST', body: JSON.stringify(req.body) });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

app.get('/api/ai/agents/activity', requireAuth, async (req, res) => {
  try {
    const r = await aiFetch(`/agents/activity?limit=${parseInt(req.query.limit) || 20}`);
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

app.get('/api/ai/agents/list', requireAuth, async (req, res) => {
  try {
    const r = await aiFetch('/agents/list');
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

// DL — ECG + retinopathy (binary upload)
app.post('/api/ai/dl/ecg', requireAuthCsrf, async (req, res) => {
  try {
    const ct = req.headers['content-type'] || '';
    const r = await aiFetch('/dl/ecg/classify', { method: 'POST', headers: { 'Content-Type': ct }, body: req });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

app.post('/api/ai/dl/retinopathy', requireAuthCsrf, async (req, res) => {
  try {
    const ct = req.headers['content-type'] || '';
    const r = await aiFetch('/dl/retinopathy/screen', { method: 'POST', headers: { 'Content-Type': ct }, body: req });
    jsonRes(res, await r.json());
  } catch (e) { errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR'); }
});

// ============ CLINICS (multi-tenancy) ============
app.get('/api/clinics', requireAuth, async (req, res) => {
  const r = await pool.query(`SELECT clinic_id, name, city, address, phone, abha_facility_id, created_at FROM clinics`);
  jsonRes(res, { clinics: r.rows.map(row => ({
    clinic_id: row[0], name: row[1], city: row[2], address: row[3], phone: row[4], abha_facility_id: row[5], created_at: row[6],
  })) });
});

app.get('/api/clinics/:id/doctors', requireAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT doctor_id, full_name, email, primary_specialty, clinic_id FROM doctors WHERE clinic_id = '${req.params.id.replace(/'/g, "''")}'`
  );
  jsonRes(res, { doctors: r.rows.map(row => ({
    doctor_id: row[0], full_name: row[1], email: row[2], primary_specialty: row[3], clinic_id: row[4],
  })) });
});

// AI service status — single canonical route (the previous file had this
// route defined twice; second definition was unreachable).
app.get('/api/ai/status', requireAuth, async (req, res) => {
  try {
    const r = await aiFetch('/health', { method: 'GET' });
    jsonRes(res, await r.json());
  } catch (e) {
    jsonRes(res, { status: 'down', error: e.message, circuit: aiBreaker.snapshot() });
  }
});

// ============ PATIENT PORTAL ============
// Patient auth middleware — pulls the pid cookie, validates the session row,
// and attaches the patient profile + csrfSecret to req.patientSession. The
// csrfSecret comes from the in-memory Map populated by patient login (see
// /api/patient/auth/login) — without it requirePatientAuthCsrf cannot verify
// the x-csrf-token header on subsequent POSTs. (Bug fix: earlier version
// omitted this attachment, causing every patient POST to 401 with
// 'no session for CSRF check'.)
const requirePatientAuth = async (req, res, next) => {
  // Delegate to getPatientSession (helpers block) so csrfSecret is attached
  // — requiredPatientAuthCsrf checks req.patientSession.csrfSecret to verify
  // the double-submit token. The original inline version missed this
  // attachment, which silently 401'd every patient POST (vitals, refill,
  // booking, etc.) once Week-1 CSRF shipped. Fixed as part of B5 booking
  // because that flow is the first end-to-end test of patient + CSRF.
  const sess = await getPatientSession(req);
  if (!sess) return errRes(res, 'unauthorized', 401, 'UNAUTHORIZED');
  // getPatientSession already attached csrfSecret from the in-memory store
  // (see helpers block above). Do NOT re-bind here — a previous version
  // had `sess.csrfSecret = lookupCsrfSecret(sid);` where `sid` was undefined,
  // which threw a ReferenceError on every patient request. The helpers
  // path is the single source of truth.
  req.patientSession = sess;
  next();
};

app.post('/api/patient/auth/login', validateBody(schemas.patientLogin), async (req, res) => {
  const { phoneOrEmail, password } = req.body || {};
  if (!phoneOrEmail || !password) return errRes(res, 'phoneOrEmail and password required');
  const phone = phoneOrEmail.includes('@') ? null : phoneOrEmail;
  try {
    const r = await patientAuth.loginPatient(pool, phone || phoneOrEmail, password);
    if (!r) return errRes(res, 'invalid credentials', 401, 'UNAUTHORIZED');
    if (r.locked) return errRes(res, `locked until ${r.until}`, 423, 'LOCKED');
    if (r.wrong) return errRes(res, 'wrong password', 401, 'UNAUTHORIZED');
    res.append('Set-Cookie', `pid=${r.session_id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
    const csrfSecret = bindCsrfToSession(r.session_id);
    // Use the EXACT token setCsrfCookie put in the cookie — calling
    // csrfTokenFor() again would mint a new (timestamp-based) token that
    // would not match the cookie, breaking the double-submit check on
    // every subsequent POST. See csrf.mjs line 96-111 for the rationale.
    const csrfToken = setCsrfCookie(res, csrfSecret);
    await audit(pool, req, { actor_kind: 'patient', actor_id: r.patient.patient_id, action: 'login', resource_kind: 'session', resource_id: r.session_id });
    jsonRes(res, { patient: r.patient, csrfToken });
  } catch (e) { errRes(res, e.message, 500); }
});

app.post('/api/patient/auth/logout', requirePatientAuthCsrf, async (req, res) => {
  const sid = req.patientSession?.session_id;
  await patientAuth.logoutPatient(pool, sid);
  clearCsrfForSession(sid);
  res.append('Set-Cookie', `pid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.append('Set-Cookie', `csrf_token=; Path=/; SameSite=Lax; Max-Age=0`);
  jsonRes(res, { ok: true });
});

app.get('/api/patient/auth/me', requirePatientAuth, (req, res) => {
  jsonRes(res, { patient: req.patientSession.patient });
});

app.get('/api/patient/me', requirePatientAuth, async (req, res) => {
  const pid = req.patientSession.patient.patient_id;
  markPhiAccess(req, { action: 'read', resource_kind: 'patient', resource_id: pid, patient_id: pid });
  // Full chart for the logged-in patient
  try {
    const patient = await doc.getPatient(pool, pid);
    const problems = (await clinical.getPatientProblems(pool, pid)).map(r => ({
      problem_name: r[0], icd10: r[1], since: r[2],
    }));
    const allergies = (await clinical.getPatientAllergies(pool, pid)).map(r => ({
      allergen: r[0], severity: r[1], reaction: r[2],
    }));
    const rxRows = await clinical.getPatientPrescriptions(pool, pid);
    const rx = rxRows.slice(0, 20).map(r => ({
      rx_id: r[0], rx_number: r[1], doctor_name: r[2], created_at: r[3],
      diagnosis_label: r[4], advice: r[5], followup_in_days: r[6],
    }));
    const appts = (await clinical.getPatientAppointments(pool, pid)).map(r => ({
      appointment_id: r[0], doctor_name: r[1], scheduled_at: r[2], status: r[3],
    }));
    const vitals = await clinical.getPatientVitals(pool, pid);
    const reminders = (await remindersLib.getRemindersForPatient(pool, pid)).map(r => ({
      reminder_id: r[0], kind: r[1], title: r[2], body: r[3],
      schedule_type: r[4], schedule_at: r[5], channel: r[6], status: r[7],
    }));
    jsonRes(res, { patient, problems, allergies, prescriptions: rx, appointments: appts, vitals, reminders });
  } catch (e) { errRes(res, e.message, 500); }
});

app.post('/api/patient/vitals', requirePatientAuthCsrf, validateBody(schemas.patientVitals), async (req, res) => {
  const pid = req.patientSession.patient.patient_id;
  const { metric, value, unit, notes } = req.body || {};
  if (!metric || value === undefined) return errRes(res, 'metric + value required');
  const log_id = 'pvl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const numValue = parseFloat(value);
  // Auto-flag abnormal values
  let flagged = '';
  if (metric === 'systolic' && (numValue >= 180 || numValue < 90)) flagged = numValue >= 180 ? 'high' : 'low';
  if (metric === 'diastolic' && (numValue >= 110 || numValue < 50)) flagged = numValue >= 110 ? 'high' : 'low';
  if (metric === 'glucose_fasting' && (numValue >= 180 || numValue < 60)) flagged = numValue >= 180 ? 'high' : 'low';
  if (metric === 'glucose_pp' && (numValue >= 250 || numValue < 60)) flagged = numValue >= 250 ? 'high' : 'low';
  try {
    await pool.query(
      `INSERT INTO patient_vitals_log (log_id, patient_id, metric, value, unit, recorded_at, device, notes, flagged)
       VALUES ('${log_id}', '${pid}', '${metric.replace(/'/g, "''")}', ${numValue}, '${(unit || '').replace(/'/g, "''")}', '${ts}', 'manual', '${(notes || '').replace(/'/g, "''")}', '${flagged}')`
    );
    await audit(pool, req, { actor_kind: 'patient', actor_id: pid, action: 'create', resource_kind: 'patient_vitals_log', resource_id: log_id, diff_json: { metric, value: numValue, flagged } });
    jsonRes(res, { log_id, metric, value: numValue, flagged }, 201);
  } catch (e) { errRes(res, e.message, 500); }
});

app.get('/api/patient/vitals', requirePatientAuth, async (req, res) => {
  const pid = req.patientSession.patient.patient_id;
  markPhiAccess(req, { action: 'read', resource_kind: 'patient_vitals_log', patient_id: pid });
  const rows = await pool.query(
    `SELECT log_id, metric, value, unit, recorded_at, flagged, notes FROM patient_vitals_log WHERE patient_id = '${pid}' ORDER BY recorded_at DESC LIMIT 200`
  );
  jsonRes(res, { vitals: rows.rows.map(r => ({
    log_id: r[0], metric: r[1], value: r[2], unit: r[3], recorded_at: r[4], flagged: r[5], notes: r[6],
  })) });
});

// ============ MEDICATION ADHERENCE (Week 2 / B1) ============
// Patient self-reports each scheduled dose as taken / missed / skipped.
// Append-only log; rollups (streak, adherence_pct) are computed by the API.

const ADHERENCE_STATUS = new Set(['taken', 'missed', 'skipped']);
const ADHERENCE_SLOTS = new Set(['morning', 'afternoon', 'evening', 'night', 'custom']);

app.post('/api/patient/adherence', requirePatientAuthCsrf, validateBody(schemas.patientAdherence), async (req, res) => {
  const pid = req.patientSession.patient.patient_id;
  const {
    drug_name, dose, schedule_slot, scheduled_at,
    status, taken_at, notes, rx_id,
  } = req.body || {};
  if (!drug_name) return errRes(res, 'drug_name required');
  if (!schedule_slot) return errRes(res, 'schedule_slot required');
  if (!ADHERENCE_SLOTS.has(schedule_slot)) return errRes(res, 'schedule_slot must be one of morning|afternoon|evening|night|custom');
  if (!scheduled_at) return errRes(res, 'scheduled_at required');
  if (!status) return errRes(res, 'status required');
  if (!ADHERENCE_STATUS.has(status)) return errRes(res, 'status must be one of taken|missed|skipped');

  const adherence_id = 'ad-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  // VBP wire needs space-separated timestamp; trim TZ for safety.
  const scheduledStr = String(scheduled_at).slice(0, 19).replace('T', ' ');
  const takenStr = taken_at ? String(taken_at).slice(0, 19).replace('T', ' ') : null;
  // Engine v1 does not honor DEFAULT values at INSERT time — supply the
  // current_timestamp explicitly (matches the pattern used by /api/reminders).
  const createdStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    await pool.query(
      `INSERT INTO med_adherence (adherence_id, patient_id, rx_id, drug_name, dose, schedule_slot, scheduled_at, taken_at, status, notes, created_at)
       VALUES ('${adherence_id}', '${pid}', ${rx_id ? `'${String(rx_id).replace(/'/g, "''")}'` : 'NULL'},
               '${String(drug_name).replace(/'/g, "''")}',
               ${dose ? `'${String(dose).replace(/'/g, "''")}'` : 'NULL'},
               '${schedule_slot}', '${scheduledStr}',
               ${takenStr ? `'${takenStr}'` : 'NULL'},
               '${status}',
               ${notes ? `'${String(notes).replace(/'/g, "''")}'` : 'NULL'},
               '${createdStr}')`
    );
    await audit(pool, req, {
      actor_kind: 'patient', actor_id: pid, action: 'create',
      resource_kind: 'med_adherence', resource_id: adherence_id,
      diff_json: { drug_name, schedule_slot, scheduled_at, status },
    });
    jsonRes(res, {
      adherence_id, patient_id: pid, drug_name, dose: dose || null,
      schedule_slot, scheduled_at, taken_at: taken_at || null,
      status, notes: notes || null, rx_id: rx_id || null,
    }, 201);
  } catch (e) { errRes(res, e.message, 500); }
});

// Helper: VBP returns NULL columns as the literal string 'NULL' (and Date
// objects are also possible for TIMESTAMPTZ). Treat both as null and parse
// valid timestamps to ISO. Anything else → null (don't crash the response).
function vbpParseTs(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v).trim();
  if (!s || s === 'NULL' || s === 'null') return null;
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

app.get('/api/patient/adherence', requirePatientAuth, async (req, res) => {
  const pid = req.patientSession.patient.patient_id;
  markPhiAccess(req, { action: 'read', resource_kind: 'med_adherence', patient_id: pid });
  const { from, to, status } = req.query;
  // Default window: last 30 days if no from/to.
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 86400 * 1000);
  const fromStr = (from ? String(from) : defaultFrom.toISOString()).slice(0, 19).replace('T', ' ');
  const toStr   = (to   ? String(to)   : now.toISOString()).slice(0, 19).replace('T', ' ');
  const statusFilter = status && ADHERENCE_STATUS.has(status) ? `AND status = '${status}'` : '';
  try {
    const rows = await pool.query(
      `SELECT adherence_id, patient_id, rx_id, drug_name, dose, schedule_slot, scheduled_at, taken_at, status, notes, created_at
         FROM med_adherence
        WHERE patient_id = '${pid}'
          AND scheduled_at >= '${fromStr}'
          AND scheduled_at <= '${toStr}'
          ${statusFilter}
        ORDER BY scheduled_at DESC LIMIT 500`
    );
    const out = rows.rows.map(r => ({
      adherence_id: r[0], patient_id: r[1], rx_id: r[2], drug_name: r[3],
      dose: r[4] && r[4] !== 'NULL' ? r[4] : null,
      schedule_slot: r[5],
      scheduled_at: vbpParseTs(r[6]),
      taken_at: vbpParseTs(r[7]),
      status: r[8] && r[8] !== 'NULL' ? r[8] : null,
      notes: r[9] && r[9] !== 'NULL' ? r[9] : null,
      created_at: vbpParseTs(r[10]),
    }));

    // Rollups: streak_days = number of consecutive days ending today where
    // EVERY scheduled dose is 'taken' (missed/skipped resets the streak).
    // adherence_pct = taken / (taken + missed + skipped) over the window.
    const dayKey = (iso) => {
      if (!iso) return null;
      // iso is "YYYY-MM-DDTHH:MM:SS.sssZ" — date is the first 10 chars.
      return iso.slice(0, 10);
    };
    const byDay = new Map();
    for (const r of out) {
      const k = dayKey(r.scheduled_at);
      if (!k) continue;
      const bucket = byDay.get(k) || { taken: 0, missed: 0, skipped: 0, any: false };
      if (r.status === 'taken') bucket.taken++;
      else if (r.status === 'missed') bucket.missed++;
      else if (r.status === 'skipped') bucket.skipped++;
      bucket.any = true;
      byDay.set(k, bucket);
    }
    // Streak: walk back from today; stop at first day that is 'empty' OR has
    // any missed/skipped.
    let streak_days = 0;
    const cursor = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
    while (true) {
      const k = cursor.toISOString().slice(0, 10);
      const b = byDay.get(k);
      if (!b || !b.any || b.missed > 0 || b.skipped > 0) break;
      streak_days++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }

    let tTaken = 0, tMissed = 0, tSkipped = 0;
    for (const b of byDay.values()) { tTaken += b.taken; tMissed += b.missed; tSkipped += b.skipped; }
    const denom = tTaken + tMissed + tSkipped;
    const adherence_pct = denom > 0 ? Math.round((tTaken / denom) * 100) : null;

    jsonRes(res, {
      rows: out,
      streak_days,
      adherence_pct,
      window: { from: fromStr, to: toStr },
      totals: { taken: tTaken, missed: tMissed, skipped: tSkipped },
    });
  } catch (e) { errRes(res, e.message, 500); }
});

app.get('/api/patient/adherence/today', requirePatientAuth, async (req, res) => {
  const pid = req.patientSession.patient.patient_id;
  markPhiAccess(req, { action: 'read', resource_kind: 'med_adherence', patient_id: pid });
  // Today 00:00 UTC → tomorrow 00:00 UTC (exclusive upper bound).
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrow = new Date(todayStart.getTime() + 86400 * 1000);
  const fromStr = todayStart.toISOString().slice(0, 19).replace('T', ' ');
  const toStr   = tomorrow.toISOString().slice(0, 19).replace('T', ' ');
  try {
    // Pull today's med_adherence rows; LEFT-JOIN reminders on the per-patient
    // metformin reminder id so we can fall back to its title/body when the
    // adherence row was created without drug_name/dose.
    const rows = await pool.query(
      `SELECT a.adherence_id, a.patient_id, a.rx_id, a.drug_name, a.dose, a.schedule_slot,
              a.scheduled_at, a.taken_at, a.status, a.notes,
              r.title, r.body
         FROM med_adherence a
         LEFT JOIN reminders r
           ON r.reminder_id = 'r-' || a.patient_id || '-metformin'
          AND r.patient_id = a.patient_id
        WHERE a.patient_id = '${pid}'
          AND a.scheduled_at >= '${fromStr}'
          AND a.scheduled_at <  '${toStr}'
        ORDER BY a.scheduled_at ASC`
    );
    const out = rows.rows.map(r => ({
      adherence_id: r[0], patient_id: r[1], rx_id: r[2],
      drug_name: r[3] && r[3] !== 'NULL' ? r[3]
                : (r[10] && r[10] !== 'NULL' ? String(r[10]).replace(/^Take\s+/i, '').replace(/\s+\d.*$/, '').trim() : null)
                || 'Unknown',
      dose: r[4] && r[4] !== 'NULL' ? r[4] : null,
      schedule_slot: r[5],
      scheduled_at: vbpParseTs(r[6]),
      taken_at: vbpParseTs(r[7]),
      status: r[8] && r[8] !== 'NULL' ? r[8] : 'pending',
      notes: r[9] && r[9] !== 'NULL' ? r[9] : null,
      reminder_title: r[10] && r[10] !== 'NULL' ? r[10] : null,
    }));
    jsonRes(res, { rows: out, date: todayStart.toISOString().slice(0, 10) });
  } catch (e) { errRes(res, e.message, 500); }
});

// ============ REMINDERS ============
app.get('/api/reminders', requireAuth, async (req, res) => {
  const { patient_id, status } = req.query;
  let q = `SELECT reminder_id, patient_id, kind, title, body, schedule_type, schedule_at, channel, status, source_kind, source_id, created_at
           FROM reminders WHERE 1=1`;
  if (patient_id) q += ` AND patient_id = '${patient_id.replace(/'/g, "''")}'`;
  if (status) q += ` AND status = '${status}'`;
  q += ' ORDER BY schedule_at ASC LIMIT 200';
  const rows = await pool.query(q);
  jsonRes(res, { reminders: rows.rows.map(r => ({
    reminder_id: r[0], patient_id: r[1], kind: r[2], title: r[3], body: r[4],
    schedule_type: r[5], schedule_at: r[6], channel: r[7], status: r[8],
    source_kind: r[9], source_id: r[10], created_at: r[11],
  })) });
});

app.post('/api/reminders', requireAuthCsrf, async (req, res) => {
  const { patient_id, kind, title, body, schedule_type, schedule_at, channel } = req.body || {};
  if (!patient_id || !kind || !title || !schedule_type) return errRes(res, 'patient_id, kind, title, schedule_type required');
  const reminder_id = 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const schedule_at_str = (schedule_at || ts).slice(0, 19).replace('T', ' ');
  try {
    await pool.query(
      `INSERT INTO reminders (reminder_id, patient_id, kind, title, body, schedule_type, schedule_at, channel, source_kind, source_id, created_at, created_by)
       VALUES ('${reminder_id}', '${patient_id.replace(/'/g, "''")}', '${kind.replace(/'/g, "''")}', '${title.replace(/'/g, "''")}', '${(body || '').replace(/'/g, "''")}', '${schedule_type.replace(/'/g, "''")}', '${schedule_at_str}', '${(channel || 'whatsapp').replace(/'/g, "''")}', 'manual', '', '${ts}', '${req.session.doctor_id}')`
    );
    await audit(pool, req, { actor_kind: 'doctor', actor_id: req.session.doctor_id, action: 'create', resource_kind: 'reminder', resource_id: reminder_id, diff_json: { patient_id, kind, title } });
    jsonRes(res, { reminder_id }, 201);
  } catch (e) { errRes(res, e.message, 500); }
});

app.get('/api/reminders/deliveries', requireAuth, async (req, res) => {
  const { reminder_id, patient_id } = req.query;
  let q = `SELECT delivery_id, reminder_id, patient_id, ts, channel, status, provider_msg_id, error FROM reminder_deliveries WHERE 1=1`;
  if (reminder_id) q += ` AND reminder_id = '${reminder_id.replace(/'/g, "''")}'`;
  if (patient_id) q += ` AND patient_id = '${patient_id.replace(/'/g, "''")}'`;
  q += ' ORDER BY ts DESC LIMIT 100';
  const rows = await pool.query(q);
  jsonRes(res, { deliveries: rows.rows.map(r => ({
    delivery_id: r[0], reminder_id: r[1], patient_id: r[2], ts: r[3], channel: r[4], status: r[5], provider_msg_id: r[6], error: r[7],
  })) });
});

// Fire due reminders (cron endpoint — call every minute from a scheduler)
app.post('/api/reminders/fire-due', requireAuthCsrf, async (req, res) => {
  const fired = await remindersLib.fireDueReminders(pool);
  jsonRes(res, { fired_count: fired.length, fired });
});

// ============ TELEMEDICINE ============
app.get('/api/telemedicine/sessions', requireAuth, async (req, res) => {
  const { patient_id, doctor_id } = req.query;
  let q = `SELECT session_id, patient_id, doctor_id, scheduled_at, started_at, ended_at, status, channel, notes, followup_rx_id, created_at
           FROM tele_sessions WHERE 1=1`;
  if (patient_id) q += ` AND patient_id = '${patient_id.replace(/'/g, "''")}'`;
  if (doctor_id) q += ` AND doctor_id = '${doctor_id.replace(/'/g, "''")}'`;
  q += ' ORDER BY scheduled_at DESC LIMIT 50';
  const rows = await pool.query(q);
  jsonRes(res, { sessions: rows.rows.map(r => ({
    session_id: r[0], patient_id: r[1], doctor_id: r[2], scheduled_at: r[3],
    started_at: r[4], ended_at: r[5], status: r[6], channel: r[7], notes: r[8],
    followup_rx_id: r[9], created_at: r[10],
  })) });
});

app.post('/api/telemedicine/sessions', requireAuthCsrf, async (req, res) => {
  const { patient_id, scheduled_at, channel } = req.body || {};
  if (!patient_id || !scheduled_at) return errRes(res, 'patient_id and scheduled_at required');
  const session_id = 'tele-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    await pool.query(
      `INSERT INTO tele_sessions (session_id, patient_id, doctor_id, scheduled_at, status, channel, created_at)
       VALUES ('${session_id}', '${patient_id.replace(/'/g, "''")}', '${req.session.doctor_id}', '${scheduled_at.replace(/'/g, "''")}', 'scheduled', '${(channel || 'webrtc').replace(/'/g, "''")}', '${ts}')`
    );
    await audit(pool, req, { actor_kind: 'doctor', actor_id: req.session.doctor_id, action: 'create', resource_kind: 'tele_session', resource_id: session_id, diff_json: { patient_id, scheduled_at } });
    jsonRes(res, { session_id }, 201);
  } catch (e) { errRes(res, e.message, 500); }
});

app.post('/api/telemedicine/sessions/:id/start', requireAuthCsrf, async (req, res) => {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await pool.query(`UPDATE tele_sessions SET status = 'active', started_at = '${ts}' WHERE session_id = '${req.params.id.replace(/'/g, "''")}'`);
  await audit(pool, req, { actor_kind: 'doctor', actor_id: req.session.doctor_id, action: 'start', resource_kind: 'tele_session', resource_id: req.params.id });
  jsonRes(res, { ok: true });
});

app.post('/api/telemedicine/sessions/:id/end', requireAuthCsrf, async (req, res) => {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const { notes, followup_rx_id } = req.body || {};
  await pool.query(
    `UPDATE tele_sessions SET status = 'completed', ended_at = '${ts}', notes = '${(notes || '').replace(/'/g, "''")}', followup_rx_id = '${(followup_rx_id || '').replace(/'/g, "''")}' WHERE session_id = '${req.params.id.replace(/'/g, "''")}'`
  );
  await audit(pool, req, { actor_kind: 'doctor', actor_id: req.session.doctor_id, action: 'end', resource_kind: 'tele_session', resource_id: req.params.id, diff_json: { notes, followup_rx_id } });
  jsonRes(res, { ok: true });
});

app.get('/api/telemedicine/sessions/:id/messages', requireAuth, async (req, res) => {
  const rows = await pool.query(
    `SELECT message_id, session_id, ts, sender_kind, sender_id, body FROM tele_messages WHERE session_id = '${req.params.id.replace(/'/g, "''")}' ORDER BY ts ASC`
  );
  jsonRes(res, { messages: rows.rows.map(r => ({
    message_id: r[0], session_id: r[1], ts: r[2], sender_kind: r[3], sender_id: r[4], body: r[5],
  })) });
});

app.post('/api/telemedicine/sessions/:id/messages', requireAuthCsrf, async (req, res) => {
  const { body } = req.body || {};
  if (!body) return errRes(res, 'body required');
  const message_id = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await pool.query(
    `INSERT INTO tele_messages (message_id, session_id, ts, sender_kind, sender_id, body)
     VALUES ('${message_id}', '${req.params.id.replace(/'/g, "''")}', '${ts}', 'doctor', '${req.session.doctor_id}', '${body.replace(/'/g, "''")}')`
  );
  jsonRes(res, { message_id }, 201);
});

// ============ POPULATION HEALTH / ANALYTICS ============
app.get('/api/analytics/cohort', requireAuth, async (req, res) => {
  // Cohort finder — find patients matching criteria
  const { condition, min_age, max_age, hba1c_above, on_medication } = req.query;
  const allRows = await pool.query(`SELECT patient_id, full_name, gender, dob, phone FROM patients WHERE is_active = 1 LIMIT 500`);
  const patients = allRows.rows.map(r => ({
    patient_id: r[0], full_name: r[1], gender: r[2], dob: r[3], phone: r[4],
    age_years: r[3] ? Math.floor((Date.now() - new Date(r[3]).getTime()) / (365.25 * 86400 * 1000)) : null,
  }));
  const matches = [];
  for (const p of patients) {
    if (min_age && (p.age_years || 0) < parseInt(min_age)) continue;
    if (max_age && (p.age_years || 0) > parseInt(max_age)) continue;
    const problems = await clinical.getPatientProblems(pool, p.patient_id);
    const allProblems = problems.map(r => (r[0] || '').toLowerCase()).join(' ');
    if (condition && !allProblems.includes(condition.toLowerCase())) continue;
    if (on_medication) {
      const meds = await clinical.getPatientPrescriptions(pool, p.patient_id);
      const drugList = meds.map(r => (r[1] || '').toLowerCase()).join(' ');
      if (!drugList.includes(on_medication.toLowerCase())) continue;
    }
    if (hba1c_above) {
      const vitals = await clinical.getPatientVitals(pool, p.patient_id);
      const hba1c = vitals.find(v => v[2] && v[2].toLowerCase().includes('hba1c'));
      if (!hba1c || !hba1c[3] || parseFloat(hba1c[3]) < parseFloat(hba1c_above)) continue;
    }
    matches.push({
      patient_id: p.patient_id,
      full_name: p.full_name,
      age: p.age_years,
      gender: p.gender,
      phone: p.phone,
      problems: problems.map(r => r[0]),
    });
  }
  jsonRes(res, { cohort_size: matches.length, patients: matches.slice(0, 100), criteria: req.query });
});

app.get('/api/analytics/clinic-overview', requireAuth, async (req, res) => {
  const allRows = await pool.query(`SELECT patient_id, full_name, dob FROM patients WHERE is_active = 1`);
  const allRx = (await clinical.listAllPrescriptions(pool, { limit: 1000 })).prescriptions || [];
  const allVitals = await clinical.getAllVitals(pool);
  const diabetic = [];
  const hypertensive = [];
  const uncontrolledDm = [];
  let totalAgeSum = 0, ageN = 0;
  for (const r of allRows.rows) {
    const pid = r[0], full_name = r[1], dob = r[2];
    const age = dob ? Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 86400 * 1000)) : null;
    if (age) { totalAgeSum += age; ageN++; }
    const problems = await clinical.getPatientProblems(pool, pid);
    const txt = problems.map(x => (x[0] || '').toLowerCase()).join(' ');
    if (txt.includes('diabetes') || txt.includes('dm')) diabetic.push({ patient_id: pid, full_name });
    if (txt.includes('hypertension') || txt.includes('htn')) hypertensive.push({ patient_id: pid, full_name });
    if (txt.includes('diabetes')) {
      const v = allVitals.filter(x => x[1] === pid && x[2] && x[2].toLowerCase().includes('hba1c'));
      const latestHba1c = v[0];
      if (latestHba1c && parseFloat(latestHba1c[3] || 0) >= 8) uncontrolledDm.push({ patient_id: pid, full_name });
    }
  }
  const remindersCount = (await pool.query(`SELECT COUNT(*) as c FROM reminders WHERE status = 'active'`)).rows[0][0];
  const teleCount = (await pool.query(`SELECT COUNT(*) as c FROM tele_sessions WHERE status = 'scheduled'`)).rows[0][0];
  jsonRes(res, {
    total_patients: allRows.rows.length,
    avg_age: ageN ? Math.round(totalAgeSum / ageN) : null,
    diabetic_count: diabetic.length,
    diabetic: diabetic.slice(0, 10),
    hypertensive_count: hypertensive.length,
    hypertensive: hypertensive.slice(0, 10),
    uncontrolled_dm_count: uncontrolledDm.length,
    uncontrolled_dm: uncontrolledDm.slice(0, 10),
    prescription_count: allRx.length,
    rx_last_30d: allRx.filter(rx => rx.created_at && (Date.now() - new Date(rx.created_at).getTime()) < 30 * 86400 * 1000).length,
    reminders_active: remindersCount,
    tele_sessions_scheduled: teleCount,
  });
});

// ============ AUDIT LOG ============
app.get('/api/audit', requireAuth, async (req, res) => {
  const { resource_kind, resource_id, actor_id, limit } = req.query;
  let q = `SELECT audit_id, ts, actor_kind, actor_id, action, resource_kind, resource_id, ip, diff_json FROM audit_log WHERE 1=1`;
  if (resource_kind) q += ` AND resource_kind = '${resource_kind.replace(/'/g, "''")}'`;
  if (resource_id) q += ` AND resource_id = '${resource_id.replace(/'/g, "''")}'`;
  if (actor_id) q += ` AND actor_id = '${actor_id.replace(/'/g, "''")}'`;
  q += ` ORDER BY ts DESC LIMIT ${parseInt(limit) || 100}`;
  const rows = await pool.query(q);
  jsonRes(res, { entries: rows.rows.map(r => ({
    audit_id: r[0], ts: r[1], actor_kind: r[2], actor_id: r[3], action: r[4],
    resource_kind: r[5], resource_id: r[6], ip: r[7], diff_json: r[8] ? safeParse(r[8]) : null,
  })) });
});

// ============ RAG (clinical guidelines) ============
app.post('/api/rag/query', requireAuthCsrf, async (req, res) => {
  const { query } = req.body || {};
  if (!query) return errRes(res, 'query required');
  try {
    const { context, citations } = await augmentPrompt(pool, query, 3);
    if (!llmEnabled()) {
      return jsonRes(res, {
        method: 'rag_no_llm',
        context,
        citations,
        message: 'Set OPENAI_API_KEY env var for grounded answer. Showing retrieved guidelines only.',
      });
    }
    const systemPrompt = `You are a clinical decision support assistant. Use ONLY the provided clinical guidelines to answer. Cite sources using [1], [2] etc. If the guidelines do not cover the question, say "Guidelines do not provide specific advice for this case — consult senior."`;
    const userPrompt = `Question: ${query}\n\nGuidelines:\n${context}\n\nProvide a concise answer with citations.`;
    const t0 = Date.now();
    const r = await llmComplete({ system: systemPrompt, user: userPrompt, temperature: 0.1, maxTokens: 500 });
    const latency_ms = Date.now() - t0;
    await logUsage(pool, { feature: 'rag', usage: r.usage, model: r.model, latency_ms, status: 'ok' });
    jsonRes(res, { method: 'rag_llm', answer: r.text, citations, context, usage: r.usage });
  } catch (e) {
    await logUsage(pool, { feature: 'rag', latency_ms: 0, status: 'error', error: e.message });
    errRes(res, e.message, 500);
  }
});

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// ============ LLM STATUS ============
app.get('/api/llm/status', requireAuth, (req, res) => {
  jsonRes(res, { enabled: llmEnabled(), model: process.env.OPENAI_MODEL || 'gpt-4o-mini' });
});

// ============ UPDATED LLM-POWERED AGENTS ============
// These use LLM when available, fall back to rules.
async function aiAgent(name, ctx, req) {
  if (!llmEnabled()) return null;  // signal to use rule-based
  // Build prompt per agent
  let systemPrompt = '';
  let userPrompt = '';
  if (name === 'soap') {
    systemPrompt = 'You are an expert clinician. Convert the consultation transcript into a structured SOAP note (Subjective, Objective, Assessment, Plan). Be concise. Use medical terminology. Flag any safety concerns.';
    userPrompt = `Patient context:\n${ctx.context || '(no context)'}\n\nTranscript:\n${ctx.transcript}\n\nReturn JSON: {"subjective": [...], "objective": [...], "assessment": [...], "plan": [...], "safety_flags": [...]}`;
  } else if (name === 'coding') {
    systemPrompt = 'You are an expert medical coder. From the given clinical note, suggest the most appropriate ICD-10-CM codes with descriptions. Rank by relevance. Return JSON.';
    userPrompt = `Note: ${ctx.transcript}\n\nReturn JSON: {"codes": [{"code": "X", "description": "...", "rationale": "..."}], "confidence": 0.0-1.0}`;
  } else if (name === 'lab_triage') {
    systemPrompt = 'You are a clinical pathologist. Triage the lab result given patient context. Return severity (CRITICAL / ABNORMAL_HIGH / ABNORMAL_LOW / NORMAL), primary action, and 2-5 recommended actions.';
    userPrompt = `Test: ${ctx.test_name} = ${ctx.value} ${ctx.unit || ''}\n\nPatient context:\n${ctx.context || '(no context)'}\n\nReturn JSON: {"severity": "...", "primary_action": "...", "recommendations": [...], "reasoning": "..."}`;
  } else if (name === 'drug_ix') {
    systemPrompt = 'You are a clinical pharmacist. Review the drug interaction report and provide a concise clinical summary. Highlight critical interactions and suggest action.';
    userPrompt = `Interactions:\n${JSON.stringify(ctx.interactions, null, 2)}\n\nAllergy alerts:\n${JSON.stringify(ctx.allergy_alerts, null, 2)}\n\nReturn JSON: {"overall_risk": "...", "critical_interactions": [...], "recommendations": [...], "patient_facing_summary": "..."}`;
  } else {
    return null;
  }
  const t0 = Date.now();
  const r = await llmComplete({ system: systemPrompt, user: userPrompt, json: true, temperature: 0.2, maxTokens: 800 });
  const latency_ms = Date.now() - t0;
  await logUsage(pool, { feature: name, patient_id: ctx.patient_id, doctor_id: req.session?.doctor_id, usage: r.usage, model: r.model, latency_ms, status: 'ok' });
  try { return JSON.parse(r.text); } catch { return null; }
}

app.post('/api/ai/agents/llm', requireAuthCsrf, async (req, res) => {
  // LLM-powered version of the existing agents — proxy to Python with LLM augmentation
  const { agent, ...body } = req.body || {};
  if (!agent) return errRes(res, 'agent required');
  // First get the rule-based result from Python (via the shared aiFetch so
  // it gets the timeout + breaker + service-key treatment).
  try {
    const r = await aiFetch('/agents/run', { method: 'POST', body: JSON.stringify({ agent, ...body }) });
    const baseResult = await r.json();
    if (!llmEnabled()) return jsonRes(res, { method: 'rules_only', result: baseResult });
    try {
      const enhanced = await aiAgent(agent, body, req);
      jsonRes(res, { method: 'llm_enhanced', result: baseResult, llm_enhancement: enhanced });
    } catch (e) {
      await logUsage(pool, { feature: agent, status: 'error', error: e.message });
      jsonRes(res, { method: 'rules_with_llm_error', result: baseResult, llm_error: e.message });
    }
  } catch (e) {
    errRes(res, 'AI service error: ' + (e.message || 'unknown'), e.status || 502, e.code || 'AI_ERROR');
  }
});

// ============ STARTUP + GRACEFUL SHUTDOWN ============
// Use the raw http.createServer so we own the listen() / close() lifecycle.
// app.listen() creates its own server and never lets us gracefully drain —
// the prior version caught SIGTERM but only as `await pool.closeAll()` then
// hard exit(0), which severs every in-flight request mid-write and can
// corrupt Vedadb state.
const httpServer = createServer(app);
const PORT = config.PORT;
const HOST = config.HOST;

// in-flight request tracker — ShutdownCoordinator polls this every 2s during
// graceful shutdown so we know when it's safe to close the pool.
let inFlight = 0;
httpServer.on('request', (req, res) => {
  inFlight++;
  res.on('finish', () => inFlight--);
  res.on('close', () => inFlight--);
});

httpServer.listen(PORT, HOST, () => {
  // Keep one human-readable line for grep-ability in deploy logs.
  logger.info('listening', { url: `http://${HOST}:${PORT}`, vbp: `${config.VBP_HOST}:${config.VBP_PORT}` });
});

const shutdown = new ShutdownCoordinator({
  httpServer,
  graceMs: config.SHUTDOWN_GRACE_MS,
  inFlight: () => inFlight,
  onDraining: async () => { shuttingDown = true; },
  onCleanup: async () => {
    // Close VBP pool last so the in-flight requests can still hit it.
    try { await pool.closeAll(); } catch (e) { logger.warn('pool_close_err', { err: e?.message }); }
  },
});
shutdown.install();
