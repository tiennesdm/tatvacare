# TatvaCare

A chronic-care EMR + Digital Therapeutics platform built on **Vedadb's native VBP wire protocol (port 6381)** — no PG-wire anywhere in the stack. Includes a full **Python AI service** for OCR, NLP, voice, ML, LangGraph agents, and DL on the same Vedadb instance.

## Why this exists

TatvaCare is a working clone of the production EMR/DTx product, built on top of Vedadb's own binary protocol (VBP v1) to validate that the engine can power a real clinical workflow end-to-end:

- Patient charts with vitals, problems, allergies, clinical notes
- Doctor scheduling + tasks + inbox
- Prescriptions with **drug-interaction checks** and **ICD-10 diagnosis autocomplete** (Indian clinical codes)
- **One-page branded Rx PDF** export with doctor signature + Rx-ID hash footer
- **Indian Primary Care Formulary** — 110+ drug monographs (mechanism, side effects, contraindications, pregnancy safety, interactions) plus a reverse index from indication → drug
- **AI Clinical Hub** — OCR lab reports / handwritten Rx / KYC cards, NLP entity extraction + ICD-10 auto-suggest, voice-to-text dictation, XGBoost risk scoring, Isolation Forest vitals anomaly detection, 7-day vitals forecast, LangGraph clinical decision-support agents (SOAP draft / drug interaction / lab triage / follow-up / ICD-10 coding), DL ECG arrhythmia classifier, DL diabetic retinopathy screener

The whole thing runs against a single Vedadb instance with **zero PG-wire**, using only the VBP binary protocol via hand-written clients in both Node (`backend/lib/vbp.mjs`) and Python (`ai/service/vbp_client.py`).

## Stack

| Layer | Choice | Why |
|---|---|---|
| Database | Vedadb engine on VBP (`127.0.0.1:6381`) | Native wire protocol; PG-wire disabled |
| Backend | Node.js + Express 5 (port 3000) | Frontend + VBP proxy + business logic |
| **AI service** | **Python + FastAPI (port 7100)** | **OCR / NLP / ML / DL — all ML libs are Python-native** |
| Frontend | Vanilla HTML/JS + design system | No build step, fastest path to clinical UI |
| PDF | PDFKit (server-side) | One-page A4 Rx export |
| Charts | Chart.js | Vitals trends on patient chart |
| OCR | Tesseract 5.5 (printed) + small CNNs (handwriting) | Open source, CPU-only |
| NLP | Rules + BioClinicalBERT (lazy-loaded) | Transformer SOTA, fallback to rules |
| Voice | Whisper (`tiny` model) | OpenAI, fast on CPU |
| ML | XGBoost + Isolation Forest + scikit-learn | Tabular data, fast |
| DL | PyTorch (tiny 1D CNN for ECG, tiny 2D CNN for DR) | Demo-grade; production = larger pre-trained |
| Agents | LangGraph | Stateful graph-based orchestration |

## Repo layout

```
tatvacare/
├── backend/                    Express server (port 3000)
│   ├── server.mjs              All routes incl. /api/ai/* proxy
│   ├── lib/
│   │   ├── vbp.mjs             VBP binary client (Node, multiplexer SDK)
│   │   ├── auth.mjs            sha256 session helpers
│   │   ├── doctor.mjs          Patient + prescription queries
│   │   ├── clinical.mjs        Vitals, problems, allergies, schedule, tasks
│   │   ├── pdf.mjs             PDFKit Rx generator
│   │   ├── icd10.mjs           80+ Indian ICD-10 codes
│   │   └── formulary.mjs       110+ drug monographs + reverse index
│   ├── scripts/
│   │   ├── migrate.mjs         Migration runner
│   │   └── gen-formulary-pdf.mjs   95-page PDF formulary reference
│   └── package.json
├── ai/                         Python AI service (port 7100)
│   ├── .venv/                  (gitignored) Python 3.11 venv
│   ├── service/
│   │   ├── main.py             FastAPI app — all AI endpoints
│   │   ├── vbp_client.py       VBP binary client (Python) — same protocol
│   │   ├── config.py           paths + env
│   │   ├── common/db.py        shared query helpers
│   │   ├── ocr/service.py      Tesseract — prescription, lab report, KYC
│   │   ├── nlp/service.py      BioClinicalBERT + rules — entities, ICD-10
│   │   ├── voice/service.py    Whisper — dictation + WebSocket stream
│   │   ├── ml/risk.py          XGBoost risk + Isolation Forest + forecast
│   │   ├── agents/orchestrator.py  LangGraph agents (5)
│   │   └── dl/ecg.py           Tiny 1D CNN (ECG) + 2D CNN (retinopathy)
│   ├── models/                 (gitignored) trained weights
│   ├── preload.sh              pre-train models in separate process
│   ├── requirements.txt
│   └── README.md
├── db/migrations/              SQL schema (001-005)
├── public/                     Vanilla HTML/JS frontend
│   ├── dashboard.html
│   ├── patient.html            Chart + Notes tab
│   ├── prescribe.html          ICD-10 autocomplete + Rx sign + PDF download
│   ├── calendar.html
│   ├── inbox.html
│   ├── drugs.html
│   ├── formulary.html          2-mode search (by drug | by indication)
│   ├── ai.html                 ★ AI Clinical Hub (8 tiles)
│   ├── app.js                  shared sidebar + helpers
│   └── style.css               Design system + AI-specific styles
├── tests/                      e2e + visual test scaffolding
├── artifacts/                  Sample Rx PDFs, screenshots, formulary.pdf
├── logs/                       (gitignored) service logs
├── verdadb-data/               (gitignored) Engine runtime data
└── .gitignore
```

