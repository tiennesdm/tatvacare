-- TatvaCare P1.4 — PHI access log table (HIPAA §164.312(b) audit controls).
--
-- Separate from the general audit_log table so:
--   - Compliance officers can grant read on phi_access_log to a narrower
--     audience (separation of duties).
--   - Retention rules can differ (HIPAA = 6yr min; some states want 10yr
--     for clinical access trails).
--   - Query patterns differ: "all access for patient X" hits this table
--     directly via idx_phi_patient_time.
--
-- Columns:
--   id              — surrogate PK (autoincrement) for fast range scans.
--   ts              — UTC timestamp the request finished.
--   actor_kind      — 'doctor' | 'patient' | 'admin' (matches audit_log).
--   actor_id        — doctor_id / patient_id / admin user id.
--   clinic_id       — for multi-tenancy scoping (nullable for system actions).
--   patient_id      — the PHI owner. ALWAYS populated. Indexed.
--   action          — 'read' | 'create' | 'update' | 'delete' | 'export'.
--   resource_kind   — e.g. 'patient', 'patient_vitals_log', 'prescription_pdf'.
--   resource_id     — the row id, when applicable.
--   request_id      — correlates with the access log line (logger.mjs).
--   ip              — request IP (for forensic).
--
-- Append-only by convention — there is no UPDATE/DELETE policy because
-- HIPAA forbids rewriting the audit trail. The backend uses INSERT only.

CREATE TABLE IF NOT EXISTS phi_access_log (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
  actor_kind      TEXT NOT NULL,
  actor_id        TEXT,
  clinic_id       TEXT,
  patient_id      TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource_kind   TEXT NOT NULL,
  resource_id     TEXT,
  request_id      TEXT,
  ip              TEXT
);

-- Hot path: "show me everything that happened to patient X". This index
-- alone serves 90% of compliance queries.
CREATE INDEX IF NOT EXISTS idx_phi_patient_time ON phi_access_log(patient_id, ts DESC);

-- "Show me every PHI access by doctor Y in the last 30 days" — for
-- insider-threat reviews.
CREATE INDEX IF NOT EXISTS idx_phi_actor_time ON phi_access_log(actor_kind, actor_id, ts DESC);

-- Time-range scans (e.g. quarterly compliance review).
CREATE INDEX IF NOT EXISTS idx_phi_ts ON phi_access_log(ts DESC);
