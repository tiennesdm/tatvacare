-- TatvaCare Week 2 / B1 — medication adherence log
--
-- Patient self-reports each scheduled dose as taken / missed / skipped.
-- The streak and adherence_pct rollups are computed by the API endpoints
-- (POST/GET /api/patient/adherence*), so this table is intentionally
-- append-only with no triggers — every row is one dose outcome.

CREATE TABLE IF NOT EXISTS med_adherence (
  adherence_id  TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL,
  rx_id         TEXT,                              -- optional link to prescription
  drug_name     TEXT NOT NULL,                     -- denormalized for fast list
  dose          TEXT,                              -- e.g. "500mg"
  schedule_slot TEXT NOT NULL,                     -- morning|afternoon|evening|night|custom
  scheduled_at  TIMESTAMPTZ NOT NULL,              -- when dose was supposed to be taken
  taken_at      TIMESTAMPTZ,                       -- when patient marked taken
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|taken|missed|skipped
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_adherence_patient_time ON med_adherence(patient_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS idx_adherence_status ON med_adherence(patient_id, status);
