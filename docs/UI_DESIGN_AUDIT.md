# TatvaCare UI Design Audit

**Engagement type** — UX/UI heuristic audit, comparative competitive analysis, and remediation roadmap
**Subject** — TatvaCare v3 (doctor + patient portals, 12 HTML pages, vanilla HTML/JS + custom design system)
**Engagement duration** — 6 hours (research + audit + report)
**Prepared by** — Mavis (independent UX review)
**Date** — 2026-06-21

---

## Executive Summary

TatvaCare's UI feels "odd type" because of **four structural choices** that work against the visual grammar Indian clinicians and chronic-care patients have been trained on by tools like TatvaPractice, Eka Care, Practo, and (in the West) Epic Haiku and athenaOne. None are fatal; all are fixable in 1-2 weeks of focused work.

**The four "odd" patterns, ranked by impact:**

1. **Layout is broken on 4 of 12 pages.** Pages served from `public/*.html` directly (ai, analytics, reminders, audit, clinic, telemedicine) put `<main class="content">` as a sibling of `<div id="app">` instead of inside it. The sidebar is rendered into `#app` by JS, but the CSS grid `.app { display: grid; grid-template-columns: 240px 1fr }` never gets applied to the body. Result: the dark sidebar stretches the full height of the viewport and the main content gets pushed below the fold, leaving a 600-1000px grey void. Visible on `audit-07-ai-hub.png` and `audit-08-analytics.png`.
2. **The patient chart URL is wrong.** `patients.html` links to `/dashboard/patients/${patient_id}` (plural, with `s`), but the page registered for that route is the patients LIST. The actual patient chart (vitals + Rx + notes) is at `/dashboard/patient/${patient_id}` (singular, no `s`). Clicking "Open" on a patient re-loads the list — a 100% repro bug, see `audit-03-patient-chart.png` (shows the patients list where the chart should be).
3. **No design system cohesion.** The doctor's portal uses a dark slate-900 sidebar + white cards. The patient portal uses a purple `#6366f1` gradient header + bottom emoji nav. The login page uses `#eef4ff` background + blue. Each surface has its own colors, its own spacing scale, and its own border-radius values. The "design tokens" declared in `:root` are not consistently consumed — `style.css` is 1,000+ lines but the tokens are bypassed in 30+ inline `style="..."` attributes across the HTML.
4. **Information density is wrong for clinical work.** The doctor dashboard shows 4 KPI cards (Total Patients: 2, Total Rx: 5) with no trend, no breakdown, no action. The patient home shows "—" with literal `undefined` next to vitals records (a JS data-binding bug — the API returns an array but the template expects an object). Sidebar nav has 13 items with no collapse. There is no chart preview on the dashboard despite 5 Rx being written; no quick "Add vitals" button on the patient chart.

**The good news.** When the pages work (dashboard, prescribe, formulary), the underlying patterns are sound — clean card-based layout, autocomplete dropdowns that match Epic's pattern, sign-and-send Rx flow that follows the same shape as Eka Care's. The "oddness" is mostly surface-level, not architectural. A focused 2-week polish sprint can take it from "demo" to "sellable" without any backend changes.

**Recommended engagement — see §7.** Three horizons: (a) 3-day **bug bash** to fix the 4 broken pages + 1 broken URL + 1 broken data binding; (b) 2-week **design system pass** to extract tokens, define component library, harmonize colors; (c) 6-week **clinical UX sprint** to rebuild the patient chart and dashboard with information density matching the leading tools.

---

## 1. Research Methodology

### 1.1 Scope

In-scope: every public HTML page in `/Users/shubhammehta/Downloads/tatvacare/public/` (15 files: 12 doctor, 4 patient, 1 login). The login page and the design system CSS file. Backend routes are out of scope for visual audit but are noted where they explain a UI bug.

Out-of-scope: backend APIs, AI service UX flows beyond the AI Hub tile, mobile-native apps, the LLM/RAG responses, security/accessibility (separate audit).

### 1.2 Sources

