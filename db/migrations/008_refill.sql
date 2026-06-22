-- TatvaCare Week 2 B2 — medication refill request workflow
--
-- A patient self-reports a refill request for a chronic medication. The
-- request goes to a doctor's inbox (status='pending'), where the doctor
-- can approve / reject / mark fulfilled. Decided rows carry
-- decided_at + decided_by for audit + patient timeline display.
--
-- Also adds patients.clinic_id (multi-tenancy scoping for doctor inbox).
-- Migration 006 added the column to doctors but skipped patients — the
-- GET /api/refill/pending route needs patients.clinic_id to scope the
-- doctor's inbox by clinic. Without this, the JOIN-on-p.clinic_id path
-- silently returns every pending request to every doctor.

ALTER TABLE patients ADD COLUMN IF NOT EXISTS clinic_id TEXT;
CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id);
UPDATE patients SET clinic_id = 'cl-001' WHERE clinic_id IS NULL;

CREATE TABLE IF NOT EXISTS refill_requests (
  request_id    TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL,
  rx_id         TEXT,                              -- optional link to prescription
  drug_name     TEXT NOT NULL,
  current_stock INT,                               -- patient's reported days-of-stock left
  requested_qty INT,                               -- packs/boxes requested
  urgency       TEXT NOT NULL DEFAULT 'normal',    -- low|normal|high|urgent
  pharmacy      TEXT,                              -- preferred pharmacy name (optional)
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|rejected|fulfilled|cancelled
  doctor_notes  TEXT,
  patient_notes TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  decided_at    TIMESTAMPTZ,
  decided_by    TEXT                               -- doctor_id
);
CREATE INDEX IF NOT EXISTS idx_refill_patient ON refill_requests(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refill_status ON refill_requests(status, created_at DESC);
