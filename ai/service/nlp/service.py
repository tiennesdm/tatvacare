"""Clinical NLP service — BioClinicalBERT NER + ICD-10 auto-suggest.

For entity extraction, we use a rules + dictionary approach because
BioClinicalBERT is heavy to load on every request. The transformer
model is loaded lazily on first call to /nlp/extract-entities and
cached.

Honest limitation: We use rules+regex as primary path (fast, no GPU,
transparent). The BioClinicalBERT path is OPT-IN via the request flag
`use_model: true`. When model load fails or model unavailable, we
fall back to rules with a 'method: rules' marker in the response.
"""
from __future__ import annotations
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

# Lazy model loader
_MODEL = None
_TOKENIZER = None


def _load_model():
    global _MODEL, _TOKENIZER
    if _MODEL is not None:
        return _MODEL, _TOKENIZER
    try:
        from transformers import AutoTokenizer, AutoModelForTokenClassification
        from ..config import CLINICAL_BERT_MODEL
        _TOKENIZER = AutoTokenizer.from_pretrained(CLINICAL_BERT_MODEL)
        _MODEL = AutoModelForTokenClassification.from_pretrained(CLINICAL_BERT_MODEL)
        return _MODEL, _TOKENIZER
    except Exception as e:
        print(f"[nlp] BioClinicalBERT load failed: {e}")
        return None, None


# Lazy ICD-10 codes
_ICD10 = None