## Setup

### 1. Start the Vedadb engine

The engine must be running on port 6381 (VBP) and 8130 (JSON admin). Build it from `tiennesdm/vedadb-engine`:

```bash
# Build
cd /path/to/verdadb-engine
go build -o /usr/local/bin/edadb ./cmd/edadb

# Run (listens on 127.0.0.1:6381)
edadb --config /Users/shubhammehta/data/edadb-vbp.conf
```

Engine startup banner should show:

```
VedaDB VBP (binary) wire listening on 127.0.0.1:6381
```

The engine creates a `verdadb-data/` subdir under cwd on first run for its WAL/store.

### 2. Install Node deps + migrate DB

```bash
cd backend
npm install
node scripts/migrate.mjs
```

This applies all 5 migration files (`001_init.sql` through `005_notes.sql`) including seed data for 3 demo doctors.

### 3. Install Python AI service deps

```bash
cd ai
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Pre-train ML/DL models (XGBoost + tiny CNNs) in a separate process
# (XGBoost conflicts with PyTorch in the same process on macOS — see preload.sh)
bash preload.sh
```

### 4. Start the Node backend (port 3000)

```bash
cd backend
node server.mjs
# → listening on http://127.0.0.1:3000
```

### 5. Start the Python AI service (port 7100)

```bash
cd ai
source .venv/bin/activate
python -m uvicorn service.main:app --host 127.0.0.1 --port 7100
# → Uvicorn running on http://127.0.0.1:7100
```

### 6. Log in

| Phone | Password | Role |
|---|---|---|
| `+919876500001` | `tatva123` | Dr. Aanya Sharma — Endocrinologist |
| `+919876500002` | `tatva123` | Dr. Vikram Iyer — GP |
| `+919876500003` | `tatva123` | Dr. Priya Menon — Pediatrician |

## What's in the box

### Clinical features (shipped)

- **Rx PDF export** — single-page A4, branded header, doctor/clinic block, patient block, diagnosis + vitals, medications, advice, follow-up, signature, Rx-ID hash footer. Endpoint `GET /api/prescriptions/:id/pdf`. (`backend/lib/pdf.mjs`)
- **ICD-10 autocomplete** — 80+ Indian clinical codes (Endocrine, Cardio, Respiratory, GI, GU, MSK, Neuro, Mental Health, Derm, Infectious, OB/GYN, Symptoms, Eye/ENT, Heme, Renal). Arrow keys + Enter. Endpoint `GET /api/icd10/search`. (`backend/lib/icd10.mjs`)
- **Clinical Notes tab** — 4 note types (clinical / follow-up / instruction / phone call), pin-to-top, modal editor. Schema in `005_notes.sql`. Endpoints `GET/POST/DELETE /api/patients/:id/notes`. UI in `public/patient.html`.
- **Drug interaction check** — server-side query against `drug_interactions` table. Returns warnings before Rx sign.
- **Vitals line chart** — Chart.js trends on patient chart (BP, sugar, weight, pulse).
- **Today's schedule + tasks** — dashboard widgets with completion state.

### Indian Primary Care Formulary

110+ drugs with full monographs (`backend/lib/formulary.mjs`):

