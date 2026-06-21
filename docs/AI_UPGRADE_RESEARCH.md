# TatvaCare AI/ML Upgrade Research

**Scope:** Research across ML, Deep Learning, Neural Networks, Agentic AI, OCR, and NLP — applied to TatvaCare's chronic-care EMR + DTx stack on Vedadb's VBP wire protocol.

**Date:** 2026-06-21
**Author:** Mavis research pass for Shubham

---

## Executive Summary

TatvaCare has **5 high-leverage AI/ML upgrade paths** that fit its current architecture (Node backend + Vedadb on VBP + vanilla JS frontend). The wins come from where AI replaces *manual data entry* and *cognitive load* — not from where it replaces clinical judgment.

| Domain | TatvaCare use case | Effort | Impact | Phase |
|---|---|---|---|---|
| **OCR** | Handwritten Rx digitization, lab report extraction, insurance card OCR | M | **HIGH** | 1 |
| **NLP** | Clinical NER → auto-fill ICD-10 + drug autocomplete, voice-to-text notes, multilingual intake | M | **HIGH** | 1 |
| **Agentic AI** | Clinical decision support agents (drug interaction, risk, follow-up), automated SOAP draft, lab-result triage | L | **HIGH** | 2 |
| **ML (classical)** | 30-day readmission risk, vitals anomaly detection, adherence prediction | M | MEDIUM | 2 |
| **Deep Learning** | ECG arrhythmia detection, diabetic retinopathy screening, voice biomarkers | L+GPU | MEDIUM | 3 |

**Bottom line:** Start with **OCR + NLP** (Phase 1, ~3-4 weeks). It directly attacks the doctor's biggest pain point — *typing* — and uses models small enough to run on a single CPU server. Agentic AI comes next (Phase 2), Deep Learning last (Phase 3, needs GPU + IRB-cleared data).

---

## 1. OCR — handwritten Rx, lab reports, KYC

### What it solves in TatvaCare

- Doctors still scribble Rx by hand → patient can't read → pharmacist guesses → wrong dose.
- Patients upload lab reports as PDFs/images → doctor manually re-types values into vitals chart.
- New patient onboarding: Aadhaar/PAN/insurance card → KYC fields pre-filled.

### State of the art (2025-2026)

| Model | Use case | Strengths | Notes |
|---|---|---|---|
| **PaddleOCR 3.3** (Baidu, Oct 2025) | General + multilingual (109 langs), handwriting | 60K+ GitHub stars, PP-OCRv5 best word-level accuracy on handwriting, Apache 2.0 | **Best OSS pick for Hindi/English mixed handwriting** |
| **olmOCR** (AllenAI, 2025) | PDF → structured Markdown, table extraction | Qwen2-VL-7B backbone, $190/1M pages, Apache 2.0 | Best for printed lab reports |
| **GLM-OCR** (0.9B params) | Document understanding | Beats PP-OCRv5 on word-level for complex docs | Heavier, GPU recommended |
| **TrOCR + Roboflow** (Microsoft) | Handwriting fine-tune | SOTA on IAM handwriting dataset | Fine-tune needed for medical symbols |
| **Donut / fine-tuned variants** (NAVER) | End-to-end document understanding | No separate detection step | `chinmays18/medical-prescription-ocr` on HuggingFace is a pre-fine-tuned variant |

**Recommendation:** **PaddleOCR 3.3 (PP-OCRv5) for handwriting** + **olmOCR for printed lab PDFs**. Both run on CPU for low-throughput, GPU optional.

### TatvaCare integration

```
Patient uploads lab_report.jpg
        ↓
POST /api/ocr/lab-report
        ↓
Python OCR service (PaddleOCR)
        ↓ extract text + structure
        ↓
NLP layer (BioClinical ModernBERT)
        ↓ entity extraction (test name, value, unit, ref range, abnormal flag)
        ↓
Return structured JSON → doctor reviews → "Apply to chart"
```

**New endpoints:**
- `POST /api/ocr/prescription` — handwritten Rx → drug names + doses
- `POST /api/ocr/lab-report` — PDF/image → vitals chart auto-fill
- `POST /api/ocr/kyc` — Aadhaar/PAN/insurance → patient intake fields

**No new infra needed:** Python OCR service runs alongside Node backend on the same host, talks to Vedadb via VBP the same way Node does.

---

## 2. NLP — clinical text understanding + voice

### What it solves