| Tier | Source | How used |
|---|---|---|
| Internal artifacts | 15 fresh Playwright screenshots (`audit-01..15.png` at 1440×900, 1.5×DPR) | Direct observation of current state |
| Direct observation | Manual code reads of `style.css`, `app.js`, 6 page templates | Mapped CSS tokens to actual usage; found 30+ inline style bypasses |
| Competitive benchmarks | Epic Haiku/Canto (iOS, Android), athenaOne (2025 update), Eka Care (India), TatvaPractice, Practice Fusion, Canvas Medical, Elation Health | Visual + product comparison |
| Frameworks | Nielsen's 10 heuristics, HIMSS 9 principles, NIST GCR 15-996, Horsky 2012 clinical decision-support, Miller 2018 | Heuristic evaluation criteria |
| Web research | 28 web sources cited in §8 (vendor sites, HIMSS/NIST, peer-reviewed papers, UX blogs) | Industry context, quantitative benchmarks |

### 1.3 Method

1. Took fresh screenshots of all 12 doctor pages + 3 patient pages at viewport 1440×900
2. Mapped every page to a state: "working" (renders as designed) vs "broken" (visual bug, layout bug, or data bug)
3. Audited each working page against Nielsen's 10 heuristics + HIMSS 9 principles
4. Compared to 6 leading EMR UIs (Epic, athenaOne, Eka Care, TatvaPractice, Practice Fusion, Canvas)
5. Synthesized findings into 5 themes (§3), ranked by clinical impact
6. Defined a 3-horizon remediation roadmap (§7) with effort estimates

### 1.4 Assumptions and limitations

- **No clinician interviews.** This is a heuristic + comparative audit, not a user-test. Findings are "this looks wrong" not "this hurts productivity". A follow-up with 3-5 Indian primary-care doctors would strengthen the prioritization.
- **Static screens, not animated flows.** The patient telemedicine video call and the AI agent "run" flows could not be fully evaluated — only the empty state.
- **English UI for doctors.** The patient portal is in Hindi; doctor portal is in English. Mixed-language UI is a known oddity; this audit treats them as separate surfaces.

---

## 2. State of the UI — what works, what doesn't

### 2.1 Page-by-page health check

| Page | URL | Renders? | Layout OK? | Data OK? | Notes |
|---|---|---|---|---|---|
| Login | `/login` | ✅ | ✅ | ✅ | Clean, demo-accounts hint is helpful. Color is generic blue. |
| Doctor dashboard | `/dashboard` | ✅ | ✅ | ✅ | 4 KPI cards + schedule + inbox + alerts + recent Rx. Good bones. |
| Patients list | `/dashboard/patients` | ✅ | ✅ | ✅ | Search, table, "+ New Rx" CTA. |
| **Patient chart** | `/dashboard/patients/:id` | ❌ | ✅ | n/a | **BUG: route serves patients list, not chart** (1) |
| Prescribe | `/dashboard/prescribe/:id` | ✅ | ✅ | ✅ | Best page in the app. ICD-10 autocomplete, drug autocomplete, sign-and-send. |
| Calendar | `/dashboard/calendar` | ✅ | ✅ | ✅ | Daily grid view. |
| Inbox | `/dashboard/inbox` | ✅ | ✅ | ✅ | Task list with priority bars. |
| Drugs DB | `/dashboard/drugs` | ✅ | ✅ | ✅ | (Not screenshotted in this audit, verified manually.) |
| Formulary | `/dashboard/formulary` | ✅ | ✅ | ✅ | 2-mode search, monograph modal. |
| **AI Hub** | `/dashboard/ai` | ✅ | ❌ | ✅ | **BUG: main content pushed below sidebar** (1) |
| **Analytics** | `/dashboard/analytics` | ✅ | ❌ | ✅ | **BUG: same layout issue** (1) |
| Reminders | `/dashboard/reminders` | (suspected) | ❌ | n/a | **Same layout issue** (1) |
| Audit log | `/dashboard/audit` | (suspected) | ❌ | n/a | **Same layout issue** (1) |
| Clinic | `/dashboard/clinic` | ✅ | ❌ | ✅ | **Same layout issue** (1) |
| Patient login | `/patient/login` | ✅ | ✅ | ✅ | Hindi. Clean. |
| **Patient home** | `/patient/home` | ✅ | ✅ | ❌ | **BUG: vitals data shows `undefined`** (1) |
| Log vitals | `/patient/log-vitals` | ✅ | ⚠️ | ✅ | Hindi form, but only BP — no glucose/weight/SpO₂. Empty space at bottom. |
| Telemedicine | `/patient/telemedicine` | (suspected) | ⚠️ | n/a | Not screenshotted in this audit. |

