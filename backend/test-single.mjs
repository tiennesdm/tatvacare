import { VBP } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';
const db = new VBP('127.0.0.1', 6381);
await db.connect();
console.log('--- TEST 1: simple CREATE ---');
try {
  const r = await db.query(`CREATE TABLE test_x (id INT PRIMARY KEY, name TEXT NOT NULL)`);
  console.log('OK:', r.commandTag);
} catch (e) { console.log('FAIL:', e.message, 'state:', e.sqlstate); }

console.log('--- TEST 2: with multi-line + IF NOT EXISTS ---');
try {
  const r = await db.query(`CREATE TABLE IF NOT EXISTS test_y (
    id INT PRIMARY KEY,
    name TEXT NOT NULL,
    age INT
  )`);
  console.log('OK:', r.commandTag);
} catch (e) { console.log('FAIL:', e.message, 'state:', e.sqlstate); }

console.log('--- TEST 3: appointments-style with CHECK ---');
try {
  const r = await db.query(`CREATE TABLE IF NOT EXISTS appointments (
    appt_id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    doctor_id TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    duration_min INT DEFAULT 15,
    type TEXT DEFAULT 'opd',
    status TEXT DEFAULT 'scheduled',
    reason TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  console.log('OK:', r.commandTag);
} catch (e) { console.log('FAIL:', e.message, 'state:', e.sqlstate); }

process.exit(0);
