-- Indian drug DB seed + common drug interactions + sample vitals/problems
-- Pure SQL strings; no PG-wire needed (sent over VBP).

-- ============ DRUGS (50+ common Indian brands) ============
INSERT INTO drugs (drug_id, name, brand_names, strength, form, category, atc_code, schedule) VALUES
  -- Antihypertensives
  ('dr-amlod', 'Amlodipine', 'Amlogard, Amlong, Stamlo', '5mg', 'tablet', 'antihypertensive', 'C08CA01', 'H'),
  ('dr-amlod10', 'Amlodipine', 'Amlogard, Amlong, Stamlo', '10mg', 'tablet', 'antihypertensive', 'C08CA01', 'H'),
  ('dr-telmi', 'Telmisartan', 'Telma, Telsar, Telvas', '40mg', 'tablet', 'antihypertensive', 'C09CA07', 'H'),
  ('dr-telmi80', 'Telmisartan', 'Telma, Telsar, Telvas', '80mg', 'tablet', 'antihypertensive', 'C09CA07', 'H'),
  ('dr-losar', 'Losartan', 'Losar, Repace, Covance', '50mg', 'tablet', 'antihypertensive', 'C09CA01', 'H'),
  ('dr-enala', 'Enalapril', 'Envas, Enapril', '5mg', 'tablet', 'antihypertensive', 'C09AA02', 'H'),
  ('dr-aten', 'Atenolol', 'Aten, Tenormin, Betacard', '50mg', 'tablet', 'antihypertensive', 'C07AB03', 'H'),
  ('dr-metop', 'Metoprolol', 'Metolar, Seloken', '50mg', 'tablet', 'antihypertensive', 'C07AB02', 'H'),
  ('dr-hydro', 'Hydrochlorothiazide', 'Aquazide, HCTZ', '12.5mg', 'tablet', 'diuretic', 'C03AA03', 'H'),
  ('dr-furo', 'Furosemide', 'Lasix, Frusenex', '40mg', 'tablet', 'diuretic', 'C03CA01', 'H'),
  -- Antidiabetics
  ('dr-metf', 'Metformin', 'Glycomet, Glucophage, Obimet', '500mg', 'tablet', 'antidiabetic', 'A10BA02', 'H'),
  ('dr-metf1g', 'Metformin', 'Glycomet, Glucophage, Obimet', '1000mg', 'tablet', 'antidiabetic', 'A10BA02', 'H'),
  ('dr-glim', 'Glimepiride', 'Amaryl, Glimy, GP', '1mg', 'tablet', 'antidiabetic', 'A10BB12', 'H'),
  ('dr-glim2', 'Glimepiride', 'Amaryl, Glimy, GP', '2mg', 'tablet', 'antidiabetic', 'A10BB12', 'H'),
  ('dr-piog', 'Pioglitazone', 'Pioz, Glizone, Pioglit', '15mg', 'tablet', 'antidiabetic', 'A10BG03', 'H'),
  ('dr-sita', 'Sitagliptin', 'Januvia, Glactiv, Sitahenz', '100mg', 'tablet', 'antidiabetic', 'A10BH01', 'H'),
  ('dr-empag', 'Empagliflozin', 'Jardiance, Empaone', '10mg', 'tablet', 'antidiabetic', 'A10BK03', 'H'),
  ('dr-insuln', 'Insulin Glargine', 'Lantus, Basaglar, Glaritus', '100IU/ml', 'injection', 'antidiabetic', 'A10AE04', 'H'),
  -- Statins / Lipid
  ('dr-atorv', 'Atorvastatin', 'Atorva, Lipitor, Tonact', '10mg', 'tablet', 'statin', 'C10AA05', 'H'),
  ('dr-atorv40', 'Atorvastatin', 'Atorva, Lipitor, Tonact', '40mg', 'tablet', 'statin', 'C10AA05', 'H'),
  ('dr-rosuv', 'Rosuvastatin', 'Crestor, Rosuvas, Rosulip', '10mg', 'tablet', 'statin', 'C10AA07', 'H'),
  ('dr-simv', 'Simvastatin', 'Zocor, Simvas, Simlup', '20mg', 'tablet', 'statin', 'C10AA01', 'H'),
  -- Antiplatelet / Anticoagulant
  ('dr-aspir', 'Aspirin', 'Ecosprin, Disprin, ASA', '75mg', 'tablet', 'antiplatelet', 'B01AC06', 'H'),
  ('dr-aspir325', 'Aspirin', 'Ecosprin, Disprin', '325mg', 'tablet', 'antiplatelet', 'B01AC06', 'H'),
  ('dr-clop', 'Clopidogrel', 'Plavix, Clopilet, Deplatt', '75mg', 'tablet', 'antiplatelet', 'B01AC04', 'H'),
  ('dr-warf', 'Warfarin', 'Warf, Acenocoumarol', '5mg', 'tablet', 'anticoagulant', 'B01AA03', 'H'),
  -- Antibiotics
  ('dr-amox', 'Amoxicillin', 'Mox, Amoxil, Novamox', '500mg', 'capsule', 'antibiotic', 'J01CA04', 'H'),
  ('dr-augm', 'Amoxicillin + Clavulanate', 'Augmentin, Clavam, Moxikind-CV', '625mg', 'tablet', 'antibiotic', 'J01CR02', 'H'),
  ('dr-azith', 'Azithromycin', 'Azithral, Zithromax, Azee', '500mg', 'tablet', 'antibiotic', 'J01FA10', 'H'),
  ('dr-cefpo', 'Cefpodoxime', 'Cepodem, Cepodoc, Gudcef', '200mg', 'tablet', 'antibiotic', 'J01DD13', 'H'),
  ('dr-cip', 'Ciprofloxacin', 'Ciplox, Cifran, Ciprodac', '500mg', 'tablet', 'antibiotic', 'J01MA02', 'H'),
  ('dr-doxy', 'Doxycycline', 'Doxy, Vibramycin, Doxycept', '100mg', 'capsule', 'antibiotic', 'J01AA02', 'H'),
  -- GI
  ('dr-omep', 'Omeprazole', 'Omez, Prilosec, Omecip', '20mg', 'capsule', 'ppi', 'A02BC01', 'H'),
  ('dr-panto', 'Pantoprazole', 'Pantocid, Pantosec, Pan', '40mg', 'tablet', 'ppi', 'A02BC02', 'H'),
  ('dr-eso', 'Esomeprazole', 'Nexpro, Esoguard, Sompraz', '40mg', 'tablet', 'ppi', 'A02BC05', 'H'),
  ('dr-ondan', 'Ondansetron', 'Emeset, Zofran, Ondem', '4mg', 'tablet', 'antiemetic', 'A04AA01', 'H'),
  -- Respiratory
  ('dr-salb', 'Salbutamol', 'Asthalin, Ventolin, Salbair', '100mcg', 'inhaler', 'bronchodilator', 'R03AC02', 'H'),
  ('dr-bud', 'Budesonide + Formoterol', 'Foracort, Symbicort', '200mcg', 'inhaler', 'bronchodilator', 'R03AK07', 'H'),
  ('dr-mont', 'Montelukast', 'Montair, Montelukast, Singulair', '10mg', 'tablet', 'leukotriene', 'R03DC03', 'H'),
  ('dr-lorat', 'Loratadine', 'Loratin, Claritin, Alaspan', '10mg', 'tablet', 'antihistamine', 'R06AX13', 'H'),
  -- Pain / NSAID
  ('dr-para', 'Paracetamol', 'Crocin, Dolo, Calpol', '500mg', 'tablet', 'analgesic', 'N02BE01', 'H'),
  ('dr-para650', 'Paracetamol', 'Crocin, Dolo, Calpol', '650mg', 'tablet', 'analgesic', 'N02BE01', 'H'),
  ('dr-ibu', 'Ibuprofen', 'Brufen, Ibugesic', '400mg', 'tablet', 'nsaid', 'M01AE01', 'H'),
  ('dr-diclo', 'Diclofenac', 'Voveran, Diclofenac', '50mg', 'tablet', 'nsaid', 'M01AB05', 'H'),
  -- Thyroid
  ('dr-lev', 'Levothyroxine', 'Eltroxin, Lethyrox, Thyronorm', '50mcg', 'tablet', 'thyroid', 'H03AA01', 'H'),
  ('dr-lev100', 'Levothyroxine', 'Eltroxin, Lethyrox, Thyronorm', '100mcg', 'tablet', 'thyroid', 'H03AA01', 'H'),
  -- Vitamins
  ('dr-vitd', 'Cholecalciferol (Vit D3)', 'D-Rise, Uprise-D3, Tayo', '60K IU', 'sachet', 'supplement', 'A11CC05', 'OTC'),
  ('dr-vitb12', 'Methylcobalamin (Vit B12)', 'Methycobal, Nurokind, Meconerve', '1500mcg', 'tablet', 'supplement', 'B03BA05', 'OTC'),
  -- Iron
  ('dr-iron', 'Ferrous sulphate + Folic acid', 'Livogen, Fefol, Ferium', '100mg+1mg', 'tablet', 'iron', 'B03AD03', 'H'),
  -- Calcium
  ('dr-cal', 'Calcium carbonate + Vit D3', 'Shelcal, CCM, Calcirol', '500mg+250IU', 'tablet', 'supplement', 'A12AX', 'OTC'),
  -- PPIs + Antacids
  ('dr-ranit', 'Ranitidine', 'Rantac, Zinetac', '150mg', 'tablet', 'h2blocker', 'A02BA02', 'H'),
  -- Neuro
  ('dr-preg', 'Pregabalin', 'Lyrica, Pregabid, Maxgalin', '75mg', 'capsule', 'neuropathic-pain', 'N03AX16', 'H'),
  ('dr-gaba', 'Gabapentin', 'Neurontin, Gabapin, Gabatop', '300mg', 'capsule', 'neuropathic-pain', 'N03AX12', 'H'),
  -- Psychiatric
  ('dr-sert', 'Sertraline', 'Daxid, Zoloft, Daxid', '50mg', 'tablet', 'ssri', 'N06AB06', 'H'),
  ('dr-escit', 'Escitalopram', 'Nexito, Lexapro, Cilap', '10mg', 'tablet', 'ssri', 'N06AB10', 'H'),
  -- Erectile / Men's health
  ('dr-sild', 'Sildenafil', 'Viagra, Silagra, Manforce', '50mg', 'tablet', 'mens-health', 'G04BE03', 'H'),
  -- Women's health
  ('dr-mif', 'Mifepristone', 'Mifegest, MTPill', '200mg', 'tablet', 'womens-health', 'G03XB01', 'H');

