// Common Indian clinical ICD-10 codes used in primary care
// Sources: WHO ICD-10, common Indian EMR presets
// 80+ codes covering the most-used diagnoses
export const ICD10_CODES = [
  // Endocrine / metabolic
  { code: 'E11.9', label: 'Type 2 diabetes mellitus without complications', category: 'Endocrine' },
  { code: 'E11.0', label: 'Type 2 diabetes mellitus with hyperosmolarity', category: 'Endocrine' },
  { code: 'E11.5', label: 'Type 2 diabetes mellitus with peripheral circulatory complications', category: 'Endocrine' },
  { code: 'E10.9', label: 'Type 1 diabetes mellitus without complications', category: 'Endocrine' },
  { code: 'E78.5', label: 'Hyperlipidaemia, unspecified', category: 'Endocrine' },
  { code: 'E03.9', label: 'Hypothyroidism, unspecified', category: 'Endocrine' },
  { code: 'E05.9', label: 'Thyrotoxicosis, unspecified', category: 'Endocrine' },
  { code: 'E66.9', label: 'Obesity, unspecified', category: 'Endocrine' },
  { code: 'E46',   label: 'Unspecified protein-energy malnutrition', category: 'Endocrine' },
  { code: 'E87.6', label: 'Hypokalaemia', category: 'Endocrine' },
  { code: 'E16.2', label: 'Hypoglycaemia, unspecified', category: 'Endocrine' },

  // Cardiovascular
  { code: 'I10',   label: 'Essential (primary) hypertension', category: 'Cardiovascular' },
  { code: 'I15.9', label: 'Secondary hypertension, unspecified', category: 'Cardiovascular' },
  { code: 'I20.9', label: 'Angina pectoris, unspecified', category: 'Cardiovascular' },
  { code: 'I21.9', label: 'Acute myocardial infarction, unspecified', category: 'Cardiovascular' },
  { code: 'I25.9', label: 'Chronic ischaemic heart disease, unspecified', category: 'Cardiovascular' },
  { code: 'I48.9', label: 'Atrial fibrillation and atrial flutter, unspecified', category: 'Cardiovascular' },
  { code: 'I50.9', label: 'Heart failure, unspecified', category: 'Cardiovascular' },
  { code: 'I63.9', label: 'Cerebral infarction, unspecified', category: 'Cardiovascular' },
  { code: 'I83.9', label: 'Varicose veins of lower extremity without ulcer or inflammation', category: 'Cardiovascular' },
  { code: 'I95.9', label: 'Hypotension, unspecified', category: 'Cardiovascular' },

  // Respiratory
  { code: 'J45.9', label: 'Asthma, unspecified', category: 'Respiratory' },
  { code: 'J44.9', label: 'Chronic obstructive pulmonary disease, unspecified', category: 'Respiratory' },
  { code: 'J18.9', label: 'Pneumonia, unspecified organism', category: 'Respiratory' },
  { code: 'J06.9', label: 'Acute upper respiratory infection, unspecified', category: 'Respiratory' },
  { code: 'J02.9', label: 'Acute pharyngitis, unspecified', category: 'Respiratory' },
  { code: 'J00',   label: 'Acute nasopharyngitis (common cold)', category: 'Respiratory' },
  { code: 'J30.9', label: 'Allergic rhinitis, unspecified', category: 'Respiratory' },
  { code: 'J40',   label: 'Bronchitis, not specified as acute or chronic', category: 'Respiratory' },
  { code: 'J96.0', label: 'Acute respiratory failure', category: 'Respiratory' },
  { code: 'R05',   label: 'Cough', category: 'Respiratory' },

  // GI
  { code: 'K21.9', label: 'Gastro-oesophageal reflux disease without oesophagitis', category: 'Gastrointestinal' },
  { code: 'K29.7', label: 'Gastritis, unspecified', category: 'Gastrointestinal' },
  { code: 'K35.8', label: 'Acute appendicitis, other and unspecified', category: 'Gastrointestinal' },
  { code: 'K52.9', label: 'Noninfective gastroenteritis and colitis, unspecified', category: 'Gastrointestinal' },
  { code: 'K59.0', label: 'Constipation', category: 'Gastrointestinal' },
  { code: 'K76.0', label: 'Fatty (change of) liver, not elsewhere classified', category: 'Gastrointestinal' },
  { code: 'K80.2', label: 'Calculus of gallbladder without cholecystitis', category: 'Gastrointestinal' },
  { code: 'K92.2', label: 'Gastrointestinal haemorrhage, unspecified', category: 'Gastrointestinal' },
  { code: 'R10.4', label: 'Other and unspecified abdominal pain', category: 'Gastrointestinal' },
  { code: 'R11',   label: 'Nausea and vomiting', category: 'Gastrointestinal' },

  // Genitourinary
  { code: 'N18.9', label: 'Chronic kidney disease, unspecified', category: 'Genitourinary' },
  { code: 'N20.0', label: 'Calculus of kidney', category: 'Genitourinary' },
  { code: 'N39.0', label: 'Urinary tract infection, site not specified', category: 'Genitourinary' },
  { code: 'N40',   label: 'Hyperplasia of prostate', category: 'Genitourinary' },

  // Musculoskeletal
  { code: 'M79.1', label: 'Myalgia', category: 'Musculoskeletal' },
  { code: 'M25.5', label: 'Pain in joint', category: 'Musculoskeletal' },
  { code: 'M54.5', label: 'Low back pain', category: 'Musculoskeletal' },
  { code: 'M81.0', label: 'Postmenopausal osteoporosis', category: 'Musculoskeletal' },
  { code: 'M10.9', label: 'Gout, unspecified', category: 'Musculoskeletal' },
  { code: 'M17.9', label: 'Gonarthrosis, unspecified', category: 'Musculoskeletal' },

  // Neurology
  { code: 'G40.9', label: 'Epilepsy, unspecified', category: 'Neurology' },
  { code: 'G43.9', label: 'Migraine, unspecified', category: 'Neurology' },
  { code: 'G44.1', label: 'Vascular headache, not elsewhere classified', category: 'Neurology' },
  { code: 'G47.0', label: 'Disorders of initiating and maintaining sleep (insomnia)', category: 'Neurology' },
  { code: 'G62.9', label: 'Polyneuropathy, unspecified', category: 'Neurology' },

  // Mental / behavioural
  { code: 'F32.9', label: 'Depressive episode, unspecified', category: 'Mental Health' },
  { code: 'F41.1', label: 'Generalised anxiety disorder', category: 'Mental Health' },
  { code: 'F41.9', label: 'Anxiety disorder, unspecified', category: 'Mental Health' },
  { code: 'F51.0', label: 'Nonorganic insomnia', category: 'Mental Health' },
  { code: 'F20.9', label: 'Schizophrenia, unspecified', category: 'Mental Health' },

  // Dermatological
  { code: 'L20.9', label: 'Atopic dermatitis, unspecified', category: 'Dermatology' },
  { code: 'L30.9', label: 'Dermatitis, unspecified', category: 'Dermatology' },
  { code: 'L40.9', label: 'Psoriasis, unspecified', category: 'Dermatology' },
  { code: 'L23.9', label: 'Allergic contact dermatitis, unspecified cause', category: 'Dermatology' },
  { code: 'L50.9', label: 'Urticaria, unspecified', category: 'Dermatology' },

  // Infectious
  { code: 'A09.0', label: 'Other and unspecified gastroenteritis and colitis of infectious origin', category: 'Infectious' },
  { code: 'A15.0', label: 'Tuberculosis of lung', category: 'Infectious' },
  { code: 'B19.9', label: 'Unspecified viral hepatitis without hepatic coma', category: 'Infectious' },
  { code: 'B34.9', label: 'Viral infection, unspecified', category: 'Infectious' },
  { code: 'A41.9', label: 'Sepsis, unspecified organism', category: 'Infectious' },

  // Gyn / OB
  { code: 'O80',   label: 'Single spontaneous delivery', category: 'Obstetrics' },
  { code: 'N92.6', label: 'Irregular menstruation, unspecified', category: 'Gynaecology' },
  { code: 'N95.1', label: 'Menopausal and female climacteric states', category: 'Gynaecology' },

  // General / symptoms
  { code: 'R50.9', label: 'Fever, unspecified', category: 'Symptoms' },
  { code: 'R51',   label: 'Headache', category: 'Symptoms' },
  { code: 'R42',   label: 'Dizziness and giddiness', category: 'Symptoms' },
  { code: 'R53',   label: 'Malaise and fatigue', category: 'Symptoms' },
  { code: 'R10.1', label: 'Pain localised to upper abdomen', category: 'Symptoms' },
  { code: 'R07.9', label: 'Chest pain, unspecified', category: 'Symptoms' },
  { code: 'R00.0', label: 'Tachycardia, unspecified', category: 'Symptoms' },
  { code: 'R69',   label: 'Unknown and unspecified causes of morbidity', category: 'Symptoms' },

  // Eye / ENT
  { code: 'H66.9', label: 'Otitis media, unspecified', category: 'ENT' },
  { code: 'H10.9', label: 'Unspecified conjunctivitis', category: 'Eye' },
  { code: 'H52.4', label: 'Presbyopia', category: 'Eye' },

  // Blood
  { code: 'D50.9', label: 'Iron deficiency anaemia, unspecified', category: 'Haematology' },
  { code: 'D64.9', label: 'Anaemia, unspecified', category: 'Haematology' },

  // Renal
  { code: 'N04.9', label: 'Nephrotic syndrome, unspecified', category: 'Renal' },
];