# Fallback ICD-10 list (used if backend import fails — about 80 common codes)
_FALLBACK_ICD10 = [
    {"code": "E11.9", "description": "Type 2 diabetes mellitus without complications",
     "category": "Endocrine", "keywords": ["diabetes", "dm", "type 2 dm", "t2dm", "type ii dm", "sugar"]},
    {"code": "E10.9", "description": "Type 1 diabetes mellitus without complications",
     "category": "Endocrine", "keywords": ["diabetes", "dm", "type 1 dm", "t1dm", "insulin-dependent"]},
    {"code": "I10", "description": "Essential (primary) hypertension",
     "category": "Cardiovascular", "keywords": ["hypertension", "htn", "high bp", "high blood pressure"]},
    {"code": "I20.9", "description": "Angina pectoris, unspecified",
     "category": "Cardiovascular", "keywords": ["angina", "chest pain", "ischemic heart"]},
    {"code": "I48.91", "description": "Atrial fibrillation, unspecified",
     "category": "Cardiovascular", "keywords": ["afib", "atrial fibrillation", "irregular heartbeat"]},
    {"code": "I50.9", "description": "Heart failure, unspecified",
     "category": "Cardiovascular", "keywords": ["heart failure", "chf", "congestive heart"]},
    {"code": "J45.909", "description": "Asthma, unspecified, uncomplicated",
     "category": "Respiratory", "keywords": ["asthma", "wheezing", "bronchospasm"]},
    {"code": "J44.9", "description": "Chronic obstructive pulmonary disease, unspecified",
     "category": "Respiratory", "keywords": ["copd", "chronic bronchitis", "emphysema"]},
    {"code": "J18.9", "description": "Pneumonia, unspecified organism",
     "category": "Respiratory", "keywords": ["pneumonia", "lung infection"]},
    {"code": "J06.9", "description": "Acute upper respiratory infection, unspecified",
     "category": "Respiratory", "keywords": ["uri", "upper respiratory", "cold"]},
    {"code": "K21.9", "description": "Gastro-esophageal reflux disease without esophagitis",
     "category": "Gastrointestinal", "keywords": ["gerd", "acid reflux", "heartburn"]},
    {"code": "K29.70", "description": "Gastritis, unspecified, without bleeding",
     "category": "Gastrointestinal", "keywords": ["gastritis", "stomach pain"]},
    {"code": "N39.0", "description": "Urinary tract infection, site not specified",
     "category": "Genitourinary", "keywords": ["uti", "urinary tract infection", "burning urination"]},
    {"code": "M79.3", "description": "Panniculitis, unspecified",
     "category": "Musculoskeletal", "keywords": ["body ache", "bodyache"]},
    {"code": "M25.50", "description": "Pain in unspecified joint",
     "category": "Musculoskeletal", "keywords": ["joint pain", "arthralgia"]},
    {"code": "G43.909", "description": "Migraine, unspecified, not intractable",
     "category": "Neurological", "keywords": ["migraine", "headache"]},
    {"code": "G40.909", "description": "Epilepsy, unspecified, not intractable",
     "category": "Neurological", "keywords": ["epilepsy", "seizure", "fit"]},
    {"code": "F32.9", "description": "Major depressive disorder, single episode, unspecified",
     "category": "Mental Health", "keywords": ["depression", "depressed mood", "low mood"]},
    {"code": "F41.1", "description": "Generalized anxiety disorder",
     "category": "Mental Health", "keywords": ["anxiety", "anxious", "panic"]},
    {"code": "L20.9", "description": "Atopic dermatitis, unspecified",
     "category": "Dermatology", "keywords": ["eczema", "atopic dermatitis"]},
    {"code": "R50.9", "description": "Fever, unspecified",
     "category": "Symptoms", "keywords": ["fever", "pyrexia"]},
    {"code": "R51", "description": "Headache",
     "category": "Symptoms", "keywords": ["headache", "head pain"]},
    {"code": "R05", "description": "Cough",
     "category": "Symptoms", "keywords": ["cough", "tussis"]},
    {"code": "E78.5", "description": "Hyperlipidemia, unspecified",
     "category": "Endocrine", "keywords": ["cholesterol", "high cholesterol", "hyperlipidemia"]},
    {"code": "E03.9", "description": "Hypothyroidism, unspecified",
     "category": "Endocrine", "keywords": ["hypothyroid", "low thyroid"]},
    {"code": "D50.9", "description": "Iron deficiency anemia, unspecified",
     "category": "Hematology", "keywords": ["anemia", "low hb", "iron deficiency"]},
    {"code": "N18.9", "description": "Chronic kidney disease, unspecified",
     "category": "Renal", "keywords": ["ckd", "chronic kidney", "kidney disease"]},
    {"code": "E11.65", "description": "Type 2 diabetes mellitus with hyperglycemia",
     "category": "Endocrine", "keywords": ["hyperglycemia", "high sugar"]},
    {"code": "E11.40", "description": "Type 2 diabetes mellitus with diabetic neuropathy",
     "category": "Endocrine", "keywords": ["diabetic neuropathy", "numbness feet"]},
    {"code": "E11.22", "description": "Type 2 diabetes mellitus with diabetic chronic kidney disease",
     "category": "Endocrine", "keywords": ["diabetic ckd", "diabetic kidney"]},
    {"code": "E11.319", "description": "Type 2 diabetes mellitus with unspecified diabetic retinopathy",
     "category": "Endocrine", "keywords": ["diabetic retinopathy", "dr"]},
    {"code": "A15.0", "description": "Tuberculosis of lung",
     "category": "Infectious", "keywords": ["pulmonary tb", "lung tb", "tuberculosis"]},
    {"code": "A09.9", "description": "Gastroenteritis and colitis of unspecified origin",
     "category": "Infectious", "keywords": ["gastroenteritis", "diarrhea", "loose motions"]},
    {"code": "A90", "description": "Dengue fever",
     "category": "Infectious", "keywords": ["dengue"]},
    {"code": "B54", "description": "Unspecified malaria",
     "category": "Infectious", "keywords": ["malaria", "plasmodium"]},
    {"code": "B19.10", "description": "Unspecified viral hepatitis B without hepatic coma",
     "category": "Infectious", "keywords": ["hepatitis b", "hbv"]},
    {"code": "B17.10", "description": "Acute hepatitis C without hepatic coma",
     "category": "Infectious", "keywords": ["hepatitis c", "hcv"]},
    {"code": "B20", "description": "Human immunodeficiency virus [HIV] disease",
     "category": "Infectious", "keywords": ["hiv", "aids"]},
    {"code": "J32.9", "description": "Chronic sinusitis, unspecified",
     "category": "ENT", "keywords": ["sinusitis", "sinus infection"]},
    {"code": "J03.90", "description": "Acute tonsillitis, unspecified",
     "category": "ENT", "keywords": ["tonsillitis"]},
    {"code": "J02.9", "description": "Acute pharyngitis, unspecified",
     "category": "ENT", "keywords": ["pharyngitis", "sore throat"]},
    {"code": "H66.90", "description": "Otitis media, unspecified",
     "category": "ENT", "keywords": ["ear infection", "otitis media"]},
    {"code": "H10.9", "description": "Unspecified conjunctivitis",
     "category": "Eye", "keywords": ["conjunctivitis", "pink eye"]},
    {"code": "H25.9", "description": "Unspecified age-related cataract",
     "category": "Eye", "keywords": ["cataract"]},
    {"code": "Z00.00", "description": "General adult medical examination without abnormal findings",
     "category": "Preventive", "keywords": ["routine checkup", "annual physical"]},
    {"code": "Z23", "description": "Encounter for immunization",
     "category": "Preventive", "keywords": ["vaccination", "immunization", "vaccine"]},
    {"code": "R10.9", "description": "Unspecified abdominal pain",
     "category": "Symptoms", "keywords": ["abdominal pain", "stomach ache"]},
    {"code": "R07.9", "description": "Chest pain, unspecified",
     "category": "Symptoms", "keywords": ["chest pain"]},
    {"code": "R11.10", "description": "Vomiting, unspecified",
     "category": "Symptoms", "keywords": ["vomiting"]},
    {"code": "R42", "description": "Dizziness and giddiness",
     "category": "Symptoms", "keywords": ["dizziness", "vertigo", "giddiness"]},
    {"code": "R51.9", "description": "Headache, unspecified",
     "category": "Symptoms", "keywords": ["headache"]},
    {"code": "R53.83", "description": "Other fatigue",
     "category": "Symptoms", "keywords": ["fatigue", "tiredness", "weakness"]},
    {"code": "R60.9", "description": "Edema, unspecified",
     "category": "Symptoms", "keywords": ["edema", "swelling"]},
    {"code": "R50.81", "description": "Fever presenting with conditions classified elsewhere",
     "category": "Symptoms", "keywords": ["fever child"]},
    {"code": "O80", "description": "Encounter for full-term uncomplicated delivery",
     "category": "OB/GYN", "keywords": ["delivery", "labor", "normal delivery"]},
    {"code": "Z34.90", "description": "Encounter for supervision of normal pregnancy, unspecified",
     "category": "OB/GYN", "keywords": ["pregnancy", "anc", "antenatal"]},
    {"code": "O24.419", "description": "Gestational diabetes mellitus in pregnancy",
     "category": "OB/GYN", "keywords": ["gestational diabetes", "gdm"]},
    {"code": "O13.9", "description": "Gestational hypertension, unspecified",
     "category": "OB/GYN", "keywords": ["gestational hypertension"]},
    {"code": "Z30.9", "description": "Encounter for contraceptive management, unspecified",
     "category": "Preventive", "keywords": ["contraception", "family planning"]},
    {"code": "F90.9", "description": "ADHD, unspecified type",
     "category": "Mental Health", "keywords": ["adhd", "attention deficit"]},
    {"code": "F51.0", "description": "Insomnia, not due to a substance",
     "category": "Mental Health", "keywords": ["insomnia", "sleep problem"]},
    {"code": "F17.219", "description": "Nicotine dependence, unspecified, with withdrawal",
     "category": "Mental Health", "keywords": ["smoking", "tobacco", "nicotine"]},
    {"code": "F10.20", "description": "Alcohol dependence, uncomplicated",
     "category": "Mental Health", "keywords": ["alcoholism", "alcohol dependence"]},
    {"code": "K59.00", "description": "Constipation, unspecified",
     "category": "Gastrointestinal", "keywords": ["constipation"]},
    {"code": "K30", "description": "Functional dyspepsia",
     "category": "Gastrointestinal", "keywords": ["dyspepsia", "indigestion"]},
    {"code": "K64.9", "description": "Unspecified hemorrhoids",
     "category": "Surgical", "keywords": ["hemorrhoids", "piles"]},
    {"code": "K80.20", "description": "Calculus of gallbladder without cholecystitis, unspecified",
     "category": "Surgical", "keywords": ["gallstones"]},
    {"code": "K35.80", "description": "Unspecified acute appendicitis",
     "category": "Surgical", "keywords": ["appendicitis"]},
    {"code": "N20.0", "description": "Calculus of kidney",
     "category": "Genitourinary", "keywords": ["kidney stone", "renal calculus", "nephrolithiasis"]},
    {"code": "N40.0", "description": "Benign prostatic hyperplasia without lower urinary tract symptoms",
     "category": "Genitourinary", "keywords": ["bph", "prostate enlargement"]},
    {"code": "L70.0", "description": "Acne vulgaris",
     "category": "Dermatology", "keywords": ["acne", "pimples"]},
    {"code": "L40.9", "description": "Psoriasis, unspecified",
     "category": "Dermatology", "keywords": ["psoriasis"]},
    {"code": "B35.9", "description": "Dermatophytosis, unspecified",
     "category": "Dermatology", "keywords": ["ringworm", "fungal infection"]},
    {"code": "B86", "description": "Scabies",
     "category": "Infectious", "keywords": ["scabies"]},
    {"code": "M10.9", "description": "Gout, unspecified",
     "category": "Musculoskeletal", "keywords": ["gout"]},
    {"code": "M81.0", "description": "Age-related osteoporosis without current pathological fracture",
     "category": "Musculoskeletal", "keywords": ["osteoporosis"]},
    {"code": "M54.5", "description": "Low back pain",
     "category": "Musculoskeletal", "keywords": ["low back pain", "lumbago"]},
    {"code": "M17.9", "description": "Osteoarthritis of knee, unspecified",
     "category": "Musculoskeletal", "keywords": ["knee osteoarthritis"]},
    {"code": "M06.9", "description": "Rheumatoid arthritis, unspecified",
     "category": "Musculoskeletal", "keywords": ["rheumatoid arthritis"]},
    {"code": "C50.911", "description": "Malignant neoplasm of unspecified site of right female breast",
     "category": "Oncology", "keywords": ["breast cancer"]},
    {"code": "C61", "description": "Malignant neoplasm of prostate",
     "category": "Oncology", "keywords": ["prostate cancer"]},
    {"code": "Z12.31", "description": "Encounter for screening mammogram for malignant neoplasm of breast",
     "category": "Preventive", "keywords": ["mammogram", "breast screening"]},
    {"code": "Z12.4", "description": "Encounter for screening for malignant neoplasm of cervix",
     "category": "Preventive", "keywords": ["cervical screening", "pap smear"]},
    {"code": "Z71.3", "description": "Dietary counseling and surveillance",
     "category": "Preventive", "keywords": ["diet counseling", "nutrition advice"]},
]