- **Clinical NER** — auto-extract symptoms, diagnoses, drugs, doses from free-text clinical notes → pre-fill Rx + ICD-10 fields.
- **ICD-10 auto-suggest** — read doctor's note → suggest top-3 ICD-10 codes (we already have an ICD-10 autocomplete; this upgrades it from keyword-search to ML).
- **Voice-to-text notes** — doctor dictates during consultation → structured SOAP note auto-generated.
- **Multilingual patient intake** — patients speak Hindi/Tamil/Bengali → structured fields in English for the doctor.
- **Drug name fuzzy matching** — currently manual substring match; upgrade to embeddings so "metformn 500" or "Metform" all resolve to "Metformin 500mg".
- **Sentiment analysis on patient messages** — flag distress/urgency in inbox.

### State of the art (2025-2026)

| Model | Use case | Strengths | Notes |
|---|---|---|---|
| **BioClinical ModernBERT** (Jun 2025, arXiv:2506.10896) | Biomedical NER, RE, QA | Long-context encoder (8K tokens), SOTA on BC5CDR/NLM | **Best open-source encoder for clinical text** |
| **PubMedBERT** | Biomedical NER | Strong baseline | Older, still solid |
| **BioBERT v1.2** (DMIS-Lab) | Classic biomedical NLP | Mature, lots of fine-tunes available | Apache 2.0 |
| **Whisper** (OpenAI) + **Medical Whisper fine-tunes** | Voice-to-text for dictation | WER 0.087 (controlled) to 0.19 (clinical) | **Whisper large-v3 fine-tuned on medical = best open** |
| **CrisperWhisper** (Aug 2024) | Verbatim transcripts with word-level timestamps | Better than vanilla Whisper for dictation | Strong choice for SOAP structuring |
| **Spark NLP for Healthcare** (John Snow Labs) | Production clinical NLP | Pre-trained NER, RE, assertion, de-identification | Commercial license, but rock-solid |
| **Med-PaLM 2** (Google) | Clinical Q&A, differential dx | Medical knowledge benchmark SOTA | API-only, expensive, privacy concerns |

**Recommendation:** **BioClinical ModernBERT** for in-house clinical NER (free, runs on CPU, Apache-style license) + **Whisper-large-v3 fine-tuned on Indian clinical audio** for dictation.

### TatvaCare integration

```
Doctor's free-text note:
  "Patient c/o burning urination x 3 days, h/o DM on metformin,
   BP 140/90, advised urine culture and started nitrofurantoin 100 BD"

BioClinical ModernBERT NER:
  symptoms:   [burning urination x 3 days]
  problems:   [DM (E11.9)]
  vitals:     [BP 140/90]
  drugs:      [metformin (existing), nitrofurantoin 100 BD (new)]
  plan:       [urine culture]

Auto-fill:
  - ICD-10: E11.9 (DM), possibly N39.0 (UTI)
  - Rx: nitrofurantoin 100mg BD pre-filled
  - Note tab: structured SOAP draft (doctor reviews + signs)
```

**Voice path:**
```
Doctor taps "Start dictation" → browser MediaRecorder
        ↓
WebSocket /api/voice-stream
        ↓
Whisper service (Python, GPU optional)
        ↓
Live transcript + final structured note
        ↓
Auto-route to NLP → save as draft → doctor edits → signs
```

**Multilingual:** Whisper large-v3 supports Hindi natively (~90% WER on clean audio). For regional languages (Tamil, Bengali, Marathi), use `ai4bharat/indicconformer` or `vasista/indicwav2vec_v2`.

**New endpoints:**
- `POST /api/nlp/extract-entities` — note text → {symptoms, problems, drugs, vitals}
- `POST /api/nlp/suggest-icd10` — note text → top-K ICD-10 codes
- `POST /api/voice/transcribe` — audio blob → text
- `WebSocket /api/voice/stream` — live dictation
- `POST /api/nlp/multilingual-intake` — patient audio in regional lang → English structured fields

---

## 3. ML (classical) — risk + anomaly + adherence

### What it solves

- **30-day readmission risk** — predict which discharged patients are likely to come back → proactive follow-up.
- **Vitals anomaly detection** — patient logs BP 180/110 at home → system flags doctor instantly.
- **Adherence prediction** — patient hasn't filled metformin refill in 25 days → predict they won't refill → auto-message + flag.
- **Personalized dose recommendations** — based on age, weight, kidney function, suggest starting dose.
- **Patient cohort clustering** — find similar patients for cohort analysis / research.

