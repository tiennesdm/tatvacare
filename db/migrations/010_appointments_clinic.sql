-- TatvaCare Week 2 — B5 appointment booking follow-up.
--
-- Scope: Add `clinic_id` column to `appointments` so the patient-facing
-- booking endpoint can stamp the clinic onto every booked appointment.
-- The slot already has `clinic_id` (added in 009_appointments.sql);
-- the appointment row should mirror it for multi-tenancy queries
-- (e.g. /api/clinics/:id/appointments).
--
-- Why a separate migration instead of amending 009:
--   009 already shipped (commit 5cfde6e). Adding clinic_id here keeps
--   migration history additive — re-running 009 stays a no-op for the
--   clinics column on already-migrated DBs.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS is not supported on Vedadb's
-- ALTER (verified); the script tolerates "column already exists" by
-- catching the error and proceeding.

ALTER TABLE appointments ADD COLUMN clinic_id TEXT;