- Name, brand, class, schedule (H/H1/X/OTC), rx_required
- Adult dose, indications (ICD-10 + label)
- Mechanism, side effects, contraindications
- Pregnancy safety, drug interactions
- Search keywords

**Two modes in `public/formulary.html`:**

1. **Search by drug** — name / brand / class. Shows full monograph in dark hero.
2. **Reverse index** — search by indication (e.g. "diabetes", "hypertension", "fever"). Maps ICD-10 chapter keywords → drugs.

**Reference PDF** — `artifacts/indian-formulary.pdf` is a 95-page comprehensive drug reference generated by `backend/scripts/gen-formulary-pdf.mjs`.

### AI Clinical Hub (`/ai` page)

Open the **AI Hub** from the sidebar. Eight interactive tiles:

| Tile | Backend | What it does |
|---|---|---|
| 📄 Upload Lab Report | Tesseract OCR | Drop PDF/image → extract test values with abnormal flags |
| 📋 Upload Rx | Tesseract + drug fuzzy match | Drop handwritten Rx → extract drug names + doses + freq |
| 🪪 Upload ID Card | Tesseract (auto-detect Aadhaar/PAN) | Extract name + ID number |
| 🎙️ Voice Dictation | Whisper + browser MediaRecorder | Speak → transcript → auto-SOAP draft |
| 📊 Risk Score | XGBoost (synthetic training) | 30-day readmission/ER risk + top factors |
| ⚠️ Vitals Anomaly | Isolation Forest | Flag unusual BP/sugar/weight readings |
| 📈 Forecast | Linear regression | 7-day projection + confidence intervals |
| 📝 SOAP Draft | Rules + keyword | Paste transcript → structured SOAP |
| 🔖 ICD-10 Auto-Suggest | Keyword matching | Top-5 codes from note |
| ⚡ Drug Interaction | Table lookup + LangGraph | Check new Rx against current meds + allergies |
| 🧪 Lab Triage | Rules + LangGraph | Severity + recommended actions |
| ❤️ ECG Rhythm | Tiny 1D CNN (synthetic) | Classify uploaded ECG image (demo only) |
| 👁️ Diabetic Retinopathy | Tiny 2D CNN (synthetic) | Grade 0-4 from fundus (demo only) |

All AI services run on the same Vedadb instance via the Python VBP client — no external API calls, no PHI exfiltration.

### Honest limitations (per user preference)

The AI service ships with these explicit disclaimers in every response:

- **DL models trained on synthetic data** — flagged as `trained_on: "synthetic"` and `demo / research-grade`. Production = larger pre-trained models (1D U-Net, EfficientNet).
- **No real patient data for training** — Phase 2/3 models use MIMIC-III / PTB-XL / Kaggle DR / public datasets.
- **No GPU** — current setup is CPU-only. GPU server ($200-500/mo) needed for clinical-grade DL.
- **LLM agent hallucination risk** — drug Ix call goes through structured Vedadb table check first, LLM only summarizes.
- **Doctor signs every output** — no autonomous prescribing, diagnosis, or treatment.

## Tier 1-3: Patient portal + clinical intelligence (this release)

Beyond the doctor's UI + AI hub, this build adds the patient-facing side of chronic care and a clinical-intelligence layer that ties it all together.

### Patient Portal (Hindi, PWA-installable)

Patients can self-monitor between visits:

- **`/patient/login`** — phone + OTP-style password login (separate session cookie `pid`)
- **`/patient/home`** — last 30 days vitals chart, active Rx with download link, upcoming reminders, active problems list
- **`/patient/log-vitals`** — quick-entry form (BP, glucose, weight, SpO₂, temp, HR, sleep) with auto-flagging for out-of-range values (e.g. BP ≥180/110 → "urgent" badge)
- **`/patient/telemedicine`** — WebRTC video call with chat (signaling via REST)
- **PWA** — `manifest.json` + `sw.js` so patients can install the portal as a home-screen app; service worker pre-caches the app shell for offline load (login still requires network)

All UI strings are in Hindi (`backend/lib/i18n.mjs`). Patient data lives in the same Vedadb instance — `patient_credentials`, `patient_vitals_log`, `reminders`, `tele_sessions`, `tele_messages` tables.

### Telemedicine (WebRTC + REST signaling)

