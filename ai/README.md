# TatvaCare Python AI Service

FastAPI service on port 7000. Talks to Vedadb via the same VBP wire protocol as the Node backend (port 6381).

## Layout

```
ai/
├── service/
│   ├── main.py              # FastAPI app
│   ├── vbp_client.py        # Python VBP client (mirror of backend/lib/vbp.mjs)
│   ├── config.py            # paths + env
│   ├── ocr/service.py       # Tesseract OCR (printed + Rx)
│   ├── nlp/service.py       # Bio_ClinicalBERT NER + ICD-10 suggest
│   ├── voice/service.py     # Whisper transcription
│   ├── ml/
│   │   ├── risk.py          # XGBoost risk model
│   │   ├── anomaly.py       # Isolation Forest vitals anomaly
│   │   └── forecast.py      # vitals time-series forecast
│   ├── agents/
│   │   ├── orchestrator.py  # LangGraph state machine
│   │   ├── soap.py          # consult transcript → SOAP draft
│   │   ├── drug_ix.py       # Rx → interaction risk
│   │   ├── lab_triage.py    # lab result → severity + actions
│   │   ├── follow_up.py     # chronic patient → next action
│   │   └── coding.py        # encounter → ICD-10 + CPT
│   └── dl/
│       ├── ecg.py           # 1D CNN arrhythmia (demo on synthetic data)
│       └── imaging.py       # diabetic retinopathy CNN (demo)
├── models/                  # downloaded weights, gitignored
├── data/                    # synthetic training data
└── uploads/                 # transient uploads
```

## Run

```bash
cd ai
source .venv/bin/activate
uvicorn service.main:app --host 0.0.0.0 --port 7000 --reload
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Service health |
| POST | `/ocr/lab-report` | Image/PDF → extracted vitals |
| POST | `/ocr/prescription` | Image → drug names + doses |
| POST | `/ocr/kyc` | Aadhaar/PAN/insurance → fields |
| POST | `/nlp/extract-entities` | Clinical note → {symptoms, problems, drugs, vitals} |
| POST | `/nlp/suggest-icd10` | Clinical note → top-K ICD-10 codes |
| POST | `/voice/transcribe` | Audio blob → text |
| WS | `/voice/stream` | Live dictation |
| POST | `/ml/risk` | Patient ID → risk score |
| POST | `/ml/anomaly` | Vitals series → anomalies |
| POST | `/ml/forecast` | Vitals series → 7-day forecast |
| POST | `/agents/run` | Run agent by name |
| GET | `/agents/activity` | Recent agent activity |
| POST | `/dl/ecg/classify` | ECG image/signal → rhythm |
| POST | `/dl/retinopathy/screen` | Fundus image → DR grade |

## Honest limitations (per user preference)

- DL models trained on **synthetic / public data** — flagged as demo / research-grade.
- LLM agents use a local model when `OPENAI_API_KEY` is not set; otherwise OpenAI.
- No PHI exfiltration — all inference stays local; no external API calls for patient data.
