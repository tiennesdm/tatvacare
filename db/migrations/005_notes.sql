-- ============ 005 NOTES (clinical notes per patient) ============
CREATE TABLE IF NOT EXISTS patient_notes (
  note_id       TEXT PRIMARY KEY,
  patient_id    TEXT NOT NULL,
  doctor_id     TEXT NOT NULL,
  note_type     TEXT NOT NULL DEFAULT 'clinical',  -- clinical | followup | instruction | phone_call
  body          TEXT NOT NULL,
  is_pinned     TEXT NOT NULL DEFAULT '0',
  created_at    TIMESTAMP NOT NULL,
  updated_at    TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_patient ON patient_notes(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_doctor  ON patient_notes(doctor_id);

-- Sample notes for the seeded patients
INSERT INTO patient_notes (note_id, patient_id, doctor_id, note_type, body, is_pinned, created_at, updated_at) VALUES
  ('n-001', 'p-001', 'd-001', 'clinical', 'Patient reports adherence to amlodipine 5mg OD. BP trend improving but still above target. Discussed dietary sodium reduction. Schedule lipid panel review in 2 weeks.', '0', '2026-06-14 11:30:00', '2026-06-14 11:30:00'),
  ('n-002', 'p-001', 'd-001', 'instruction', 'Patient has penicillin allergy (rash, moderate). Always confirm before prescribing beta-lactams. Consider macrolide alternative.', '1', '2026-06-14 11:35:00', '2026-06-14 11:35:00'),
  ('n-003', 'p-001', 'd-001', 'phone_call', 'Called patient 18 Jun 2026 to confirm BP home readings. Average 145/90. Reports occasional headache in mornings. Advised to log readings twice daily until next visit.', '0', '2026-06-18 17:45:00', '2026-06-18 17:45:00'),
  ('n-004', 'p-002', 'd-001', 'clinical', 'Initial consultation for type 2 DM. HbA1c 8.2, started metformin 500mg BD. Diet plan discussed, referred to dietitian. Follow-up in 4 weeks with repeat HbA1c.', '0', '2026-05-20 15:00:00', '2026-05-20 15:00:00'),
  ('n-005', 'p-002', 'd-001', 'followup', '4-week followup: HbA1c down to 7.4, weight loss 2kg. Continuing metformin. Adding empagliflozin 10mg OD if HbA1c not at target by next visit.', '0', '2026-06-20 14:00:00', '2026-06-20 14:00:00'),
  ('n-006', 'p-004', 'd-001', 'clinical', 'Asthma review. Using salbutamol PRN ~3x/week (poorly controlled per GINA). Stepping up to budesonide+formoterol 200/6mcg BID + SABA PRN. Asthma action plan issued.', '0', '2026-06-10 16:30:00', '2026-06-10 16:30:00');