-- ============ DRUG INTERACTIONS (top clinically important) ============
INSERT INTO drug_interactions (interaction_id, drug_a, drug_b, severity, mechanism, clinical_effect, recommendation) VALUES
  ('ix-amlod-simv', 'Amlodipine', 'Simvastatin', 'major', 'CYP3A4 inhibition', 'Increased simvastatin exposure → higher myopathy/rhabdomyolysis risk', 'Limit simvastatin to 20mg/day or switch to atorvastatin'),
  ('ix-amlod-atorv', 'Amlodipine', 'Atorvastatin', 'moderate', 'CYP3A4 inhibition', 'Increased atorvastatin levels', 'Monitor for muscle pain; limit atorvastatin to 20mg/day'),
  ('ix-warf-asp', 'Warfarin', 'Aspirin', 'major', 'Additive antiplatelet/anticoagulant effect', 'Significantly increased bleeding risk', 'Avoid combination unless cardiology indicated; use PPI cover'),
  ('ix-warf-amox', 'Warfarin', 'Amoxicillin', 'major', 'Altered gut flora reduces vitamin K synthesis', 'Elevated INR → bleeding risk', 'Monitor INR closely within 3-5 days of starting antibiotic'),
  ('ix-warf-cipro', 'Warfarin', 'Ciprofloxacin', 'major', 'CYP1A2/CYP2C9 inhibition', 'Significantly elevated INR', 'Reduce warfarin 30-50% and monitor INR every 2-3 days'),
  ('ix-warf-omep', 'Warfarin', 'Omeprazole', 'moderate', 'CYP2C19 inhibition (R-warfarin)', 'Modest INR increase', 'Monitor INR; consider pantoprazole instead'),
  ('ix-omep-clop', 'Omeprazole', 'Clopidogrel', 'major', 'CYP2C19 inhibition reduces clopidogrel activation', 'Reduced antiplatelet effect → CV event risk', 'Switch to pantoprazole/esomeprazole'),
  ('ix-metf-cipro', 'Metformin', 'Ciprofloxacin', 'moderate', 'Unclear; possible hypoglycemia/hypoglycemia risk', 'Glucose dysregulation', 'Monitor blood glucose during co-administration'),
  ('dr-iodinated_contrast', 'Metformin', 'Iodinated Contrast', 'major', 'Contrast-induced renal dysfunction → metformin accumulation', 'Lactic acidosis risk in CKD patients', 'Hold metformin 48h before contrast in eGFR<30'),
  ('ix-lisinopril-pot', 'Enalapril', 'Hydrochlorothiazide', 'moderate', 'Additive hypotensive effect', 'Excessive BP drop, AKI risk', 'Monitor BP and renal function; titrate slowly'),
  ('ix-clop-asa', 'Clopidogrel', 'Aspirin', 'moderate', 'Additive antiplatelet effect', 'Increased bleeding risk (DAPT can be intentional post-PCI)', 'Use lowest ASA dose; PPI cover'),
  ('ix-diclo-misoprostol', 'Diclofenac', 'Aspirin', 'moderate', 'Additive GI mucosal damage', 'Increased GI bleed/ulcer risk', 'Add PPI; avoid in active PUD'),
  ('ix-sert-tramadol', 'Sertraline', 'Tramadol', 'major', 'Serotonergic synergy', 'Serotonin syndrome risk', 'Avoid combination; use non-serotonergic analgesic'),
  ('ix-linezolid-ssri', 'Sertraline', 'Linezolid', 'contraindicated', 'MAOI-like effect + SSRI', 'Severe serotonin syndrome', 'Strict contraindication'),
  ('ix-mont-warf', 'Montelukast', 'Warfarin', 'minor', 'CYP2C9 induction (weak)', 'Possible slight INR decrease', 'Monitor INR; usually clinically insignificant'),
  ('ix-preg-opioid', 'Pregabalin', 'Tramadol', 'major', 'Additive CNS/respiratory depression', 'Severe sedation, respiratory depression', 'Avoid combination or use lowest doses with monitoring'),
  ('ix-lev-calcium', 'Levothyroxine', 'Calcium carbonate + Vit D3', 'moderate', 'Calcium reduces levothyroxine absorption', 'Reduced thyroid hormone effect', 'Separate doses by 4 hours'),
  ('ix-lev-iron', 'Levothyroxine', 'Ferrous sulphate + Folic acid', 'moderate', 'Iron chelates with levothyroxine', 'Reduced absorption of both', 'Separate doses by 4 hours'),
  ('ix-atorv-clarithro', 'Atorvastatin', 'Azithromycin', 'moderate', 'CYP3A4 inhibition (azithro mild)', 'Modest statin level increase', 'Monitor for myalgia; usually OK short-term');