### Models worth using

| Model | Use case | Why |
|---|---|---|
| **XGBoost / LightGBM** | Tabular risk models | Industry standard, handles missing data, fast |
| **Isolation Forest** | Vitals anomaly detection | Unsupervised, no labels needed |
| **Prophet / NeuralProphet** | Time-series vitals forecasting | Built for daily/weekly seasonality |
| **CatBoost** | Mixed categorical/numeric features | Handles ICD codes, drug classes natively |
| **Survival analysis (lifelines, scikit-survival)** | Time-to-event (readmission, ER visit) | Gives probabilistic output, not just binary |

**Recommendation:** **XGBoost for risk** + **Isolation Forest for vitals anomalies** + **Prophet for vitals forecasting**. All run on CPU, train in minutes, predict in milliseconds.

### TatvaCare integration

```
Nightly cron:
  1. Pull last 90 days of patient data from Vedadb
  2. Compute features:
     - avg_systolic_bp, bp_variance, last_visit_gap
     - refill_adherence_30d, missed_doses
     - comorbidity_count, age, bmi
  3. XGBoost predict → risk_score per patient
  4. Update patient.risk_score in Vedadb
  5. Top 10% high-risk → auto-create follow-up task for doctor
```

**Real-time vitals anomaly:**
```
Patient logs BP 180/110 via app
        ↓
INSERT into vitals (VBP)
        ↓
Trigger: compute rolling baseline (last 14 days)
        ↓
Isolation Forest score → if > 0.7 → alert
        ↓
WS to doctor's dashboard + patient SMS
```

**New tables/endpoints:**
- `patient_risk_scores` table (patient_id, model_version, score, computed_at, top_features_json)
- `GET /api/patients/:id/risk` — current risk + explanation
- `GET /api/dashboard/high-risk-patients` — sorted list
- `GET /api/patients/:id/vitals-anomalies` — flagged vitals events

---

## 4. Deep Learning — ECG, imaging, voice biomarkers

### What it solves

- **ECG arrhythmia detection** — patient uploads single-lead ECG (KardiaMobile-style) → classify AFib / PVC / normal in 5 seconds. **Critical for chronic cardiovascular patients.**
- **Diabetic retinopathy screening** — fundus photo → refer for ophthalmology. India has huge diabetes burden; screening is bottleneck.
- **Voice biomarkers** — patient's voice recording → detect early Parkinson's, depression, cognitive decline. Phone-call based = zero clinic visit needed.
- **Chest X-ray triage** — flag TB/pneumonia/COPD markers. (Less relevant for primary care EMR but useful for clinic-with-imaging.)
- **Vitals time-series forecasting** — LSTM/Transformer predicts next-week BP/sugar trends → doctor sees trajectory, not just snapshots.

### State of the art

| Model | Use case | Performance |
|---|---|---|
| **1D U-Net (Stanford/Hippo)** | ECG arrhythmia (12 classes) | Cardiologist-level on 91K ECGs (Hannun et al., Nature Medicine 2019) |
| **EcgResNet34 / ArrhythmiaVision (2025)** | ECG classification | 98%+ accuracy, resource-conscious |
| **Diabetic retinopathy CNNs** (EyeArt, IDx-DR, Google) | Fundus screening | FDA-cleared, sensitivity 87-96% |
| **DenseNet / EfficientNet-B4** | Chest X-ray | CheXNet, SOTA on NIH 14-class |
| **Whisper features + fine-tuned head** | Voice biomarkers | Parkinson's: 90%+ accuracy on simple tasks |

**Recommendation:** Outsource for v1 — **use existing pre-trained models from HuggingFace**, run inference on CPU/GPU. Don't train from scratch.

### TatvaCare integration (Phase 3)

```
Patient uploads ECG image / sends KardiaMobile PDF
        ↓
POST /api/ecg/classify
        ↓
Python service: 1D U-Net or HuggingFace `PhysioNet/CinC-2025-arrhythmia` model
        ↓
{ rhythm: "AFib", confidence: 0.94, severity: "high" }
        ↓
Auto-flag on patient chart, alert doctor
```

**New endpoints:**
- `POST /api/ecg/classify` — image/PDF → rhythm + confidence
- `POST /api/imaging/retinopathy` — fundus photo → DR grade (0-4)
- `POST /api/voice/biomarkers` — voice sample → depression/Parkinson's risk
- `GET /api/patients/:id/vitals-forecast` — 7-day BP/sugar forecast