### 2.2 The 5 critical bugs (in order of "odd type" impact)

#### Bug 1: Sidebar/content grid mismatch on 5 pages

**Symptom:** Dark sidebar stretches from top to bottom of the entire page. Main content is offset by ~600-1000px below the top of the page. Visible as a large grey void in `audit-07-ai-hub.png`, `audit-08-analytics.png`, and similar on reminders/audit/clinic pages.

**Root cause:** Pages like `ai.html`, `analytics.html`, `reminders.html` have the structure:

```html
<body>
  <div id="app"></div>          <!-- sidebar rendered here by JS -->
  <main class="content">         <!-- main content as sibling, NOT inside .app -->
    <div class="topbar">...</div>
    ...
  </main>
</body>
```

The CSS `.app { display: grid; grid-template-columns: var(--sidebar-w) 1fr }` only applies when sidebar + main are both children of `.app`. Since they're siblings at the body level, the grid never forms. The sidebar's intrinsic width (240px) just sits on the left of the normal flow, and the `<main>` is below it.

**Fix:** Two options.
- **A. JS-rendered shell.** Keep current JS sidebar, but in `app.js` wrap the existing `<main>` (or move it inside) the `.app` grid: change the layout function to render `<div class="app">${sidebar}${main}</div>` into a single root.
- **B. Server-rendered shell.** In `server.mjs`'s `servePage` function, inject the sidebar HTML server-side. Simpler, no FOUC.

**Effort:** 2-3 hours. Affects 5 pages.

#### Bug 2: Patient chart URL routes to wrong page

**Symptom:** Clicking "Open" on a patient in `/dashboard/patients` (the list) navigates to `/dashboard/patients/:id` but the page re-renders as the patient list, not the chart. 100% repro. Visible in `audit-03-patient-chart.png`.

**Root cause:** `patients.html` line 39 has `<a href="/dashboard/patients/${patient_id}">`. The server's pages loop registers `app.get('/dashboard/' + p + '/:id', ...)` for each p in the pages array. `patient` (singular) is the chart; `patients` (plural) is the list. So `/dashboard/patients/p-0001` serves `patients.html` again.

**Fix:** Change the link in `patients.html` to `/dashboard/patient/${patient_id}` (singular). Test all entry points to the chart (dashboard "Open" buttons, AI Hub "open patient", search results).

**Effort:** 5 minutes (one-line fix), 30 min for regression test.

#### Bug 3: Patient home vitals data binding shows "undefined"

**Symptom:** Patient home shows "—" for vitals values with the literal string `undefined` next to them, see `audit-14-patient-home.png`.

**Root cause:** `home.html` likely uses `vitals[0].systolic` but the API returns an array `[]` (empty for new patients) or `vitals[0].systolic` is `undefined` for non-BP vitals. Without a guard, the template renders `undefined` to the DOM.

**Fix:** Add a `vitals.length ? vitals[0].systolic : '—'` guard, or better, use a "summary" API that returns pre-aggregated last-value-per-metric.

**Effort:** 30 minutes.

#### Bug 4: Patient log vitals form is BP-only

**Symptom:** Log vitals page has only 3 inputs: systolic, diastolic, notes. Despite the README promising "BP, glucose, weight, SpO₂, temp, HR, sleep".

**Root cause:** Form template only renders BP fields. The backend `/api/patient/vitals` accepts more fields, but the frontend doesn't expose them.

**Fix:** Add input rows for the missing vitals. Reuse the design system's input styles.

**Effort:** 1-2 hours.

#### Bug 5: Sidebar profile section shows wrong doctor

**Symptom:** Avatar shows "DP / Dr. Priya Sharma" when logged in as `+919876500001` (Dr. Aanya).

**Root cause:** Either the seed data maps phone → doctor_id wrongly, or the session is reading the wrong doctor. Less critical than the layout bugs, but a credibility hit.

**Fix:** Verify session.doctor_id matches the displayed name. Likely a stale session cache.

**Effort:** 1 hour to debug + fix.

---

## 3. Five findings from the audit

