# TatvaCare

A chronic-care EMR + Digital Therapeutics platform built on **Vedadb's native VBP wire protocol (port 6381)** — no PG-wire anywhere in the stack.

## Why this exists

TatvaCare is a working clone of the production EMR/DTx product, built on top of Vedadb's own binary protocol (VBP v1) to validate that the engine can power a real clinical workflow end-to-end:

- Patient charts with vitals, problems, allergies, clinical notes
- Doctor scheduling + tasks + inbox
- Prescriptions with **drug-interaction checks** and **ICD-10 diagnosis autocomplete** (Indian clinical codes)
- **One-page branded Rx PDF** export with doctor signature + Rx-ID hash footer
- **Indian Primary Care Formulary** — 110+ drug monographs (mechanism, side effects, contraindications, pregnancy safety, interactions) plus a reverse index from indication → drug

The whole thing runs against a single Vedadb instance with **zero PG-wire**, using only the VBP binary protocol via a hand-written client (`backend/lib/vbp.mjs`).

## Stack

| Layer | Choice | Why |
|---|---|---|
| Database | Vedadb engine on VBP (`127.0.0.1:6381`) | Native wire protocol; PG-wire disabled |
| Backend | Node.js + Express 5 | Lightweight, fast iteration |
| Frontend | Vanilla HTML/JS + design system | No build step, fastest path to clinical UI |
| PDF | PDFKit (server-side) | One-page A4 Rx export |
| Charts | Chart.js | Vitals trends on patient chart |

## Repo layout

```
tatvacare/
├── backend/                    Express server (port 3000)
│   ├── server.mjs              All routes (clinical, PDF, formulary, ICD-10)
│   ├── lib/
│   │   ├── vbp.mjs             VBP binary client (decoder/encoder)
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
├── db/migrations/              SQL schema (001-005)
├── public/                     Vanilla HTML/JS frontend
│   ├── dashboard.html
│   ├── patient.html            Chart + Notes tab
│   ├── prescribe.html          ICD-10 autocomplete + Rx sign + PDF download
│   ├── calendar.html
│   ├── inbox.html
│   ├── drugs.html
│   ├── formulary.html          2-mode search (by drug | by indication)
│   └── style.css               Design system
├── tests/                      e2e + visual test scaffolding
├── artifacts/                  Sample Rx PDFs, screenshots, 95-page formulary.pdf
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

### 2. Install deps + migrate

```bash
cd backend
npm install
node scripts/migrate.mjs
```

This applies all 5 migration files (`001_init.sql` through `005_notes.sql`) including seed data for 3 demo doctors.

### 3. Start the server

```bash
node server.mjs
# → listening on :3000
```

### 4. Log in

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

## Architecture notes

### Why vanilla HTML/JS instead of Next.js?

There's an experimental Next.js scaffold in `app/` (kept for reference) but the production path is pure vanilla — no build step means iterating on clinical UI is faster, and the whole stack fits in < 30 files of code. The `app/` dir is intentionally not used.

### VBP client

`backend/lib/vbp.mjs` is a hand-written binary client for VBP v1:

- Magic: `"VDB"` (3 bytes) + `u32 payload_len` + `u32 seq` + `u16 op` + `u16 flags` + body
- `OP_QUERY` body: `[u32 query_id][u32 text_len][text][u16 param_count]`
- Type-aware decoder trusts engine typeIds (T_TEXT=25, T_BOOL=16, T_INT8=20, T_VARCHAR=1043, FIXED_WIDTH varies)

### Demo flow

1. Log in as Dr. Aanya (`+919876500001`)
2. Dashboard shows today's schedule + tasks
3. Open patient → see vitals chart, problems, allergies, notes
4. Prescribe → ICD-10 autocomplete, drug autocomplete with interaction check, sign
5. Rx success card → Open PDF (single-page branded) or Download
6. Drug Monographs → search "metformin" or reverse-search "diabetes" → see full monograph

## License

Internal — Vedadb ecosystem.
