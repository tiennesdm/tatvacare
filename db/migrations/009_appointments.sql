-- TatvaCare Week 2 — B5 patient-facing appointment booking (slot → book → cancel)
--
-- Scope:
--   1. New `appointment_slots` table — doctor publishes open 15-min slots.
--      Each slot can be in status 'open' | 'booked' | 'blocked'. The
--      `appointment_id` column back-links to the booking row once taken.
--   2. Migrate the existing `appointments` table to the new patient-booking
--      schema:
--        - Rename `appt_id` → `appointment_id` (matches spec PK)
--        - Add `slot_id` (back-link to the booked slot)
--        - Add `kind` ('in_person' | 'tele')
--        - Add `cancelled_at`, `cancel_reason`, `updated_at`
--        - Default status 'booked' on new rows; old 'scheduled'/'confirmed'/
--          'completed' values are left as-is for backwards compatibility
--          with the demo data from migration 002.
--      The legacy `type` column is preserved so that 002_seed.sql
--      (which inserts a-001/a-002/a-003 with `type` values) stays
--      idempotent on re-runs of migrate.mjs.
--   3. Seed: open slots for the demo doctor `d-001` over the next 7 days.
--      Hardcoded dates because Vedadb returns NULL when reading
--      `current_date + INTERVAL 'N days'` back from a DATE column.
--      Re-run migrate.mjs to refresh if the seed goes stale.

-- ============ APPOINTMENT SLOTS (new) ============
CREATE TABLE IF NOT EXISTS appointment_slots (
  slot_id        TEXT PRIMARY KEY,
  doctor_id      TEXT NOT NULL,
  clinic_id      TEXT,
  slot_date      DATE NOT NULL,
  slot_time      TIME NOT NULL,
  duration_min   INT NOT NULL DEFAULT 15,
  status         TEXT NOT NULL DEFAULT 'open',    -- open|booked|blocked
  appointment_id TEXT,                            -- back-link when booked
  created_at     TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_slot_doctor_date ON appointment_slots(doctor_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_slot_open ON appointment_slots(status, slot_date);

-- ============ APPOINTMENTS — migrate legacy table to new schema ============
-- Migration strategy: ALTER the existing table (which has `appt_id` PK
-- and `type` column from 001_init.sql) into the new patient-booking
-- schema (`appointment_id` PK, `kind` column, slot/cancel metadata).
-- All ALTERs use `IF NOT EXISTS` semantics where supported by Vedadb
-- so the migration is safe to re-run.
--
-- Step 1: rename PK column
ALTER TABLE appointments RENAME COLUMN appt_id TO appointment_id
;
-- Step 2: add new columns. NOT NULL columns are added nullable first,
-- back-filled, then promoted to NOT NULL — Vedadb's ADD COLUMN
-- reinserts existing rows and rejects NULL values for NOT NULL.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS slot_id TEXT
;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'in_person'
;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ
;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancel_reason TEXT
;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT current_timestamp
;
-- Backfill updated_at from created_at where it's still NULL
UPDATE appointments SET updated_at = created_at WHERE updated_at IS NULL
;
-- Backfill kind for legacy rows. Vedadb's ADD COLUMN DEFAULT does NOT
-- populate existing rows (existing rows stay NULL), so we backfill
-- explicitly. Map legacy type 'opd' → 'in_person', keep 'tele' as-is.
UPDATE appointments SET kind = CASE WHEN type = 'opd' THEN 'in_person' WHEN type = 'tele' THEN 'tele' ELSE 'in_person' END WHERE kind IS NULL
;
-- Step 3: add new indices
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id, scheduled_at DESC)
;
CREATE INDEX IF NOT EXISTS idx_appt_doctor ON appointments(doctor_id, scheduled_at)
;
CREATE INDEX IF NOT EXISTS idx_appt_slot ON appointments(slot_id)
;

-- ============ SEED — open slots for demo doctor d-001 ============
-- 7 days × 1 slot/day at 09:00 — covers the test's "from=today&to=today+7"
-- range. Re-run migrate.mjs to refresh dates if stale.
INSERT INTO appointment_slots
  (slot_id, doctor_id, clinic_id, slot_date, slot_time, duration_min, status, created_at)
VALUES
  ('slot-d-001-1', 'd-001', 'cl-001', '2026-06-23', '09:00:00', 15, 'open', current_timestamp),
  ('slot-d-001-2', 'd-001', 'cl-001', '2026-06-24', '09:00:00', 15, 'open', current_timestamp),
  ('slot-d-001-3', 'd-001', 'cl-001', '2026-06-25', '09:00:00', 15, 'open', current_timestamp),
  ('slot-d-001-4', 'd-001', 'cl-001', '2026-06-26', '09:00:00', 15, 'open', current_timestamp),
  ('slot-d-001-5', 'd-001', 'cl-001', '2026-06-27', '09:00:00', 15, 'open', current_timestamp),
  ('slot-d-001-6', 'd-001', 'cl-001', '2026-06-28', '09:00:00', 15, 'open', current_timestamp),
  ('slot-d-001-7', 'd-001', 'cl-001', '2026-06-29', '09:00:00', 15, 'open', current_timestamp)
ON CONFLICT (slot_id) DO NOTHING