def _icd10_codes() -> list[dict]:
    global _ICD10
    if _ICD10 is None:
        try:
            from backend.lib.icd10 import ALL_CODES
            _ICD10 = ALL_CODES
        except Exception:
            _ICD10 = _FALLBACK_ICD10
    return _ICD10


# Drug name regex set (built once)
_DRUG_NAMES: list[str] | None = None


def _drug_names() -> list[str]:
    global _DRUG_NAMES
    if _DRUG_NAMES is None:
        try:
            from backend.lib.formulary import ALL_DRUGS
            _DRUG_NAMES = [d["name"].lower() for d in ALL_DRUGS]
        except Exception:
            _DRUG_NAMES = []
    return _DRUG_NAMES


def extract_entities(text: str, use_model: bool = False) -> dict[str, Any]:
    """Extract symptoms, problems, drugs, vitals from clinical note.

    Default: rules + regex (fast, deterministic).
    Set use_model=True to attempt BioClinicalBERT (slower, may fail).
    """
    method = "rules"
    entities: dict[str, list[dict]] = {
        "symptoms": [],
        "problems": [],
        "drugs": [],
        "vitals": [],
        "plan": [],
    }
    text_lower = text.lower()

    # ─── Symptoms (regex + dictionary) ─────────────────────────────
    SYMPTOM_PATTERNS = [
        r"\b(fever|cough|cold|headache|body ache|bodyache|fatigue|nausea|vomiting|diarrhea|constipation|abdominal pain|chest pain|breathlessness|dyspnea|palpitations|dizziness|vertigo|rash|itching|burning urination|burning micturition|polyuria|polydipsia|weight loss|weight gain|sweating|chills)\b",
    ]
    for pat in SYMPTOM_PATTERNS:
        for m in re.finditer(pat, text_lower):
            entities["symptoms"].append({"text": m.group(0), "span": [m.start(), m.end()]})

    # ─── Problems / chronic conditions ─────────────────────────────
    PROBLEM_PATTERNS = [
        r"\b(diabetes mellitus|type\s*[12]\s*diabetes|t2dm|t1dm|sugar)\b",
        r"\b(diabetes|dm)\b",
        r"\b(hypertension|htn|high blood pressure|bp)\b",
        r"\b(asthma)\b",
        r"\b(copd|chronic bronchitis|emphysema)\b",
        r"\b(ckd|chronic kidney disease|kidney disease)\b",
        r"\b(chd|coronary heart disease|ihd|ischemic heart disease|cad)\b",
        r"\b(stroke|cva|cerebral infarct)\b",
        r"\b(hypothyroidism|hypothyroid|hyperthyroidism|thyrotoxicosis)\b",
        r"\b(anemia|iron deficiency|b12 deficiency)\b",
        r"\b(arthritis|rheumatoid arthritis|osteoarthritis|gout)\b",
        r"\b(depression|depressed mood|low mood)\b",
        r"\b(anxiety|panic|gad)\b",
        r"\b(migraine|headache)\b",
        r"\b(epilepsy|seizure|fit)\b",
        r"\b(tuberculosis|tb)\b",
        r"\b(hepatitis\s*[abcde]?|hbv|hcv|hav|hev)\b",
        r"\b(hiv|aids)\b",
        r"\b(gerd|acid reflux|heartburn)\b",
        r"\b(ibs|irritable bowel)\b",
        r"\b(ulcerative colitis|crohn|ibd)\b",
    ]
    for pat in PROBLEM_PATTERNS:
        for m in re.finditer(pat, text_lower):
            entities["problems"].append({"text": m.group(0), "span": [m.start(), m.end()]})

    # ─── Drugs (matched against formulary) ─────────────────────────
    for name in _drug_names():
        # word-boundary search
        pat = re.compile(rf"\b{re.escape(name)}\b", re.IGNORECASE)
        for m in pat.finditer(text):
            ctx = _extract_drug_context(text, m.start(), m.end())
            entities["drugs"].append({"text": m.group(0), **ctx})

    # ─── Vitals (BP, sugar, weight, pulse, temp) ───────────────────
    # BP: 120/80, 140/90
    for m in re.finditer(r"\b(\d{2,3})\s*/\s*(\d{2,3})\s*(?:mm\s*hg|mmhg|bp)?\b", text_lower):
        try:
            sbp = int(m.group(1)); dbp = int(m.group(2))
            if 60 <= sbp <= 250 and 30 <= dbp <= 180:
                entities["vitals"].append({"type": "bp", "value": f"{sbp}/{dbp}", "systolic": sbp, "diastolic": dbp})
        except ValueError:
            pass
    # Sugar: 110 mg/dL, FBS 110, PPBS 180
    for m in re.finditer(r"\b(?:fbs|ppbs|rbs|hba1c)?\s*[:\-]?\s*(\d{2,3}(?:\.\d+)?)\s*(mg/dl|mg%|%)\b", text_lower):
        val = float(m.group(1))
        if 30 <= val <= 700:
            entities["vitals"].append({"type": "sugar", "value": val, "unit": m.group(2)})
    # Weight: 70 kg
    for m in re.finditer(r"\b(\d{2,3}(?:\.\d+)?)\s*kg\b", text_lower):
        val = float(m.group(1))
        if 10 <= val <= 300:
            entities["vitals"].append({"type": "weight", "value": val, "unit": "kg"})
    # Pulse: 72 bpm
    for m in re.finditer(r"\b(?:pulse|hr|heart rate)[:\s]*(\d{2,3})\b", text_lower):
        val = int(m.group(1))
        if 30 <= val <= 220:
            entities["vitals"].append({"type": "pulse", "value": val})
    # Temp: 98.6 F
    for m in re.finditer(r"\b(\d{2}(?:\.\d+)?)\s*(?:°?\s*F|fahrenheit)\b", text_lower):
        val = float(m.group(1))
        if 90 <= val <= 110:
            entities["vitals"].append({"type": "temp_f", "value": val})

    # ─── Plan: simple sentence-level extraction ────────────────────
    plan_keywords = r"\b(advised|advice|plan|recommend|start|continue|stop|review|follow\s*up|refer|investigation|test|culture|x-?ray|ecg|echo|prescribed|rx|rx:)\b"
    # First strip "h/o" (history of) sentences — they're problems not plan
    history_pat = re.compile(r"^[^.!?]*\b(h/o|history of|known case of|k/c/o)\b.*", re.IGNORECASE)
    for sent in re.split(r"(?<=[.!?])\s+", text):
        sl = sent.strip()
        if not sl:
            continue
        if history_pat.match(sl):
            continue
        if re.search(plan_keywords, sl.lower()):
            entities["plan"].append({"text": sl})

    # Deduplicate
    for k in entities:
        seen = set(); out = []
        for e in entities[k]:
            key = e.get("text") or e.get("type")
            if key and key not in seen:
                seen.add(key); out.append(e)
        entities[k] = out

    # Optional BioClinicalBERT model path (if requested)
    model_entities: dict[str, list[dict]] | None = None
    if use_model:
        model, tok = _load_model()
        if model is not None:
            try:
                import torch
                inputs = tok(text, return_tensors="pt", truncation=True, max_length=512)
                with torch.no_grad():
                    outputs = model(**inputs)
                preds = outputs.logits.argmax(dim=-1)[0].tolist()
                tokens = tok.convert_ids_to_tokens(inputs["input_ids"][0])
                labels = [model.config.id2label[p] for p in preds]
                model_entities = _biobert_entities(tokens, labels)
                method = "biobert"
                # Merge model results into rules results
                for k, v in (model_entities or {}).items():
                    if k in entities:
                        entities[k].extend(v)
            except Exception as e:
                print(f"[nlp] BioClinicalBERT inference failed: {e}")
                model_entities = None

    return {
        "method": method,
        "entities": entities,
        "model_available": _MODEL is not None,  # only check if already loaded
        "note": "Rules + dictionary-based extraction. Optional BioClinicalBERT path adds NER for clinical text.",
    }