- Doctor opens `/telemedicine` → patient ID → backend creates `tele_session`, returns `session_id`
- Doctor + patient each open the same `session_id` in their respective UIs
- In-call chat posts to `/api/telemedicine/:id/messages` → stored in `tele_messages`
- "Start Rx for patient" button (doctor console) deep-links to `/dashboard/prescribe?patient_id=X`
- "End call" marks the session as ended with `ended_at` timestamp

### Population health dashboard (`/analytics`)

Doctor + clinic view:
- **Clinic overview** — patient count by risk band, problem-distribution treemap, vitals control rates (BP/glucose/HbA1c at goal)
- **Cohort finder** — filter patients by ≥1 criteria: age band, diagnosis (ICD-10), HbA1c bucket, BP control status, recent visit
- **At-risk list** — patients with multi-flag anomaly (high BP + uncontrolled glucose + low adherence)
- All aggregations done via SQL on Vedadb; no Python ML in this view.

### Reminders (WhatsApp/SMS/Email/Push)

- Create reminders per patient (drug refill, vitals check, follow-up) with channel preference
- Channels are pluggable — `backend/lib/reminders.mjs` ships with mock providers that log to console + DB; Twilio/Meta-WhatsApp swap-in for prod
- `/api/reminders/fire-due` endpoint for cron (returns delivery count)
- `/reminders` page shows scheduled + delivery log + success/fail counts

### RAG over clinical guidelines (`/api/rag/query`)

11 seeded guideline documents (WHO, AACE, ICMR, NICE, AAAAI, MoHFW) indexed by keyword TF-IDF. Query endpoint:

```json
POST /api/rag/query
{ "query": "metformin first line for diabetes" }

→ {
  "method": "rag_no_llm",
  "context": "[1] WHO: WHO Type 2 Diabetes Management\nFirst-line therapy...",
  "citations": [{ "source": "WHO", "score": 0.412 }, ...],
  "message": "Set OPENAI_API_KEY env var for grounded answer."
}
```

When `OPENAI_API_KEY` is set, an LLM call (`backend/lib/llm.mjs` → OpenAI API with `gpt-4o-mini`) re-generates the answer grounded on the retrieved context, with explicit citation tracking and token-usage logging to `llm_usage`.

### LLM augmentation in clinical agents

The 5 LangGraph agents (lab_triage / drug_ix / followup / soap / coding) now proxy through `/api/ai/agents/llm`. Without an API key, they return the deterministic rules-based answer. With a key, the rules are passed as `context` to the LLM which produces a richer narrative grounded on the rules + retrieved guidelines.

### Audit log (`/audit`)

Every mutation is captured in `audit_log`:
- login (success/fail with actor)
- patient create
- vitals add
- Rx create
- note add/delete
- reminder create
- AI agent run (with confidence score)

Indexed on `ts DESC`, `resource_kind + resource_id`, `actor_kind + actor_id`, `clinic_id`. The `/audit` page lets the doctor filter by actor / resource / time window.

### Multi-tenancy basics

`clinics` table seeded with one demo clinic (`cl-001 / TatvaCare Demo Clinic / Mumbai`). `doctors.clinic_id` FK added (auto-set to `cl-001` for existing rows). `/clinic` page lists clinics and the doctors under each. Production-ready multi-tenancy (cross-clinic isolation, clinic-scoped queries) is deferred — see `docs/AI_UPGRADE_RESEARCH.md` Tier 4.

### New backend libs