**Hardware:** Need GPU server (A10 / RTX 4090) for inference. ~$200-500/mo on Vast.ai or RunPod. Latency budget 2-5 sec for ECG.

---

## 5. Agentic AI — multi-agent clinical workflows

### What it solves

Agentic AI = LLM with **tools + memory + multi-step planning**. For TatvaCare, the use cases are:

- **Auto SOAP note agent** — watches the consultation (transcript + vitals + actions) → drafts structured SOAP → doctor reviews + signs.
- **Drug interaction risk agent** — given new Rx, runs through patient's full med list + allergies + conditions + current labs → returns severity + alternative suggestions.
- **Lab result triage agent** — new lab result in → routes: critical → call patient now / abnormal → schedule review / normal → log.
- **Patient follow-up agent** — chronic patient due for HbA1c/BP check → auto-message + schedule + reminder escalation.
- **Differential diagnosis agent** — given symptoms + history + exam, suggest DDx with reasoning. Doctor confirms/discards.
- **Coding/billing agent** — encounter → auto-suggest ICD-10 + CPT codes + claim draft.
- **Research agent** — doctor asks "latest guidelines for T2DM with CKD" → searches PubMed + returns summary with citations.

### Frameworks (2025-2026)

| Framework | Strength | Best for |
|---|---|---|
| **LangGraph** (LangChain) | Stateful, graph-based, **dominates 2026 production (44% usage, 81% satisfaction)** | **Production clinical agents** — recommended |
| **CrewAI** | Fast prototyping, role-based agents | POCs, demos |
| **Microsoft AutoGen** | Event-driven, Azure-native | Azure shops |
| **MetaGPT / AgentScope** | SOP-style collaboration | Structured workflows |
| **MASFactory / OxyGent** | Graph-centric, modular | Research, complex orchestration |

**Recommendation:** **LangGraph** for production agents — best state management, observability via LangSmith, healthcare case studies (Vizient, MIT Sloan field guide).

### TatvaCare architecture

```
                ┌─────────────────────────────────┐
                │   LangGraph Agent Orchestrator   │
                │   (Python service on :7000)      │
                └────────────────┬─────────────────┘
                                 │
       ┌─────────────┬───────────┼────────────┬──────────────┐
       ▼             ▼           ▼            ▼              ▼
   SOAP Note    Drug Ix      Lab Triage   Follow-up     Coding Agent
     Agent       Agent         Agent       Agent          Agent
       │             │           │            │              │
       └─────────────┴───────────┴────────────┴──────────────┘
                                 │
                  ┌──────────────┼──────────────┐
                  ▼              ▼              ▼
              Tool:           Tool:           Tool:
              Vedadb VBP      Whisper         PaddleOCR
              (read/write     (transcribe     (extract
              patient, Rx)    consult)        lab values)
                  │              │              │
                  ▼              ▼              ▼
              Vedadb         Whisper         PaddleOCR
              Engine         Service         Service
              (:6381)        (:7001)         (:7002)
```

**Key principle:** Agents are **clinician-in-the-loop**. Every agent action produces a draft; doctor reviews + signs. No autonomous prescribing or diagnosis without human confirmation.

**Concrete example — Lab Triage Agent:**

```
Trigger: new lab result inserted in Vedadb
        ↓
Agent reads: HbA1c = 9.2, Creatinine = 2.1, K+ = 5.8
        ↓
Tools called:
  - getPatientHistory(patient_id)  → DM since 2018, on metformin + glimepiride
  - getCurrentMeds(patient_id)     → no ACE-i, on amlodipine
  - checkLabTrends(patient_id)     → HbA1c trending up 7.5 → 8.1 → 9.2 over 6 mo
        ↓
Agent reasoning:
  - HbA1c 9.2 = poorly controlled DM
  - Creatinine 2.1 + K+ 5.8 = AKI warning, possible metformin accumulation
  - Pattern: progressive decompensation
        ↓
Decision tree:
  IF K+ > 5.5 OR creatinine > 2.0:
    SEVERITY = CRITICAL
    ACTION = call patient today, hold metformin, urgent nephrology referral
  ELSE:
    SEVERITY = ABNORMAL
    ACTION = schedule follow-up within 1 week
        ↓
Output:
  {
    severity: "CRITICAL",
    summary: "Patient shows progressive decompensation with possible AKI...",
    recommended_actions: [
      "Hold metformin immediately",
      "Urgent nephrology referral",
      "Recheck K+ and creatinine in 48h"
    ],
    citation: "ADA 2025 guidelines: metformin contraindicated when eGFR < 30"
  }
        ↓
Routes to:
  - Doctor's dashboard (red banner)
  - SMS to patient (hold metformin until reviewed)
  - Auto-creates task for doctor to call
```