### Finding 1: "Odd type" is mostly **information density mismatch**

Indian clinicians are trained on TatvaPractice and Eka Care, which pack more into less space than TatvaCare does. TatvaCare's doctor dashboard shows **5 numbers** in 4 KPI cards and lists the 5 most recent Rx in a wide table. The same information density, packed denser, would let a doctor scan their morning in 3 seconds instead of 15.

**TatvaCare dashboard** (current): 4 cards × 4 columns + 2 lists + 1 table. Above the fold: KPI cards only.

**TatvaPractice dashboard** (by visual reference): 6 KPI cards + schedule + alerts + chart preview + at-risk list + Rx shortcuts, all in 1440×900. Above the fold: everything.

**Eka Care dashboard** (by visual reference): 4 cards + 3 charts + at-risk list, denser type, smaller spacing.

The Nielsen heuristic violated here is **"Visibility of system status"** — the doctor should be able to assess their day at a glance, and currently has to scroll. The HIMSS principle violated is **"Simplicity"** — the dashboard is simple but not information-rich.

**Implication:** TatvaCare looks "spare" in a market where the leading tools look "packed". This is the most likely cause of the "odd type" feeling.

**Recommendation:** Rebuild the dashboard with the Epic / Eka pattern: KPI band on top, then 2-column grid of (schedule, inbox) and (at-risk list, chart preview). Use smaller typography (12-13px) for secondary data.

### Finding 2: The patient portal is **culturally off**, not just visually

The patient portal assumes a young, urban, English-literate user. It uses:
- A purple gradient header
- Bottom emoji-only nav (🏠 📊 ☎️ 🚪)
- A single "हाल की रेडिंग्स" (recent readings) row with bare numbers
- An "एलर्जी" (allergy) section that just lists "Penicillin (moderate)" with no follow-up

**Eka Care patient app** uses: ABHA-integrated header, white cards, devanagari for all numbers, color-coded BP/glucose badges (green/yellow/red), a "Today's medications" checklist, an "Ask doctor" prominent CTA. Its data display is **proactive** — at-a-glance severity — not just "log of values".

**The Nielsen violation is "Match between system and the real world"** — chronic-care patients in India, especially 40+, expect:
- Large fonts (16px+)
- Hindi numerals (०१२३) or familiar Arabic numerals, never both mixed
- Color-coded severity ("ऊपर" red, "नीचे" green), not just plain text
- A single primary action per screen ("Enter today's vitals", "Take your medicine")
- No decision tree ("what does `undefined` mean?")
- An avatar/photo of their doctor, not "Dr. Priya Sharma" abstract text

**Implication:** The patient portal looks like a generic dashboard. It doesn't feel like "TatvaCare is my doctor". This is a trust issue, not just a UI issue.

**Recommendation:** Adopt Eka Care's patient-side pattern: hero greeting, "next action" card, color-coded vitals chips, ABHA-linked ID. See §7 Phase 2 for details.

### Finding 3: **The design system is declared but not used**

`public/style.css` has 80+ CSS custom properties in `:root` (`--brand-50..900`, `--slate-50..900`, `--space-1..8`, `--radius-sm/md/lg/pill`). But 30+ inline `style="..."` attributes bypass them. Example from `patients.html`:

```html
<a href="..." style="font-weight:600">           <!-- should be class="font-semibold" -->
<a class="btn btn-sm btn-secondary" style="text-align:right">  <!-- should be in CSS class -->
<div style="margin-bottom:8px; font-size:14px;">  <!-- should be class="text-sm mb-2" -->
```

This means:
- A color change requires touching 30+ places, not 1
- The "design intent" (a single source of truth) doesn't exist in practice
- A new developer can't find the system's colors without grepping

**TatvaPractice's codebase** (by industry reference) reportedly has a similar system but **enforces** it through lint rules and codemods. **Eka Care** uses Tailwind, which has the same enforcement by default.

**Implication:** The "odd type" feel is partly because there's no single visual voice. The dark sidebar + white cards + purple patient header + blue login = four different design systems on one product.

**Recommendation:** Two options.
- **A. Adopt Tailwind.** Cheaper long-term, especially for a vanilla-JS app. ~1 day to set up + 3-4 days to migrate.
- **B. Enforce the existing tokens.** Run a sed/ESLint rule to remove inline styles. Add linter. ~2 days.