| File | What it does |
|---|---|
| `backend/lib/patient_auth.mjs` | Patient login + `pid` session cookie (separate from doctor's `sid`) |
| `backend/lib/audit.mjs` | Audit-log writer for all mutations |
| `backend/lib/llm.mjs` | OpenAI wrapper with token tracking + clinical-context formatter |
| `backend/lib/rag.mjs` | TF-IDF RAG over `kb_documents` (no external API needed) |
| `backend/lib/i18n.mjs` | Hindi strings + EN→HI word/phrase map for auto-translation |
| `backend/lib/reminders.mjs` | WhatsApp/SMS/Email/Push mock providers + `fireDueReminders` |

### Demo flow (extended)

1. Doctor logs in as Dr. Aanya (`+919876500001`)
2. Dashboard → Analytics → see population health + cohort finder
3. Open `/reminders` → create a refill reminder for patient
4. Open `/telemedicine` → start a call with patient
5. Open `/ai` → run drug interaction check with LLM augmentation
6. Open `/audit` → see all of the above captured
7. Open `/clinic` → see doctors under clinic
8. Patient logs in at `/patient/login` as `+919812345670 / patient123` → log vitals → see flagged "high BP" badge → start telemedicine call with doctor

## Engine integration

This app is the test-bed for Vedadb's VBP v1 wire protocol. Bugs found while building this app are filed as PRs against `tiennesdm/vedadb-engine`:

- **[PR #80](https://github.com/tiennesdm/vedadb-engine/pull/80)** — 3-bug trifecta fixed in v1 wire:
  - `inferColumnTypes` defaulted to `T_TEXT` for unknown types (broke numeric inserts)
  - `parseCondition` rejected `column::TYPE` casts (broke PG-style type hints)
  - `execBatchInsert` ignored column defaults (broke auto-increment IDs)

**Known engine v1 quirks** (workarounds in code):

- `LOWER()` is broken — don't use; fetch + filter in JS or use `ILIKE` instead
- `LIKE` is case-sensitive — use `ILIKE` for case-insensitive
- `TIMESTAMPTZ DEFAULT now()` not supported — pass literal timestamps from JS
- Engine stores SQL NULL as literal string `"NULL"` for some columns — check before parsing
- `CURRENT_DATE + N` arithmetic not supported — compute in JS
- `%s` placeholders not supported — use string interpolation with `'` escaping

**VBP wire format** (verified against `internal/wire/vbp/client.go` and `frame.go`):

- Frame: `3-byte magic "VDB" + 4-byte LE u32 payload_len + 1-byte seq + 1-byte op + 1-byte flags + body`
- `payload_len = 2 + body_len` (op + flags + body; seq is in header)
- `OP_QUERY (0x06)` body: `[u32 query_id][u32 text_len][text utf-8][u16 param_count][params...]`
- Response frames: `OP_DATA_CHUNK (0x0A)` (chunk_id + row_count + col_count + per-col type/bitmap/data) → `OP_ROWS_FINISHED (0x0B)` (rows_affected + tag + exec_time) → `OP_COMMAND_COMPLETE (0x0C)` or `OP_ERROR (0x0D)`
- Server requires `OP_CLIENT_HELLO (0x01)` handshake first with `[u16 version=1][u16 flags][user][db][u8 actor_kind][actor_id]`

## Architecture notes

### Why vanilla HTML/JS instead of Next.js?

There's an experimental Next.js scaffold in `app/` (kept for reference) but the production path is pure vanilla — no build step means iterating on clinical UI is faster, and the whole stack fits in < 30 files of code. The `app/` dir is intentionally not used.

### VBP clients

Two implementations of the same VBP v1 protocol:

- **Node** (`backend/lib/vbp.mjs`) — uses `vbp-php-wt/node/src/wire/vbp` SDK with multiplexer for concurrent queries
- **Python** (`ai/service/vbp_client.py`) — hand-written binary client, persistent connection with thread lock

Both:
- Decode column types from engine typeIds (T_TEXT=25, T_BOOL=16, T_INT8=20, T_VARCHAR=1043)
- Handle fixed-width vs variable-width column data
- Treat SQL NULL as literal `"NULL"` string for some columns (clean in `common/db.py` and `auth.mjs`)

### Why a separate Python AI service?

Node has poor ecosystem for ML/DL — XGBoost, scikit-learn, Whisper, BioClinicalBERT, PyTorch, LangGraph are all Python-native. The Node backend proxies to Python via `fetch` calls to `http://127.0.0.1:7100`. The two services share the Vedadb instance via separate VBP clients, so all patient data stays in the same database.

### macOS-specific quirk

XGBoost 3.x and PyTorch both link OpenMP. On Apple Silicon, importing them in the same Python process can hang. Workaround in `ai/service/main.py`:

- `ml.*` (XGBoost) imported eagerly at module load
- `dl.*` (PyTorch) and `voice.*` (Whisper) imported lazily inside route handlers

This keeps everything in one process while avoiding the conflict.

### Demo flow

1. Log in as Dr. Aanya (`+919876500001`)
2. Dashboard shows today's schedule + tasks
3. Open patient → see vitals chart, problems, allergies, notes
4. Prescribe → ICD-10 autocomplete, drug autocomplete with interaction check, sign
5. Rx success card → Open PDF (single-page branded) or Download
6. Drug Monographs → search "metformin" or reverse-search "diabetes" → see full monograph
7. **AI Hub** → upload a lab report image (OCR), or paste a note (NLP), or speak (Whisper) → see auto-extracted entities, risk score, anomaly flags, SOAP draft

## License

Internal — Vedadb ecosystem.