-- ============ PROBLEMS (active problem list for seeded patients) ============
INSERT INTO patient_problems (problem_id, patient_id, icd10_code, label, status, onset_date) VALUES
  ('pr-001', 'p-001', 'I10', 'Essential hypertension', 'active', '2022-03-15'),
  ('pr-002', 'p-001', 'E78.5', 'Hyperlipidemia', 'active', '2023-01-10'),
  ('pr-003', 'p-002', 'I10', 'Essential hypertension', 'active', '2024-06-20'),
  ('pr-004', 'p-003', 'E11.9', 'Type 2 diabetes mellitus', 'active', '2021-08-05'),
  ('pr-005', 'p-003', 'E66.9', 'Obesity', 'active', '2020-12-01'),
  ('pr-006', 'p-004', 'J45.9', 'Asthma, unspecified', 'active', '2018-09-10'),
  ('pr-007', 'p-005', 'I10', 'Essential hypertension', 'active', '2024-02-28'),
  ('pr-008', 'p-005', 'E11.9', 'Type 2 diabetes mellitus', 'active', '2025-08-15');

-- ============ ALLERGIES ============
INSERT INTO patient_allergies (allergy_id, patient_id, allergen, reaction, severity) VALUES
  ('al-001', 'p-001', 'Penicillin', 'Rash', 'moderate'),
  ('al-002', 'p-003', 'Sulfa drugs', 'Hives', 'mild'),
  ('al-003', 'p-004', 'NSAIDs', 'GI upset', 'mild');

