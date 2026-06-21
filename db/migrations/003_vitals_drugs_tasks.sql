-- TatvaCare Phase 1+ DB additions: vitals, drugs, drug_interactions, allergies, problems, schedule
-- Pure VBP, runs on port 6381

-- ============ VITALS ============
CREATE TABLE IF NOT EXISTS vitals (
  vital_id        TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  source          TEXT DEFAULT 'manual',         -- manual / device:bt-bp / device:cgm / device:scale / wearable:fitbit
  bp_systolic     INT,
  bp_diastolic    INT,
  pulse           INT,
  temp_c          REAL,
  spo2            INT,
  weight_kg       REAL,
  height_cm       REAL,
  bmi             REAL,
  glucose_fasting INT,                            -- mg/dL
  glucose_pp      INT,                            -- post-prandial
  hba1c           REAL,                            -- %
  notes           TEXT,
  recorded_by     TEXT,                            -- patient_id or doctor_id
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vitals_patient_time ON vitals(patient_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_vitals_type_time ON vitals(recorded_at);

-- ============ DRUGS (Indian drug DB) ============
CREATE TABLE IF NOT EXISTS drugs (
  drug_id         TEXT PRIMARY KEY,
  name            TEXT NOT NULL,                 -- "Amlodipine"
  brand_names     TEXT,                          -- "Amlogard, Amlong, Stamlo"
  strength        TEXT,                          -- "5mg"
  form            TEXT,                          -- tablet / capsule / syrup / injection / inhaler
  category        TEXT,                          -- antihypertensive / antidiabetic / statin / ...
  atc_code        TEXT,                          -- "C08CA01"
  schedule        TEXT,                          -- H / H1 / X (D&C Act)
  rx_required     INT DEFAULT 1,
  is_active       INT DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drugs_name ON drugs(name);
CREATE INDEX IF NOT EXISTS idx_drugs_category ON drugs(category);

-- ============ DRUG INTERACTIONS ============
CREATE TABLE IF NOT EXISTS drug_interactions (
  interaction_id  TEXT PRIMARY KEY,
  drug_a          TEXT NOT NULL,
  drug_b          TEXT NOT NULL,
  severity        TEXT NOT NULL,                  -- minor / moderate / major / contraindicated
  mechanism       TEXT,                          -- "Increased risk of hyperkalemia"
  clinical_effect TEXT,                          -- "Concurrent use may cause..."
  recommendation  TEXT,                          -- "Monitor potassium levels..."
  evidence_level  TEXT DEFAULT 'theoretical'     -- theoretical / case-report / study
);
CREATE INDEX IF NOT EXISTS idx_interact_a ON drug_interactions(drug_a);
CREATE INDEX IF NOT EXISTS idx_interact_b ON drug_interactions(drug_b);

-- ============ PATIENT ALLERGIES ============
CREATE TABLE IF NOT EXISTS patient_allergies (
  allergy_id      TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL,
  allergen        TEXT NOT NULL,                  -- "Penicillin", "Sulfa drugs", "Latex"
  reaction        TEXT,                          -- "Rash", "Anaphylaxis"
  severity        TEXT DEFAULT 'mild',           -- mild / moderate / severe
  noted_at        TIMESTAMPTZ DEFAULT now(),
  noted_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_allergies_patient ON patient_allergies(patient_id);

-- ============ PATIENT PROBLEMS (problem list) ============
CREATE TABLE IF NOT EXISTS patient_problems (
  problem_id      TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL,
  icd10_code      TEXT,
  label           TEXT NOT NULL,
  status          TEXT DEFAULT 'active',         -- active / resolved / inactive
  onset_date      DATE,
  resolved_date   DATE,
  notes           TEXT,
  added_by        TEXT,                          -- doctor_id
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_problems_patient ON patient_problems(patient_id, status);

-- ============ SCHEDULE / APPOINTMENTS (extended) ============
CREATE TABLE IF NOT EXISTS schedule_slots (
  slot_id         TEXT PRIMARY KEY,
  doctor_id       TEXT NOT NULL,
  slot_date       DATE NOT NULL,
  slot_time       TIME NOT NULL,
  duration_min    INT DEFAULT 15,
  status          TEXT DEFAULT 'open',            -- open / booked / blocked / completed / cancelled
  patient_id      TEXT,                            -- nullable for open slots
  appt_type       TEXT DEFAULT 'opd',            -- opd / tele / followup
  appt_id         TEXT,                            -- link to appointments table
  reason          TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_slots_doctor_date ON schedule_slots(doctor_id, slot_date);

-- ============ TASKS / INBOX ============
CREATE TABLE IF NOT EXISTS doctor_tasks (
  task_id         TEXT PRIMARY KEY,
  doctor_id       TEXT NOT NULL,
  patient_id      TEXT,
  type            TEXT NOT NULL,                  -- lab_review / rx_refill / followup / note / referral
  title           TEXT NOT NULL,
  detail          TEXT,
  due_at          TIMESTAMPTZ,
  priority        TEXT DEFAULT 'normal',          -- low / normal / high / urgent
  status          TEXT DEFAULT 'open',            -- open / done / snoozed / dismissed
  ref_id          TEXT,                            -- link to lab/rx/etc
  created_at      TIMESTAMPTZ DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_doctor_status ON doctor_tasks(doctor_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON doctor_tasks(due_at) WHERE status = 'open';