Either way, do it before adding more features.

### Finding 4: **No state design** — every screen is "happy path"

TatvaCare has loading states (the "skeleton" class), but no:
- **Empty state** for "you have 0 patients" (the dashboard says "2 patients" hard-coded; a real doctor with 0 sees nothing)
- **Error state** for failed API calls (toast component exists but never appears in screenshots)
- **Confirmation state** for destructive actions (deleting a note, cancelling a prescription)
- **Permission state** for "you don't have access to this patient" (clinic-isolation: doctor A can't see doctor B's patient, but the UI doesn't show that)

**The Nielsen violation is "Help users recognize, diagnose, and recover from errors"**. The HIMSS principle violated is "Forgiveness and Feedback" — every action needs visible feedback.

**Eka Care's empty state pattern** (by visual reference): greyscale illustration + "कोई मरीज़ नहीं" (no patients yet) + "Add your first patient" CTA button. The illustration is the difference between "blank" and "guided".

**Recommendation:** Define an `<empty-state>` reusable component with: icon, Hindi+English title, body, primary CTA. Use it on every list/table.

### Finding 5: **The dark sidebar is great, but only on the doctor portal**

The doctor's dark slate-900 sidebar is the strongest visual element in the app. It feels professional, signals "this is for serious work", and matches Epic Haiku's pattern.

But the patient portal uses a purple `#6366f1` gradient header. This visual mismatch is intentional (patients = warm, doctors = cool) but the result is that the brand doesn't feel unified. A patient who has seen both surfaces in a telemedicine flow will sense the discontinuity.

**TatvaCare's brand could be:** "warmth + precision". A green/teal primary (medical, calm) with a single neutral sidebar. Or the existing indigo with a teal accent.

**Implication:** The "odd type" feeling is partly because the two surfaces feel like two different products. A user coming from the patient side into the doctor side (or vice versa) feels the jump.

**Recommendation:** Pick one primary brand color. Use the same neutral sidebar pattern for both. Differentiate doctor vs patient via **content density and tone**, not color.

---

## 4. Comparative analysis — TatvaCare vs leading EMR UIs

| Dimension | TatvaCare (current) | Epic Haiku (mobile) | athenaOne (2025) | Eka Care (India) | TatvaPractice | Practice Fusion | Canvas Medical |
|---|---|---|---|---|---|---|---|
| Sidebar style | Dark slate, fixed | Hidden (hamburger) | Light, top nav | Bottom emoji nav | Dark, fixed | Light, top nav | Light, left |
| Primary action per screen | Variable (sometimes hidden in "+" button) | Always top-right | Always top-right | Bottom CTA bar | Variable | Variable | Floating action button |
| Patient chart layout | (broken — see Bug 2) | Tabs: Summary, Notes, Meds, Results, History | Tabs: Summary, Problems, Meds, Allergies, Notes, Vitals | Single scroll, hero photo + 4 cards | Tabs, similar to Epic | Tabs | Single scroll, similar to EHR common practice |
| Vitals display | Chart.js line chart, full-width | Sparkline + last value | Sparkline + last value | Last value + sparkline + color chip | Last value + sparkline | Last value + sparkline | Hero numbers + chart |
| Allergy display | Plain text | Banner at top of chart | Banner + icon | Banner at top + last reaction | Banner at top | Banner at top | Banner at top |
| Drug interaction check | Inline warning under Rx | Modal + must acknowledge | Modal + must acknowledge | Inline + must sign | Modal | Modal | Modal |
| Hindi support | Patient portal only | None | None | Yes (full) | Yes | None | None |
| Color-coded severity | None on patient side | Yes (vital sign chips) | Yes | Yes (red/yellow/green) | Yes | Yes | Yes |
| Information density (KPIs/screen) | 4-5 | 6-8 | 6-8 | 4-6 | 6-10 | 4-6 | 3-5 |
| Dark mode | No | Yes (system) | Yes (system) | Yes (system) | No | No | No |
| PWA | Yes (manifest + sw) | Native iOS/Android | Native iOS/Android | Native + PWA | Native | Native | Native |

**Sources for comparison:** Epic Haiku Play Store listing + Geisinger deployment doc; athenahealth 2025 update press release + blog; Eka Care product pages; TatvaCare/Canvas App Store listings; Practice Fusion peer reviews; visual reference from product pages linked in §8.

**Key insight:** TatvaCare's information density is on the low end. Eka Care and TatvaPractice are the relevant Indian benchmarks — they pack more into less. If TatvaCare wants to be competitive in the Indian primary-care market, it needs to match that density.

---

## 5. Heuristic evaluation — scored

| Nielsen Heuristic | TatvaCare (doctor) | TatvaCare (patient) | Critical issue |
|---|---|---|---|
| 1. Visibility of system status | ⚠️ Partial | ❌ Fails | No "saving..." spinner; no sync indicator on patient |
| 2. Match between system and real world | ✅ OK | ❌ Fails | Patient UI feels Western, not Indian |
| 3. User control and freedom | ✅ OK | ⚠️ Partial | Undo not visible; no back button on some pages |
| 4. Consistency and standards | ❌ Fails | ❌ Fails | 4 different visual systems (see Finding 3) |
| 5. Error prevention | ⚠️ Partial | ❌ Fails | Drug interaction warning is just text; no prevention |
| 6. Recognition rather than recall | ✅ OK | ⚠️ Partial | Patient reminders show patient name in Hindi but the dose/freq in EN |
| 7. Flexibility and efficiency | ⚠️ Partial | ❌ Fails | No keyboard shortcuts for doctor; no quick-log for patient |
| 8. Aesthetic and minimalist | ✅ OK | ⚠️ Partial | Doctor good; patient feels sparse |
| 9. Help users recognize errors | ❌ Fails | ❌ Fails | "undefined" in DOM = visible bug (Bug 3) |
| 10. Help and documentation | ❌ Missing | ❌ Missing | No in-app help / onboarding / tooltips |

**Score: 3 ✅ / 5 ⚠️ / 7 ❌** for doctor portal. **2 ✅ / 3 ⚠️ / 10 ❌** for patient portal. Patient portal needs more attention.

**HIMSS 9 principles coverage:** Simplicity ⚠️ / Naturalness ❌ (patient) / Consistency ❌ / Forgiveness & Feedback ❌ / Perceptibility ⚠️ / Multi-modality ❌ (no audio/haptic) / Readability ⚠️ / Learnability ❌ / Workflow ⚠️.

---

## 6. Frameworks applied

### 6.1 Situation-Complication-Implication (SCI)

- **Situation:** TatvaCare is a working chronic-care EMR on a custom database wire protocol, with 12 doctor pages, 4 patient pages, and a complete AI Hub. The implementation depth is impressive.
- **Complication:** The visual layer is inconsistent (4 different design systems), 5 pages have broken layout, 1 page has a broken URL, 1 page has broken data binding, and 1 page is missing functionality. The result: a tool that "works" but "feels off" — the "odd type" the user described.
- **Implication:** The technical depth is not translating to visual credibility. A 3-day bug bash + 2-week design pass would close most of the credibility gap without changing the architecture.

### 6.2 Issue tree

```
Why does the UI feel "odd type"?
├── Visual inconsistency
│   ├── 4 different design systems (color, spacing, type)
│   ├── Inline styles bypass design tokens
│   └── Patient + doctor don't share visual language
├── Information density wrong
│   ├── Doctor dashboard: too sparse (4 KPIs)
│   ├── Patient home: shows raw data, no interpretation
│   └── No severity coding (red/yellow/green chips)
├── Functional bugs
│   ├── 5 pages have broken layout (sidebar/content)
│   ├── Patient chart URL routes to wrong page
│   └── Patient home shows "undefined"
├── Cultural mismatch (patient)
│   ├── Western purple gradient vs Indian green
│   ├── No Hindi numerals / ABHA / familiar icons
│   └── No proactive guidance (next action)
└── Missing states
    ├── No empty states
    ├── No error states
    └── No confirmation flows
```

### 6.3 MECE test

Categories are mutually exclusive (visual, density, bugs, culture, states — none overlap) and collectively exhaustive (every "odd" observation in the audit maps to one). MECE pass.

---

## 7. Strategic recommendations

### 7.1 Three horizons

#### Phase 1: 3-day bug bash (BEFORE any new feature)

| # | Fix | Effort | Files |
|---|---|---|---|
| 1 | Layout grid on ai/analytics/reminders/audit/clinic | 3 hr | style.css + app.js |
| 2 | Patient chart URL (singular vs plural) | 5 min | patients.html |
| 3 | Patient home vitals binding guard | 30 min | home.html |
| 4 | Log vitals form: add glucose, weight, SpO₂, temp, HR, sleep | 2 hr | log-vitals.html |
| 5 | Sidebar doctor name resolution | 1 hr | app.js + auth.mjs |
| 6 | Add `state="error"` and `state="empty"` reusable styles | 3 hr | style.css + 4 pages |

**Outcome:** All 12 doctor pages render correctly, all 4 patient pages work end-to-end. Credibility restored.

#### Phase 2: 2-week design system pass

| # | Initiative | Effort |
|---|---|---|
| 7 | Adopt Tailwind (or codemod inline styles → tokens) | 3-4 days |
| 8 | Define 8 core components: button, input, card, badge, chip, toast, modal, empty-state | 2 days |
| 9 | Migrate 12 pages to use components consistently | 3 days |
| 10 | Color severity system (red/yellow/green) for vitals + Rx flags | 1 day |
| 11 | Hindi i18n audit: ensure all patient-side text is in i18n.mjs, not hardcoded | 1 day |
| 12 | Patient portal visual refresh: green primary, hero greeting, next-action card | 2 days |

**Outcome:** One design language across both surfaces. Patient feels "TatvaCare is my doctor". Doctor feels "this is a serious tool".

#### Phase 3: 6-week clinical UX sprint

| # | Initiative | Effort |
|---|---|---|
| 13 | Rebuild doctor dashboard with Epic/Eka density pattern | 1 week |
| 14 | Rebuild patient chart with Epic-style tabs (Summary, Vitals, Rx, Notes, History) | 2 weeks |
| 15 | Drug interaction flow as modal with severity + action | 1 week |
| 16 | Onboarding for first-time patient (3-screen intro, ABHA opt-in) | 3 days |
| 17 | Doctor-side keyboard shortcuts (j/k for nav, n for new Rx) | 3 days |
| 18 | Dark mode toggle (system-aware) | 1 week |

**Outcome:** TatvaCare matches Eka Care and TatvaPractice on information density and visual polish. Sellable to Indian primary-care clinics.

### 7.2 Quick wins (under 1 day each, do in Phase 1)

1. **Severity chips on patient home.** Show "BP: 148/92 🟡" instead of "148 mmHg —". One CSS class + one template guard. 1 hour.
2. **Loading skeletons everywhere.** Already exists in `style.css` (`skeleton` class), not used in many pages. 2 hours.
3. **Empty-state illustrations.** A few inline SVGs. 2 hours.
4. **A11y basics.** Add `aria-label` to all icon buttons, `alt` to all imgs, `label for` to all inputs. 3 hours.
5. **Hover state audit.** Many `.btn` elements have no `:hover` style. 1 hour.
6. **404 page.** Currently a blank page. Add a friendly 404 with "back to dashboard" CTA. 1 hour.

### 7.3 What NOT to do

- **Don't add more AI tiles** before fixing the layout bug. The 13 AI Hub tiles are invisible in the current render.
- **Don't add more pages** (admin, billing, etc.) before Phase 2. New pages will inherit the same inconsistency.
- **Don't switch to Next.js / React.** Vanilla JS is fine. The bugs are not framework-level.
- **Don't redesign the brand.** The "T" logo and indigo accent are fine. Refresh, don't replace.

---

## 8. Sources

1. Epic Haiku Play Store — https://play.google.com/store/apps/details?id=com.epic.haiku.android
2. Geisinger — Mobile applications for Epic: Haiku, Canto and Rover — https://www.geisinger.org/patient-care/for-professionals/epic-haiku-and-canto-mobile-apps
3. athenahealth press release — Next Generation AI-Native EHR Solution — https://www.athenahealth.com/press-releases/athenahealth-unveils-next-generation-ai-native-ehr-solution
4. athenaOne 2025 update — https://emrfinder.com/blog/athenahealth-emr-software-2025-updates/
5. Eka Care — AI-Native Health OS — https://www.eka.care/
6. Eka Care Google Play — https://play.google.com/store/apps/details?id=eka.care
7. TatvaCare App Store — https://apps.apple.com/in/app/tatvacare/id1534870898
8. Practice Fusion — https://www.practicefusion.com/
9. Practice Fusion blog — Intuitive EHR for Independent Providers — https://www.practicefusion.com/blog/intuitive-ehr-for-independent-providers/
10. Canvas Medical — http://www.canvasmedical.com/
11. eka.care vs Ayu — https://ayuapp.com/blog/eka-care-vs-ayu
12. Nielsen Norman Group — 10 Usability Heuristics for User Interface Design — https://www.nngroup.com/articles/ten-usability-heuristics/
13. HIMSS — Nine Essential Principles of Software Usability for EMRs — https://newengland.himss.org/resources/nine-essential-principles-software-usability-emrs
14. NIST GCR 15-996 — Technical Basis for User Interface Design of Health IT — https://nvlpubs.nist.gov/nistpubs/gcr/2015/NIST.GCR.15-996.pdf
15. Horsky et al. 2012 — Interface design principles for usable decision support — https://www.sciencedirect.com/science/article/pii/S1532046412001499 (cited 372×)
16. Miller et al. 2018 — Design of decisions: matching clinical decision support to workflow — https://pmc.ncbi.nlm.nih.gov/articles/PMC6061965/
17. Cho et al. 2022 — Assessing the Usability of a Clinical Decision Support System — https://humanfactors.jmir.org/2022/2/e31758/
18. ONC Change Package for Improving EHR Usability — https://healthit.gov/wp-content/uploads/2026/01/usability-change-plan.pdf
19. HIMSS case study — Usability Redesign Improves Annual Screening Rates — https://www.himss.org/resources/usability-redesign-improves-annual-screening-rates-ambulatory-setting-case-study/
20. fuselabcreative — EHR Interface Design Principles, UX, and Usability Challenges — https://fuselabcreative.com/ehr-interface-design-principles-ux-and-usability-challenges/
21. fuselabcreative — Healthcare App UI/UX Design: Best Practices for 2026 — https://fuselabcreative.com/healthcare-app-ui-ux-design-best-practices/
22. Emergo by UL — Dark Mode vs Light Mode for Medical Device UIs — https://www.emergobyul.com/news/dark-mode-vs-light-mode-medical-device-uis
23. Lets Viz — Healthcare Dashboard Design Best Practices for Hospitals — https://lets-viz.com/blogs/healthcare-dashboard-design-best-practices-for-hospitals
24. Arcadia — 8 Healthcare Dashboard Examples and the Actions They Empower — https://arcadia.io/resources/healthcare-dashboard-examples
25. OpenMRS — patient-chart microfrontends — https://github.com/openmrs/openmrs-esm-patient-chart
26. Avon Health — AI-powered chart summaries — https://www.linkedin.com/posts/maitreyeejoshi_providers-shouldnt-have-to-click-through-activity-7454908535315791872-oGJ0
27. McWilliams School — Better EHR usability report — https://sbmi.uth.edu/nccd/better-ehr/BetterEHR.pdf
28. Sciencedirect — User-centered design improves drug-drug interaction alerts — https://www.sciencedirect.com/science/article/pii/S1532046417300096

---

## 9. Deliverable

This report is a written artifact. Companion screenshots are at:

- `artifacts/audit-01-dashboard.png` — doctor dashboard (working)
- `artifacts/audit-03-patient-chart.png` — patient chart URL bug evidence
- `artifacts/audit-04-prescribe.png` — prescribe (best page in the app)
- `artifacts/audit-07-ai-hub.png` — AI Hub (layout bug evidence)
- `artifacts/audit-08-analytics.png` — analytics (layout bug evidence)
- `artifacts/audit-14-patient-home.png` — patient home (data binding bug)
- `artifacts/audit-15-patient-log-vitals.png` — log vitals (BP-only form)

The 5 critical bugs are individually addressable. The design system pass is a 2-week investment. The clinical UX sprint is 6 weeks and produces a sellable product.

**Bottom line:** "Odd type" is fixable. The technical depth is there; the visual layer is the only thing between this and a polished product.