**New components:**
- `agents/orchestrator.py` — LangGraph state machine
- `agents/soap_agent.py` — consult transcript → SOAP draft
- `agents/drug_ix_agent.py` — Rx + history → risk report
- `agents/lab_triage.py` — lab result → severity + actions
- `agents/follow_up.py` — chronic patient → next-action
- `agents/coding.py` — encounter → ICD-10 + CPT codes
- WebSocket `ws://app/api/agents/events` — real-time agent activity to UI

---

## Architecture recommendation

### New component: Python AI service

Add a Python service alongside the Node backend. **Don't try to do AI in Node** — the ecosystem (transformers, PyTorch, sklearn, LangChain) is Python-native.

```
tatvacare/
├── backend/              (Node — keep as-is)
│   └── server.mjs
├── ai/                   (NEW — Python)
│   ├── pyproject.toml
│   ├── service/
│   │   ├── main.py              (FastAPI on :7000)
│   │   ├── ocr.py               (PaddleOCR wrapper)
│   │   ├── nlp.py               (BioClinical ModernBERT)
│   │   ├── voice.py             (Whisper wrapper)
│   │   ├── ml/
│   │   │   ├── risk.py          (XGBoost)
│   │   │   ├── anomaly.py       (Isolation Forest)
│   │   │   └── forecast.py      (Prophet)
│   │   ├── dl/
│   │   │   ├── ecg.py           (1D U-Net)
│   │   │   └── imaging.py       (Diabetic retinopathy CNN)
│   │   └── agents/
│   │       ├── orchestrator.py  (LangGraph)
│   │       ├── soap_agent.py
│   │       ├── drug_ix_agent.py
│   │       ├── lab_triage.py
│   │       ├── follow_up.py
│   │       └── coding.py
│   └── models/                  (downloaded weights)
├── public/               (vanilla JS frontend — add agent activity UI)
└── docs/
    └── AI_UPGRADE_RESEARCH.md  (this file)
```

### How it talks to Vedadb

The Python AI service uses the **same VBP wire protocol** as Node. Implement `vbp_client.py` (or import via `pyedadb` if it exists). All patient data stays inside the Vedadb ecosystem — no external API calls, no data leak.

### Deployment

- **Phase 1 (OCR + NLP):** CPU-only, single server, ~$50/mo extra for hosting
- **Phase 2 (Agents + ML):** CPU for most, GPU not strictly needed, ~$100/mo
- **Phase 3 (DL):** GPU server for inference, ~$200-500/mo on Vast.ai/RunPod

---

## Recommended Phase Plan

### Phase 1: OCR + NLP (3-4 weeks) — **START HERE**

| Week | Deliverable |
|---|---|
| 1 | Python AI service skeleton (FastAPI), VBP client, PaddleOCR integration, `POST /api/ocr/lab-report` endpoint, frontend "Upload Lab Report" UI |
| 2 | BioClinical ModernBERT NER service, `POST /api/nlp/extract-entities`, ICD-10 auto-suggest upgrade (replaces keyword search with embeddings), frontend shows suggestions in prescribe UI |
| 3 | Whisper dictation: `POST /api/voice/transcribe` + WebSocket live stream, frontend mic button in patient.html, saves as draft note |
| 4 | Polish, error handling, demo flow, screenshots, commit + push |

**Demo flow:** Doctor uploads a handwritten Rx → OCR extracts "Metformin 500mg BD" → auto-fills Rx form → doctor signs → PDF.

### Phase 2: Agentic AI + Classical ML (4-6 weeks)

| Week | Deliverable |
|---|---|
| 5 | LangGraph orchestrator, SOAP Note agent (transcript → draft), Drug Interaction agent (Rx → severity report) |
| 6 | Lab Triage agent (result → action), Follow-up agent (chronic patient → next-action) |
| 7 | XGBoost risk model trained on synthetic + demo data, `GET /api/patients/:id/risk` |
| 8 | Vitals anomaly detection (Isolation Forest), real-time alerts via WebSocket |
| 9-10 | Polish, agent activity UI in dashboard, eval tests, commit + push |

