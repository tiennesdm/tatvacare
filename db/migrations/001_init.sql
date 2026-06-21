-- TatvaCare schema (v1) — runs over Vedadb's VBP wire (port 6381)
-- NO PG-wire, this is sent as SQL through VBP's QUERY opcode.

-- ============ DOCTORS ============
CREATE TABLE IF NOT EXISTS doctors (
  doctor_id          TEXT PRIMARY KEY,           -- UUID string
  full_name          TEXT NOT NULL,
  email              TEXT UNIQUE NOT NULL,
  phone              TEXT UNIQUE NOT NULL,
  password_hash      TEXT NOT NULL,              -- bcrypt/sha256 (we use sha256+pepper in v1 MVP)
  mci_reg_no         TEXT,                       -- Medical Council registration
  specialties        TEXT,                       -- comma-separated for v1 (JSON in v2)
  qualifications     TEXT,                       -- free text
  languages          TEXT DEFAULT 'en,hi',
  clinic_name        TEXT,
  clinic_address     TEXT,
  city               TEXT,
  state              TEXT,
  pincode            TEXT,
  phone_verified     INT DEFAULT 0,              -- 0/1
  email_verified     INT DEFAULT 0,
  is_active          INT DEFAULT 1,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

-- ============ PATIENTS ============
CREATE TABLE IF NOT EXISTS patients (
  patient_id         TEXT PRIMARY KEY,           -- UUID string
  abha_number        TEXT UNIQUE,                -- 14-digit ABHA
  full_name          TEXT NOT NULL,
  dob                DATE,
  gender             TEXT,                       -- M/F/O/U
  phone              TEXT UNIQUE NOT NULL,
  email              TEXT,
  blood_group        TEXT,
  address            TEXT,
  city               TEXT,
  emergency_name     TEXT,
  emergency_phone    TEXT,
  emergency_relation TEXT,
  insurance_provider TEXT,
  insurance_policy   TEXT,
  is_active          INT DEFAULT 1,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

-- ============ APPOINTMENTS ============
CREATE TABLE IF NOT EXISTS appointments (
  appt_id            TEXT PRIMARY KEY,
  patient_id         TEXT NOT NULL,
  doctor_id          TEXT NOT NULL,
  scheduled_at       TIMESTAMPTZ NOT NULL,
  duration_min       INT DEFAULT 15,
  type               TEXT DEFAULT 'opd',         -- opd/tele/walkin/followup
  status             TEXT DEFAULT 'scheduled',   -- scheduled/confirmed/in_progress/completed/cancelled/no_show
  reason             TEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT now()
);

-- ============ PRESCRIPTIONS ============
CREATE TABLE IF NOT EXISTS prescriptions (
  rx_id              TEXT PRIMARY KEY,
  rx_number          TEXT UNIQUE NOT NULL,
  patient_id         TEXT NOT NULL,
  doctor_id          TEXT NOT NULL,
  appt_id            TEXT,
  diagnosis_code     TEXT,                       -- ICD-10 e.g. E11.9
  diagnosis_label    TEXT,
  chief_complaint    TEXT,
  clinical_notes     TEXT,
  vitals_bp          TEXT,                       -- "120/80"
  vitals_pulse       INT,
  vitals_temp_c      REAL,
  vitals_spo2        INT,
  vitals_weight_kg   REAL,
  rx_items           TEXT NOT NULL,              -- JSON array as text
  lab_tests          TEXT,                       -- JSON array as text
  advice             TEXT,
  followup_in_days   INT,
  delivery_method    TEXT DEFAULT 'whatsapp',
  delivered_at       TIMESTAMPTZ,
  is_revoked         INT DEFAULT 0,
  revoked_reason     TEXT,
  created_at         TIMESTAMPTZ DEFAULT now()
);

-- ============ SESSIONS (auth) ============
CREATE TABLE IF NOT EXISTS sessions (
  session_id         TEXT PRIMARY KEY,           -- random 32 bytes hex
  doctor_id          TEXT NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  user_agent         TEXT,
  ip                 TEXT
);

-- ============ INDICES ============
CREATE INDEX IF NOT EXISTS idx_appointments_doctor_time ON appointments(doctor_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_time ON appointments(patient_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_rx_patient ON prescriptions(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rx_doctor ON prescriptions(doctor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
CREATE INDEX IF NOT EXISTS idx_doctors_phone ON doctors(phone);
CREATE INDEX IF NOT EXISTS idx_sessions_doctor ON sessions(doctor_id);