def _extract_drug_context(text: str, start: int, end: int) -> dict[str, str]:
    """Extract dose/frequency/duration near a drug mention."""
    window = text[max(0, start - 30):min(len(text), end + 60)]
    dose = ""
    freq = ""
    duration = ""
    dm = re.search(r"(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|iu|units?)", window, re.IGNORECASE)
    if dm:
        dose = f"{dm.group(1)}{dm.group(2)}"
    fm = re.search(r"\b(od|bd|tds|qid|prn|hs|sos|bid|tid)\b", window, re.IGNORECASE)
    if fm:
        freq = fm.group(0).upper()
    drm = re.search(r"\b(\d+)\s*(day|days|week|weeks|month|months)\b", window, re.IGNORECASE)
    if drm:
        duration = f"{drm.group(1)} {drm.group(2)}"
    return {"dose": dose, "frequency": freq, "duration": duration}


def _biobert_entities(tokens: list[str], labels: list[str]) -> dict[str, list[dict]]:
    """Convert BIO-tagged tokens into grouped entities."""
    entities: dict[str, list[dict]] = {
        "problems": [], "drugs": [], "tests": [], "symptoms": [],
    }
    cur_type: str | None = None
    cur_tokens: list[str] = []
    for tok, lab in zip(tokens, labels):
        if tok in ("[CLS]", "[SEP]", "[PAD]"):
            continue
        if lab.startswith("B-"):
            if cur_type and cur_tokens:
                entities.setdefault(cur_type, []).append({"text": " ".join(cur_tokens)})
            cur_type = lab[2:].lower()
            cur_tokens = [tok]
        elif lab.startswith("I-") and cur_type:
            cur_tokens.append(tok)
        else:
            if cur_type and cur_tokens:
                entities.setdefault(cur_type, []).append({"text": " ".join(cur_tokens)})
            cur_type = None
            cur_tokens = []
    if cur_type and cur_tokens:
        entities.setdefault(cur_type, []).append({"text": " ".join(cur_tokens)})
    return entities


# ─── ICD-10 suggest ──────────────────────────────────────────────────


def suggest_icd10(text: str, top_k: int = 5) -> list[dict[str, Any]]:
    """Suggest top-K ICD-10 codes from a clinical note (keyword + entity match)."""
    text_l = text.lower()
    candidates: list[tuple[float, dict]] = []
    for code in _icd10_codes():
        score = 0.0
        # Keyword match
        for kw in code.get("keywords", []):
            if kw.lower() in text_l:
                score += 1.0
        # Category match
        cat = code.get("category", "").lower()
        if cat and cat in text_l:
            score += 0.3
        # Description match
        desc = code.get("description", "").lower()
        for word in desc.split():
            if len(word) > 4 and word in text_l:
                score += 0.2
        if score > 0:
            candidates.append((score, code))
    candidates.sort(key=lambda x: -x[0])
    return [
        {"code": c["code"], "description": c.get("description", ""), "category": c.get("category", ""), "score": round(s, 2)}
        for s, c in candidates[:top_k]
    ]