### Phase 3: Deep Learning (6-8 weeks)

| Week | Deliverable |
|---|---|
| 11-12 | ECG arrhythmia classifier (1D U-Net from HuggingFace), `POST /api/ecg/classify` |
| 13-14 | Diabetic retinopathy CNN (fine-tune from ImageNet), `POST /api/imaging/retinopathy` |
| 15 | Vitals forecasting (LSTM/Transformer), `GET /api/patients/:id/vitals-forecast` |
| 16-18 | GPU deployment, perf testing, IRB process for real patient data, compliance review |

---

## Risks & honest gaps

Following Shubham's preference for **honest "not implemented" over fake numbers**:

| Gap | Status |
|---|---|
| Real patient data for training | **NOT AVAILABLE.** Phase 2-3 models will train on synthetic + public datasets (MIMIC-III, PTB-XL, PhysioNet) and be flagged as "trained on public data, not validated on Indian patient population" |
| GPU server for DL | **NEEDED for Phase 3.** Budget $200-500/mo or use free Colab/Kaggle for prototyping |
| Indian language clinical audio | **Whisper Hindi = OK, regional = needs fine-tuning.** IndicWav2Vec available but accuracy on medical terms uncertain |
| HIPAA / DISHA compliance for AI | **PHI handling not yet audited.** Agents must be designed with redaction, audit logging, human-in-the-loop from day 1 |
| Clinical validation | **NOT DONE.** Any ML/DL model deployed = research-grade, not clinical-grade. Doctor must sign every output |
| Drug interaction agent hallucination | **Risk: LLM may invent interactions.** Mitigation: agent's drug Ix call goes through structured Vedadb table check first, LLM only summarizes — never invents |
| ICD-10 auto-suggest accuracy | **Expected ~85-90% top-3 accuracy on clean notes.** Doctor still chooses — it's a suggestion, not a final code |
| OCR on bad handwriting | **Will fail.** Build "I couldn't read this — please confirm" UI fallback |

**Every feature must explicitly state its limitation in the UI.** No fake "AI magic."

---

## Cost / time summary

| Phase | Duration | New infra | New LOC (est) |
|---|---|---|---|
| 1 — OCR + NLP | 3-4 wk | Python AI service on CPU ($50/mo) | ~3K |
| 2 — Agents + ML | 4-6 wk | Same CPU service + LangSmith observability ($100/mo) | ~5K |
| 3 — DL | 6-8 wk | GPU server ($200-500/mo) | ~4K |
| **Total** | **~3-4 months** | **$300-600/mo** | **~12K Python + 1K Node** |

---

## TL;DR — what to do first

**Ship Phase 1 (OCR + NLP) in 3-4 weeks.** It directly attacks the doctor's biggest pain point (typing), uses free OSS models (PaddleOCR + BioClinical ModernBERT + Whisper), runs on the same CPU server you already have, and integrates cleanly with the existing Vedadb VBP stack. **Demo path:** upload handwritten Rx → OCR + NLP → auto-filled Rx → sign → PDF. That's a *killer* feature for Indian primary care.

After Phase 1 ships, Phase 2 (LangGraph agents) and Phase 3 (DL) follow the same pattern: small Python service, talks to Vedadb via VBP, doctor-in-the-loop, honest about what it can't do.

---

## References (2025-2026)

- **OCR**: PaddleOCR 3.3 (Baidu, Oct 2025), olmOCR (AllenAI, 2025), GLM-OCR, TrOCR + Roboflow, Donut
- **Clinical NLP**: BioClinical ModernBERT (arXiv:2506.10896, Jun 2025), PubMedBERT, BioBERT, Spark NLP Healthcare, Med-PaLM 2
- **Voice**: Whisper large-v3, CrisperWhisper (arXiv:2408.16589), Medical Whisper, ai4bharat/indicconformer, indicwav2vec_v2
- **ECG**: 1D U-Net (Hannun et al., Nature Medicine 2019), ArrhythmiaVision (arXiv:2505.03787, Apr 2025), EcgResNet34
- **Agents**: LangGraph (LangChain, 2024-2026 dominant), CrewAI, Microsoft AutoGen, MetaGPT, AgentScope
- **Clinical agents field guide**: MIT Sloan 2025, Vizient/LangGraph case study, Nature npj Digital Medicine scoping review (2025-2026)
- **Frameworks comparison**: LangGraph 44% production usage, 81% satisfaction (2026 enterprise survey)