-- ============ VITALS (last 6 months for p-001 - hypertension) ============
INSERT INTO vitals (vital_id, patient_id, recorded_at, source, bp_systolic, bp_diastolic, pulse, weight_kg, glucose_fasting) VALUES
  ('vt-001', 'p-001', '2026-01-15 09:00:00+00', 'manual', 158, 96, 78, 78.5, 110),
  ('vt-002', 'p-001', '2026-02-10 09:00:00+00', 'manual', 152, 94, 76, 77.8, 108),
  ('vt-003', 'p-001', '2026-03-12 09:00:00+00', 'device:bt-bp', 148, 92, 80, 77.0, NULL),
  ('vt-004', 'p-001', '2026-04-08 09:00:00+00', 'device:bt-bp', 146, 90, 78, 76.2, 105),
  ('vt-005', 'p-001', '2026-05-10 09:00:00+00', 'manual', 150, 95, 82, 68.5, 110),
  ('vt-006', 'p-001', '2026-06-14 10:00:00+00', 'manual', 150, 95, 82, 68.5, 110);

INSERT INTO vitals (vital_id, patient_id, recorded_at, source, bp_systolic, bp_diastolic, pulse, weight_kg, glucose_fasting, glucose_pp, hba1c) VALUES
  ('vt-101', 'p-002', '2026-01-20 10:00:00+00', 'manual', 162, 98, 80, 72.0, NULL, NULL, NULL),
  ('vt-102', 'p-002', '2026-02-18 10:00:00+00', 'manual', 158, 96, 78, 71.5, NULL, NULL, NULL),
  ('vt-103', 'p-002', '2026-03-22 10:00:00+00', 'manual', 154, 94, 76, 70.8, NULL, NULL, NULL),
  ('vt-104', 'p-002', '2026-04-19 10:00:00+00', 'device:bt-bp', 150, 95, 82, 68.5, 110, NULL, NULL),
  ('vt-105', 'p-002', '2026-05-17 10:00:00+00', 'device:bt-bp', 148, 92, 80, 68.0, 108, NULL, NULL),
  ('vt-106', 'p-002', '2026-06-14 10:00:00+00', 'manual', 150, 95, 82, 68.5, 110, 145, 7.8);

