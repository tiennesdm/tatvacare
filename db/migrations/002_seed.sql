-- Seed data for TatvaCare MVP — 3 doctors, 5 patients, 2 appointments, 2 prescriptions
-- Password for all demo doctors: "tatva123" (sha256 hash below)
-- sha256("tatva123") = e9f48b9c1b2e6f8d4a5c3b7e9d0a1f2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f (this is just placeholder, computed live)

INSERT INTO doctors (doctor_id, full_name, email, phone, password_hash, mci_reg_no, specialties, qualifications, languages, clinic_name, clinic_address, city, state, pincode) VALUES
  ('d-001', 'Dr. Priya Sharma', 'priya@tatvacare.demo', '+919876500001', 'PLACEHOLDER_HASH', 'MCI/2018/12345', 'Cardiology,Internal Medicine', 'MBBS, MD (Internal Medicine), DM (Cardiology)', 'en,hi,mr', 'Heart & Health Clinic', '12, MG Road, Bandra West', 'Mumbai', 'Maharashtra', '400050'),
  ('d-002', 'Dr. Rajesh Verma', 'rajesh@tatvacare.demo', '+919876500002', 'PLACEHOLDER_HASH', 'MCI/2015/54321', 'General Medicine,Diabetes', 'MBBS, MD', 'en,hi', 'Family Care Clinic', '45, Park Street', 'Kolkata', 'West Bengal', '700016'),
  ('d-003', 'Dr. Anjali Iyer', 'anjali@tatvacare.demo', '+919876500003', 'PLACEHOLDER_HASH', 'MCI/2020/99887', 'Pediatrics', 'MBBS, DCH', 'en,hi,ta', 'Little Stars Clinic', '78, T Nagar', 'Chennai', 'Tamil Nadu', '600017');

INSERT INTO patients (patient_id, abha_number, full_name, dob, gender, phone, email, blood_group, address, city, emergency_name, emergency_phone, emergency_relation) VALUES
  ('p-001', '14-3344-5566-7788', 'Rakesh Kumar', '1978-04-12', 'M', '+919812345670', 'rakesh@example.com', 'B+', 'A-12, Lajpat Nagar', 'New Delhi', 'Sunita Kumar', '+919812345671', 'Wife'),
  ('p-002', '14-3344-5566-7799', 'Meera Patel', '1985-09-23', 'F', '+919812345672', 'meera@example.com', 'O+', 'B-7, Satellite', 'Ahmedabad', 'Jay Patel', '+919812345673', 'Husband'),
  ('p-003', '14-3344-5566-7800', 'Suresh Reddy', '1962-12-05', 'M', '+919812345674', 'suresh@example.com', 'A+', 'Plot 23, Jubilee Hills', 'Hyderabad', 'Lakshmi Reddy', '+919812345675', 'Daughter'),
  ('p-004', '14-3344-5566-7811', 'Anita Singh', '1992-07-18', 'F', '+919812345676', 'anita@example.com', 'AB+', '14, Civil Lines', 'Jaipur', 'Rohit Singh', '+919812345677', 'Brother'),
  ('p-005', '14-3344-5566-7822', 'Vikram Joshi', '1970-02-28', 'M', '+919812345678', 'vikram@example.com', 'O-', 'C-8, Koregaon Park', 'Pune', 'Priya Joshi', '+919812345679', 'Wife');

-- TatvaCare Week 2 — appointments table was migrated to a new schema
-- in 009_appointments.sql (PK renamed appt_id → appointment_id, added
-- `kind` column alongside the legacy `type` column, added slot/cancel
-- metadata). This seed insert targets the post-009 schema:
--   - `appointment_id` instead of `appt_id`
--   - `kind` set to 'in_person' | 'tele' (mirror of legacy `type`)
-- The legacy `type` column is still present and gets the original value
-- so any code that still reads it (e.g. doctor-side calendar) keeps
-- working.
INSERT INTO appointments (appointment_id, patient_id, doctor_id, scheduled_at, type, kind, status, reason) VALUES
  ('a-001', 'p-001', 'd-001', now() + interval '1 day', 'opd', 'in_person', 'confirmed', 'Routine cardiac follow-up'),
  ('a-002', 'p-003', 'd-002', now() + interval '3 day', 'tele', 'tele', 'scheduled', 'Diabetes management review'),
  ('a-003', 'p-002', 'd-001', now() - interval '7 day', 'opd', 'in_person', 'completed', 'Initial consultation');

INSERT INTO prescriptions (rx_id, rx_number, patient_id, doctor_id, appt_id, diagnosis_code, diagnosis_label, chief_complaint, vitals_bp, vitals_pulse, vitals_spo2, vitals_weight_kg, rx_items, advice, followup_in_days, delivery_method, delivered_at, created_at) VALUES
  ('r-001', 'TC-2026-000001', 'p-002', 'd-001', 'a-003', 'I10', 'Essential hypertension', 'Headaches, dizziness on exertion', '150/95', 82, 97, 68.5, '[{"drug":"Amlodipine","dose":"5mg","frequency":"OD","duration":30,"instruction":"After breakfast"},{"drug":"Telmisartan","dose":"40mg","frequency":"OD","duration":30,"instruction":"Morning"}]', 'Reduce salt intake. Walk 30 min daily. Recheck BP after 2 weeks.', 14, 'whatsapp', '2026-06-14 10:00:00+00', '2026-06-14 10:00:00+00'),
  ('r-002', 'TC-2026-000002', 'p-003', 'd-002', NULL, 'E11.9', 'Type 2 diabetes mellitus without complications', 'Increased thirst, fatigue', '130/80', 78, 98, 82.0, '[{"drug":"Metformin","dose":"500mg","frequency":"BD","duration":30,"instruction":"After meals"},{"drug":"Glimepiride","dose":"1mg","frequency":"OD","duration":30,"instruction":"Before breakfast"}]', 'Low glycemic diet. 30 min brisk walk daily. Monitor fasting sugar weekly.', 30, 'app', '2026-06-18 09:00:00+00', '2026-06-18 09:00:00+00');
