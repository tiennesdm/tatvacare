-- TatvaCare Phase 6 — patient portal, multi-tenancy, reminders, audit, telemedicine, RAG

-- Clinics (multi-tenancy root)
CREATE TABLE IF NOT EXISTS clinics (
  clinic_id      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  city           TEXT,
  address        TEXT,
  phone          TEXT,
  abha_facility_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

-- Audit log — every mutation recorded
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id       TEXT PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  actor_kind     TEXT,                    -- doctor | patient | system | agent
  actor_id       TEXT,
  clinic_id      TEXT,
  action         TEXT,                    -- create | update | delete | sign | export | login | etc.
  resource_kind  TEXT,                    -- prescription | patient | note | reminder | etc.
  resource_id    TEXT,
  ip             TEXT,
  user_agent     TEXT,
  diff_json      TEXT                     -- what changed
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_kind, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_kind, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_clinic ON audit_log(clinic_id);

-- Patient login credentials (separate from doctor)
CREATE TABLE IF NOT EXISTS patient_credentials (
  patient_id     TEXT PRIMARY KEY,
  password_hash  TEXT NOT NULL,
  pin            TEXT,                     -- short PIN for SMS-based login
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

-- Patient self-logged vitals (home BP / sugar / weight / temperature)
CREATE TABLE IF NOT EXISTS patient_vitals_log (
  log_id         TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL,
  metric         TEXT NOT NULL,           -- systolic | diastolic | pulse | glucose_fasting | glucose_pp | weight_kg | temp_c | spo2
  value          REAL NOT NULL,
  unit           TEXT,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  device         TEXT,                    -- manual | glucometer:abc | bp_monitor:xyz
  notes          TEXT,
  flagged        TEXT                     -- high | low | '' (auto-flagged abnormal)
);
CREATE INDEX IF NOT EXISTS idx_pvital_patient_time ON patient_vitals_log(patient_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvital_metric ON patient_vitals_log(metric, recorded_at DESC);

-- Reminders (medication / appointment / lab / follow-up)
CREATE TABLE IF NOT EXISTS reminders (
  reminder_id    TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL,
  kind           TEXT NOT NULL,            -- medication | appointment | lab | followup | custom
  title          TEXT NOT NULL,
  body           TEXT,
  schedule_type  TEXT NOT NULL,            -- once | daily | weekly | monthly
  schedule_at    TIMESTAMPTZ,             -- next fire time (updated as it fires)
  schedule_data  TEXT,                    -- recurrence rule JSON
  channel        TEXT NOT NULL DEFAULT 'whatsapp',  -- whatsapp | sms | email | push
  status         TEXT NOT NULL DEFAULT 'active',   -- active | paused | completed | cancelled
  source_kind    TEXT,                    -- prescription | appointment | manual | agent
  source_id      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  created_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminder_patient ON reminders(patient_id, status);
CREATE INDEX IF NOT EXISTS idx_reminder_schedule ON reminders(status, schedule_at);

-- Reminder delivery log
CREATE TABLE IF NOT EXISTS reminder_deliveries (
  delivery_id    TEXT PRIMARY KEY,
  reminder_id    TEXT NOT NULL,
  patient_id     TEXT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  channel        TEXT,
  status         TEXT,                    -- sent | failed | skipped
  provider_msg_id TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminder_delivery_reminder ON reminder_deliveries(reminder_id, ts DESC);

-- Telemedicine sessions
CREATE TABLE IF NOT EXISTS tele_sessions (
  session_id     TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL,
  doctor_id      TEXT NOT NULL,
  scheduled_at   TIMESTAMPTZ NOT NULL,
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | active | completed | cancelled | no_show
  channel        TEXT,                    -- webrtc | phone | in_person
  recording_url  TEXT,
  notes          TEXT,
  followup_rx_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);
CREATE INDEX IF NOT EXISTS idx_tele_patient ON tele_sessions(patient_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_tele_doctor ON tele_sessions(doctor_id, scheduled_at DESC);

-- Telemedicine messages (in-call chat)
CREATE TABLE IF NOT EXISTS tele_messages (
  message_id     TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  sender_kind    TEXT,                    -- doctor | patient | system
  sender_id      TEXT,
  body           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tele_msg_session ON tele_messages(session_id, ts);

-- Knowledge base for RAG (clinical guidelines indexed by tags)
CREATE TABLE IF NOT EXISTS kb_documents (
  doc_id         TEXT PRIMARY KEY,
  source         TEXT,                    -- WHO | NICE | ICMR | AIIMS | local
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  tags           TEXT,                    -- comma-separated: diabetes,htn,ckd
  url            TEXT,
  indexed_at     TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);
CREATE INDEX IF NOT EXISTS idx_kb_tags ON kb_documents(tags);

-- LLM usage log
CREATE TABLE IF NOT EXISTS llm_usage (
  usage_id       TEXT PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  feature        TEXT,                    -- soap | coding | lab_triage | drug_ix | rag
  patient_id     TEXT,
  doctor_id      TEXT,
  model          TEXT,
  prompt_tokens  INT,
  completion_tokens INT,
  total_tokens   INT,
  latency_ms     INT,
  status         TEXT,                    -- ok | error
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_feature ON llm_usage(feature, ts DESC);

-- Add clinic_id column to doctors (for multi-tenancy)
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS clinic_id TEXT;
CREATE INDEX IF NOT EXISTS idx_doctors_clinic ON doctors(clinic_id);

-- Seed: one demo clinic
INSERT INTO clinics (clinic_id, name, city, address, phone, abha_facility_id, created_at)
VALUES ('cl-001', 'TatvaCare Demo Clinic', 'Mumbai', '123 Health Street, Mumbai', '+91-22-12345678', 'IN-TC-001', '2026-01-01 00:00:00')
ON CONFLICT (clinic_id) DO NOTHING;

-- Update existing doctors to demo clinic
UPDATE doctors SET clinic_id = 'cl-001' WHERE clinic_id IS NULL;

-- Seed: patient credentials for all existing patients (password = phone last 6 digits)
INSERT INTO patient_credentials (patient_id, password_hash, pin, created_at)
SELECT patient_id, encode(sha256(right(phone, 6)::bytea), 'hex'), right(phone, 4), '2026-01-01 00:00:00'
FROM patients
WHERE phone IS NOT NULL AND length(phone) >= 6
ON CONFLICT (patient_id) DO NOTHING;

-- Seed: sample reminders for demo patients
INSERT INTO reminders (reminder_id, patient_id, kind, title, body, schedule_type, schedule_at, channel, source_kind, source_id, created_at)
SELECT
  'r-' || patient_id || '-metformin',
  patient_id,
  'medication',
  'Take Metformin 500mg',
  'After breakfast and dinner',
  'daily',
  '2026-12-31 08:00:00',
  'whatsapp',
  'prescription',
  'rx-sample',
  '2026-06-21 00:00:00'
FROM patients LIMIT 4
ON CONFLICT DO NOTHING;

INSERT INTO reminders (reminder_id, patient_id, kind, title, body, schedule_type, schedule_at, channel, source_kind, created_at)
SELECT
  'r-' || patient_id || '-followup',
  patient_id,
  'followup',
  'Follow-up appointment due',
  'Please book your next visit',
  'once',
  '2026-07-05 09:00:00',
  'whatsapp',
  'manual',
  '2026-06-21 00:00:00'
FROM patients LIMIT 4
ON CONFLICT DO NOTHING;

-- Seed: clinical knowledge base (RAG corpus)
INSERT INTO kb_documents (doc_id, source, title, body, tags, url, indexed_at) VALUES
('kb-who-dm-001', 'WHO', 'WHO Type 2 Diabetes Management',
 'First-line therapy for type 2 diabetes is metformin along with lifestyle modification. Target HbA1c <7% for most adults. Add SGLT2 inhibitor or GLP-1 agonist if high cardiovascular risk. ACE inhibitors preferred for hypertension in diabetics.',
 'diabetes,dm,t2dm,metformin,sglt2,hba1c', 'https://www.who.int/news-room/fact-sheets/detail/diabetes', '2026-06-21 00:00:00'),
('kb-aace-dm-002', 'AACE', 'AACE 2022 Glycemic Control Algorithm',
 'Start metformin at 500mg once or twice daily, titrate to 1000mg BID over 4 weeks. Add second agent if HbA1c >7.5%. Consider dual therapy upfront if HbA1c >9%.',
 'diabetes,dm,metformin,titration,hba1c', 'https://www.aace.com/disease-state-resources/diabetes/clinical-practice-guidelines', '2026-06-21 00:00:00'),
('kb-icmr-htn-001', 'ICMR', 'ICMR Hypertension Guidelines 2019',
 'First-line for hypertension: ACE inhibitors or ARBs. Add calcium channel blocker (amlodipine) if not controlled. Thiazide diuretic as third-line. Target BP <130/80 in diabetics, <140/90 otherwise.',
 'hypertension,htn,amlodipine,ace_inhibitor,arb,bp', 'https://main.icmr.nic.in/sites/default/files/guidelines/ICMR_Hypertension.pdf', '2026-06-21 00:00:00'),
('kb-nice-ckd-001', 'NICE', 'NICE CKD Guideline NG203',
 'Check eGFR before starting ACE-i/ARB. Hold metformin if eGFR <30. Refer to nephrology if eGFR <30 or rapid decline (>5 ml/min/year). SGLT2 inhibitors recommended for CKD + DM.',
 'ckd,kidney,metformin,egfr,sglt2,nephrology', 'https://www.nice.org.uk/guidance/ng203', '2026-06-21 00:00:00'),
('kb-nice-asthma-001', 'NICE', 'NICE Asthma Guideline NG80',
 'Step 1: SABA PRN. Step 2: Add low-dose ICS. Step 3: Add LABA or increase ICS dose. Step 4: Add LAMA. Step 5: Refer to specialist.',
 'asthma,saba,ics,laba,lama,respiratory', 'https://www.nice.org.uk/guidance/ng80', '2026-06-21 00:00:00'),
('kb-who-anemia-001', 'WHO', 'WHO Iron Deficiency Anemia',
 'Adult men and postmenopausal women: investigate cause if Hb <13 g/dL. First-line: oral iron (ferrous sulphate 200mg TDS). Check response in 2-4 weeks.',
 'anemia,iron,hb,hemoglobin', 'https://www.who.int/health-topics/anaemia', '2026-06-21 00:00:00'),
('kb-icmr-tb-001', 'ICMR', 'ICMR TB Treatment Guidelines 2023',
 'Drug-sensitive TB: 2 months HRZE + 4 months HR (6 months total). Daily DOT preferred. Sputum smear at 2 months, end of treatment. CXR at diagnosis + end.',
 'tb,tuberculosis,hrze,dot,respiratory', 'https://tbcindia.gov.in/', '2026-06-21 00:00:00'),
('kb-aai-allergy-001', 'AAAAI', 'AAAAI Allergic Rhinitis Management',
 'Intranasal corticosteroid first-line for persistent symptoms. Add oral antihistamine for breakthrough. Consider allergen immunotherapy if refractory.',
 'allergy,rhinitis,intranasal,antihistamine,immunotherapy', 'https://www.aaaai.org/Conditions-Treatments/allergies/rhinitis', '2026-06-21 00:00:00'),
('kb-nice-pcos-001', 'NICE', 'NICE PCOS Guideline NG88',
 'First-line for hirsutism: combined OCP. For fertility: letrozole first-line ovulation induction. Lifestyle modification for metabolic features.',
 'pcos,ocp,letrozole,fertility,endocrine', 'https://www.nice.org.uk/guidance/ng88', '2026-06-21 00:00:00'),
('kb-india-preg-001', 'MoHFW', 'India Antenatal Care Guidelines',
 'First ANC visit: registration, Hb, urine, blood group, HIV, VDRL, OGTT 75g at 24-28 weeks. Iron + folic acid daily. Tetanus immunization. Calcium supplementation.',
 'pregnancy,anc,antenatal,ogtt,obgyn,india', 'https://main.mohfw.gov.in/', '2026-06-21 00:00:00'),
('kb-who-child-001', 'WHO', 'WHO IMCI Chart Booklet',
 'For children 2 months to 5 years: assess general danger signs, cough/difficulty breathing, diarrhea, fever, ear problem, malnutrition, anemia, immunization status.',
 'pediatric,imci,child,malnutrition,fever', 'https://www.who.int/publications/i/item/9241546445', '2026-06-21 00:00:00')
ON CONFLICT (doc_id) DO NOTHING;

-- Seed: one demo telemedicine session
INSERT INTO tele_sessions (session_id, patient_id, doctor_id, scheduled_at, status, channel, created_at)
SELECT
  'tele-' || patient_id,
  patient_id,
  'd-001',
  '2026-06-22 10:00:00',
  'scheduled',
  'webrtc',
  '2026-06-21 00:00:00'
FROM patients LIMIT 3
ON CONFLICT DO NOTHING;