INSERT INTO vitals (vital_id, patient_id, recorded_at, source, weight_kg, glucose_fasting, glucose_pp, hba1c) VALUES
  ('vt-201', 'p-003', '2026-01-10 08:00:00+00', 'device:scale', 88.0, 165, 220, 8.4),
  ('vt-202', 'p-003', '2026-02-08 08:00:00+00', 'device:scale', 86.5, 158, 210, 8.2),
  ('vt-203', 'p-003', '2026-03-12 08:00:00+00', 'device:cgm', 85.2, 152, 198, 7.9),
  ('vt-204', 'p-003', '2026-04-09 08:00:00+00', 'device:scale', 84.0, 145, 188, 7.6),
  ('vt-205', 'p-003', '2026-05-15 08:00:00+00', 'device:cgm', 82.8, 138, 178, 7.3),
  ('vt-206', 'p-003', '2026-06-18 09:00:00+00', 'device:cgm', 82.0, NULL, NULL, NULL);

-- ============ SCHEDULE SLOTS (today + this week for d-001) ============
INSERT INTO schedule_slots (slot_id, doctor_id, slot_date, slot_time, duration_min, status, patient_id, appt_type, reason) VALUES
  ('sl-001', 'd-001', CURRENT_DATE, '10:00:00', 20, 'booked', 'p-001', 'opd', 'BP follow-up'),
  ('sl-002', 'd-001', CURRENT_DATE, '10:30:00', 15, 'booked', 'p-002', 'followup', 'Med refill'),
  ('sl-003', 'd-001', CURRENT_DATE, '11:00:00', 30, 'open', NULL, 'opd', NULL),
  ('sl-004', 'd-001', CURRENT_DATE, '14:00:00', 20, 'booked', 'p-004', 'tele', 'Asthma review'),
  ('sl-005', 'd-001', CURRENT_DATE, '15:00:00', 15, 'blocked', NULL, 'opd', NULL),
  ('sl-006', 'd-001', CURRENT_DATE + 1, '09:30:00', 15, 'open', NULL, 'opd', NULL),
  ('sl-007', 'd-001', CURRENT_DATE + 1, '10:00:00', 30, 'open', NULL, 'opd', NULL);

-- ============ DOCTOR TASKS (inbox) ============
INSERT INTO doctor_tasks (task_id, doctor_id, patient_id, type, title, detail, due_at, priority) VALUES
  ('tk-001', 'd-001', 'p-001', 'lab_review', 'Review lipid panel', 'Lipid panel ordered 14 Jun 2026 — results pending', '2026-06-22 18:00:00+00', 'normal'),
  ('tk-002', 'd-001', 'p-002', 'followup', 'BP recheck due', 'Patient advised 2-week BP recheck after medication change', '2026-06-28 18:00:00+00', 'high'),
  ('tk-003', 'd-001', 'p-001', 'rx_refill', 'Amlodipine refill request', 'Patient requested refill via WhatsApp', '2026-06-22 18:00:00+00', 'normal'),
  ('tk-004', 'd-001', 'p-004', 'note', 'Add asthma action plan', 'Draft personalized asthma action plan', '2026-06-25 18:00:00+00', 'normal');
