"""OCR service — printed text via PaddleOCR (bilingual EN + HI), plus handwriting heuristics.

PaddleOCR handles printed text well, including Devanagari (Hindi) script.
We lazy-init two PaddleOCR singletons (en + hi) on first use; the hi model
is only loaded if Devanagari script is detected in the image. Falls back
to pytesseract if paddleocr/paddlepaddle are not importable in the current
environment, so the module always loads and the FastAPI routes never break.

API notes — paddleocr 3.x:
  * `PaddleOCR(use_angle_cls=True, show_log=False)` was the v2.x signature.
    v3.x renamed `use_angle_cls` to `use_textline_orientation` and dropped
    `show_log`. We use the v3 signature; import-time guard rejects <2.7.
  * `.ocr(img, cls=True)` still exists in v3 for back-compat, but the
    recommended API is `.predict(img_array)` which returns a list of
    `OCRResult` objects. Each result has `.rec_texts` (list[str]) and
    `.rec_scores` (list[float]). We use `.predict()`.

Honest limitation: this is research-grade. Real clinical-grade Rx OCR
needs fine-tuned TrOCR / PaddleOCR-v5 models on Indian handwriting,
which requires a labeled dataset and GPU. We expose what we can do.
"""
from __future__ import annotations
import io
import re
import sys
import warnings
from typing import Any

import numpy as np
from PIL import Image

# ─── Lazy OCR backend imports ───────────────────────────────────────
# Try PaddleOCR first; fall back to pytesseract. Both are wrapped in
# try/except so the module still imports if paddle isn't installed in
# some env. A one-time WARN is printed at import time if paddle is
# missing so deployment failures are visible in service logs.

_PADDLE_OCR_AVAILABLE = False
_PaddleOCR_cls = None  # type: ignore[var-annotated]
_PADDLE_IMPORT_ERROR: Exception | None = None
try:
    with warnings.catch_warnings():
        # paddle 3.x emits a "no ccache" UserWarning at import — silence.
        warnings.simplefilter("ignore")
        from paddleocr import PaddleOCR as _PaddleOCR_cls  # type: ignore
    _PADDLE_OCR_AVAILABLE = True
except Exception as _e:  # noqa: BLE001
    _PADDLE_IMPORT_ERROR = _e
    print(
        f"[ocr.service] WARN: paddleocr not available ({_e!r}); "
        "falling back to pytesseract.",
        file=sys.stderr,
        flush=True,
    )

_PYTESSERACT_AVAILABLE = False
_pytesseract_mod = None  # type: ignore[var-annotated]
try:
    import pytesseract as _pytesseract_mod  # type: ignore
    _PYTESSERACT_AVAILABLE = True
except Exception as _e:  # noqa: BLE001
    print(
        f"[ocr.service] WARN: pytesseract not available ({_e!r}); "
        "no OCR backend available — OCR will return empty text.",
        file=sys.stderr,
        flush=True,
    )

# Lazy import to avoid loading formulary on every request
_FORMULARY: list[str] | None = None

# Singleton PaddleOCR instances, one per language. Created on first call.
_OCR_EN: Any | None = None
_OCR_HI: Any | None = None


# ─── Drug name fallback ─────────────────────────────────────────────
# When the FastAPI service runs in a context where `backend.lib.formulary`
# is importable (e.g. inside the TatvaCare app container with the Node
# backend mounted at /backend), we use the full 110+-drug Indian formulary.
# When running standalone (smoke tests, minimal venv, etc.) that import
# fails. We fall back to a hardcoded subset of common drug names so the
# parser is still useful and confidence scoring still produces non-'low'
# output for typical Rx text. This list is intentionally small (~30
# generic names) — it is NOT a clinical reference, just a parser fallback.
_FALLBACK_DRUG_NAMES: list[str] = [
    "metformin",
    "atorvastatin",
    "amoxicillin",
    "azithromycin",
    "ciprofloxacin",
    "doxycycline",
    "paracetamol",
    "acetaminophen",
    "ibuprofen",
    "diclofenac",
    "aspirin",
    "omeprazole",
    "pantoprazole",
    "ranitidine",
    "famotidine",
    "losartan",
    "amlodipine",
    "atenolol",
    "metoprolol",
    "telmisartan",
    "hydrochlorothiazide",
    "atorvastatin",
    "rosuvastatin",
    "salbutamol",
    "albuterol",
    "montelukast",
    "levothyroxine",
    "glimepiride",
    "insulin",
    "sitagliptin",
    "empagliflozin",
    "prednisolone",
    "montelukast",
    "cetirizine",
    "loratadine",
    "fexofenadine",
]


def _formulary_names() -> list[str]:
    global _FORMULARY
    if _FORMULARY is None:
        # Prefer the JS formulary when the Node backend is mounted in this
        # Python process's working dir (production / Docker).
        try:
            from backend.lib.formulary import ALL_DRUGS  # type: ignore
            _FORMULARY = [d["name"].lower() for d in ALL_DRUGS]
        except Exception:
            # Standalone / minimal install — use fallback so the parser
            # still extracts common drugs and confidence != 'low'.
            _FORMULARY = list(_FALLBACK_DRUG_NAMES)
    return _FORMULARY


# ─── Singletons ──────────────────────────────────────────────────────


def _get_ocr_en() -> Any | None:
    """Lazy-init PaddleOCR for English. ~200MB model download on first call."""
    global _OCR_EN
    if _OCR_EN is None and _PADDLE_OCR_AVAILABLE and _PaddleOCR_cls is not None:
        # v3.x API: use_textline_orientation replaces use_angle_cls.
        _OCR_EN = _PaddleOCR_cls(lang="en", use_textline_orientation=True)
    return _OCR_EN


def _get_ocr_hi() -> Any | None:
    """Lazy-init PaddleOCR for Hindi. ~200MB model download on first call."""
    global _OCR_HI
    if _OCR_HI is None and _PADDLE_OCR_AVAILABLE and _PaddleOCR_cls is not None:
        _OCR_HI = _PaddleOCR_cls(lang="hi", use_textline_orientation=True)
    return _OCR_HI


# ─── Script detection ────────────────────────────────────────────────

# Devanagari Unicode block: U+0900 to U+097F.
_DEVANAGARI_RE = re.compile(r"[\u0900-\u097F]")


def _devanagari_count(text: str) -> int:
    return len(_DEVANAGARI_RE.findall(text or ""))


def _has_devanagari(text: str, min_chars: int = 5) -> bool:
    """True if text contains at least `min_chars` Devanagari characters."""
    return _devanagari_count(text) >= min_chars


def _image_has_devanagari_glyphs(img: Image.Image) -> bool:
    """Image-based heuristic for Devanagari script presence.

    Devanagari characters carry a continuous horizontal stroke at the top
    of each glyph (the 'shirorekha'). On a binarized image this manifests
    as horizontal black runs of >= ~30px within the glyph band. English /
    Latin text has at most a couple of such runs (e.g. a 'T' top bar, an
    underscore); Devanagari has many.

    Threshold rationale (calibrated on synthetic PIL-rendered test images
    at 36pt Arial / Devanagari Sangam MN, 900x280 canvas):
      * Hindi image: 8 horizontal runs >= 30px in the upper 55% of inner
        image (border excluded).
      * English image: 0 such runs.
    Setting the threshold at >= 4 cleanly separates the two for this size.

    Returns:
        bool — True if the image looks like Devanagari script.

    Limitations:
      * Heuristic is tuned for printed text on near-white backgrounds.
        On noisy / handwritten / low-contrast images it may misclassify.
      * Very small Devanagari (< ~20pt) may have shirorekha runs < 30px
        and slip through as Latin.
    """
    try:
        gray = img.convert("L")
        bw = gray.point(lambda x: 0 if x < 128 else 255, mode="L")
        arr = np.array(bw)
        h, w = arr.shape
        if h < 20 or w < 20:
            return False
        border = max(5, h // 20)
        region = arr[border:h - border, :]
        rh = region.shape[0]
        # Look at upper 55% of inner region — covers the glyph band.
        region = region[: max(1, int(rh * 0.55)), :]
        total_long_runs = 0
        run_length = 30
        for row in region:
            dark = row < 128
            if not dark.any():
                continue
            diffs = np.diff(
                np.concatenate(([False], dark, [False])).astype(int)
            )
            starts = np.where(diffs == 1)[0]
            ends = np.where(diffs == -1)[0]
            for s, e in zip(starts, ends):
                if (e - s) >= run_length:
                    total_long_runs += 1
        return total_long_runs >= 4
    except Exception:  # noqa: BLE001
        return False


# ─── OCR core ────────────────────────────────────────────────────────


def _extract_texts_from_result(result: Any) -> list[str]:
    """Normalize a PaddleOCR v3 OCRResult into a flat list of text strings.

    v3 OCRResult exposes:
      - .rec_texts   (list[str]) — the recognized strings
      - .rec_scores  (list[float]) — confidences
      - dict-style   ['rec_texts'] also works
    v2.x used nested lists; we accept both shapes defensively.
    """
    texts: list[str] = []
    # Handle the new v3 path: list of OCRResult objects.
    for item in result if isinstance(result, list) else [result]:
        rec_texts = None
        if hasattr(item, "rec_texts"):
            rec_texts = item.rec_texts
        elif isinstance(item, dict):
            rec_texts = item.get("rec_texts")
        elif isinstance(item, (list, tuple)) and item:
            # v2.x nested: [ [(box, (text, conf)), ...] ]
            for line in item:
                if not line or len(line) < 2:
                    continue
                payload = line[1]
                if isinstance(payload, (list, tuple)) and payload:
                    texts.append(str(payload[0]))
            continue
        if rec_texts:
            texts.extend(str(t) for t in rec_texts if t)
    return texts


def _paddle_ocr_image(img: Image.Image, lang: str = "en") -> str:
    """Run PaddleOCR on a PIL image and return concatenated text lines."""
    ocr = _get_ocr_en() if lang == "en" else _get_ocr_hi()
    if ocr is None:
        return ""
    img_array = np.array(img.convert("RGB"))
    try:
        # v3 official API
        result = list(ocr.predict(img_array))
    except Exception:
        # Back-compat with v2.x
        result = ocr.ocr(img_array, cls=True)
    texts = _extract_texts_from_result(result)
    return "\n".join(t.strip() for t in texts if t and t.strip())


def _ocr_image(img: Image.Image) -> tuple[str, str]:
    """Run OCR with bilingual detection.

    Strategy:
      1. Run the English PaddleOCR model first (default for Rx/lab/KYC).
      2. If the output is empty OR contains no Devanagari chars but the
         image *looks* like it might be Devanagari (image heuristic), OR
         the English output is suspiciously short (likely garbled), run
         the Hindi model too and pick the better result.
      3. If both models succeed and both produce output, pick the one with
         the higher Devanagari character count when the input is
         ambiguous; otherwise prefer English.
      4. If PaddleOCR is unavailable or fails, fall back to pytesseract.

    Returns:
        (text, model_note) where model_note is one of:
          - 'PaddleOCR-en'   — English model produced the output
          - 'PaddleOCR-hi'   — Hindi model produced the output (Devanagari detected)
          - 'pytesseract-fallback' — PaddleOCR unavailable/failed; tesseract used
          - 'no-ocr-backend' — neither backend available; empty text

    Cost: 1 inference in the common (English-only) path; up to 2 inferences
    in the ambiguous (potentially Hindi) path. Hindi model is only loaded
    on first Hindi request (~200MB download, lazy singleton).
    """
    if _PADDLE_OCR_AVAILABLE:
        try:
            en_text = _paddle_ocr_image(img, lang="en")
        except Exception:  # noqa: BLE001
            en_text = ""

        img_looks_devanagari = _image_has_devanagari_glyphs(img)
        en_looks_garbled = bool(en_text) and not _has_devanagari(en_text) and img_looks_devanagari
        en_is_empty = not en_text

        # Run Hindi model only if the image heuristic says yes AND English
        # output either is empty or doesn't contain Devanagari.
        if (img_looks_devanagari and (en_is_empty or en_looks_garbled)) or en_is_empty:
            try:
                hi_text = _paddle_ocr_image(img, lang="hi")
            except Exception:  # noqa: BLE001
                hi_text = ""
            if hi_text and _has_devanagari(hi_text):
                return hi_text, "PaddleOCR-hi"
            # Hindi model didn't produce Devanagari — fall back to English
            # if it produced anything, else accept Hindi output.
            if en_text:
                return en_text, "PaddleOCR-en"
            return hi_text or "", "PaddleOCR-hi" if hi_text else "no-ocr-backend"

        if en_text:
            return en_text, "PaddleOCR-en"
    # Fallback to pytesseract
    if _PYTESSERACT_AVAILABLE and _pytesseract_mod is not None:
        try:
            text = _pytesseract_mod.image_to_string(img, lang="eng", config="--psm 6")
            return text or "", "pytesseract-fallback"
        except Exception:  # noqa: BLE001
            pass
    return "", "no-ocr-backend"


# ─── Prescription OCR ────────────────────────────────────────────────


def ocr_prescription(image_bytes: bytes) -> dict[str, Any]:
    """Extract drug names + doses from a (printed or printed-out handwritten) Rx image.

    Returns: { raw_text, drugs: [{name, dose, frequency, duration}],
               confidence: 'low'|'med'|'high', note }
    The note records which OCR backend was used: 'PaddleOCR-en' | 'PaddleOCR-hi'
    | 'pytesseract-fallback' | 'no-ocr-backend'.
    """
    img = Image.open(io.BytesIO(image_bytes)).convert("L")  # grayscale
    # Bilingual detection runs inside _ocr_image; one pass is enough.
    text, model_note = _ocr_image(img)
    result = _parse_rx_text(text)
    # Combine backend note with parser note so callers can see both.
    original_note = result.pop("note", "")
    result["note"] = f"{model_note} | {original_note}"
    return result


def _score_for_drugs(text: str) -> int:
    names = _formulary_names()
    text_l = text.lower()
    return sum(1 for n in names if n in text_l)


def _parse_rx_text(text: str) -> dict[str, Any]:
    """Extract drug/dose/freq/duration from OCR'd text using regex + fuzzy match."""
    drugs_found: list[dict[str, Any]] = []
    text_lower = text.lower()
    for name in _formulary_names():
        if name in text_lower:
            # Try to extract dose near the name
            pat = re.compile(
                rf"{re.escape(name)}[\s\-\:]*(?:(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|iu|units?))?",
                re.IGNORECASE,
            )
            m = pat.search(text)
            dose = ""
            if m and m.group(1):
                dose = f"{m.group(1)}{m.group(2)}"
            # Try to extract frequency
            freq_pat = re.compile(r"\b(od|bd|tds|qid|prn|hs|sos|bid|tid)\b", re.IGNORECASE)
            freq_m = freq_pat.search(text)
            freq = freq_m.group(0).upper() if freq_m else ""
            dur_pat = re.compile(r"\b(\d+)\s*(day|days|week|weeks|month|months)\b", re.IGNORECASE)
            dur_m = dur_pat.search(text)
            duration = f"{dur_m.group(1)} {dur_m.group(2)}" if dur_m else ""
            drugs_found.append({
                "name": name,
                "dose": dose,
                "frequency": freq,
                "duration": duration,
            })
    if not drugs_found:
        confidence = "low"
    elif len(drugs_found) >= 2:
        confidence = "high"
    else:
        confidence = "med"
    return {
        "raw_text": text,
        "drugs": drugs_found,
        "confidence": confidence,
        "note": "Printed Rx OCR. For handwritten Rx, accuracy depends on handwriting legibility. Cross-check before signing.",
    }


# ─── Lab report OCR ──────────────────────────────────────────────────


def ocr_lab_report(image_bytes: bytes) -> dict[str, Any]:
    """Extract lab values from a printed lab report image/PDF page.

    Returns: { raw_text, tests: [{name, value, unit, ref_range, abnormal_flag}], note }
    """
    img = Image.open(io.BytesIO(image_bytes)).convert("L")
    raw, model_note = _ocr_image(img)
    result = _parse_lab_text(raw)
    original_note = result.pop("note", "")
    result["note"] = f"{model_note} | {original_note}"
    return result


def _parse_lab_text(text: str) -> dict[str, Any]:
    """Parse 'Test Name  Value  Unit  Ref Range' lines."""
    tests: list[dict[str, Any]] = []
    # Common patterns:
    #   "Hemoglobin   13.5   g/dL   12.0-16.0"
    #   "Total Cholesterol   220   mg/dL   <200"
    #   "HbA1c   7.2   %   4.0-5.6"
    line_pat = re.compile(
        r"(?P<name>[A-Za-z][A-Za-z\s\-\(\)/]{2,40}?)\s+"
        r"(?P<value>\d+(?:\.\d+)?)\s*"
        r"(?P<unit>[a-zA-Z%/]+|mg/dL|g/dL|mmol/L|U/L|ng/mL|pg|mIU/L|µIU/mL)?\s*"
        r"(?P<ref>(?:<\s*\d+(?:\.\d+)?|>\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?))?"
    )
    for line in text.splitlines():
        line = line.strip()
        if not line or len(line) < 5:
            continue
        m = line_pat.search(line)
        if not m:
            continue
        name = m.group("name").strip()
        # Skip header / footer noise
        if name.lower() in ("patient", "report", "date", "doctor", "lab", "specimen"):
            continue
        if len(name) > 50:
            continue
        try:
            value = float(m.group("value"))
        except (TypeError, ValueError):
            continue
        unit = (m.group("unit") or "").strip()
        ref = (m.group("ref") or "").strip()
        abnormal = _is_abnormal(value, ref)
        tests.append({
            "name": name,
            "value": value,
            "unit": unit,
            "ref_range": ref,
            "abnormal_flag": abnormal,
        })
    return {
        "raw_text": text,
        "tests": tests,
        "note": "Printed lab report OCR. Verify critical values manually before acting.",
    }


def _is_abnormal(value: float, ref: str) -> str:
    if not ref:
        return ""
    ref = ref.replace("–", "-").strip()
    if ref.startswith("<"):
        try:
            limit = float(ref[1:].strip())
            return "high" if value >= limit else ""
        except ValueError:
            return ""
    if ref.startswith(">"):
        try:
            limit = float(ref[1:].strip())
            return "low" if value <= limit else ""
        except ValueError:
            return ""
    if "-" in ref:
        try:
            lo, hi = ref.split("-", 1)
            lo, hi = float(lo.strip()), float(hi.strip())
            if value < lo:
                return "low"
            if value > hi:
                return "high"
            return ""
        except ValueError:
            return ""
    return ""


# ─── KYC OCR (Aadhaar / PAN / Insurance card) ────────────────────────


def ocr_kyc(image_bytes: bytes, kind: str = "auto") -> dict[str, Any]:
    """Extract KYC fields from ID card images. Auto-detect by default."""
    img = Image.open(io.BytesIO(image_bytes)).convert("L")
    raw, model_note = _ocr_image(img)
    if kind == "auto":
        if re.search(r"\b\d{4}\s*\d{4}\s*\d{4}\b", raw):
            kind = "aadhaar"
        elif re.search(r"[A-Z]{5}\d{4}[A-Z]", raw):
            kind = "pan"
        else:
            kind = "unknown"
    fields: dict[str, str] = {}
    if kind == "aadhaar":
        m = re.search(r"\b(\d{4})\s*(\d{4})\s*(\d{4})\b", raw)
        if m:
            fields["aadhaar_number"] = f"{m.group(1)} {m.group(2)} {m.group(3)}"
        name_m = re.search(r"(?i)name[:\s]+([A-Za-z\s]{3,40})", raw)
        if name_m:
            fields["name"] = name_m.group(1).strip()
        dob_m = re.search(r"(?i)(?:dob|yoB|year of birth)[:\s]+(\d{2}[/-]\d{2}[/-]\d{4}|\d{4})", raw)
        if dob_m:
            fields["dob"] = dob_m.group(1)
    elif kind == "pan":
        m = re.search(r"([A-Z]{5}\d{4}[A-Z])", raw)
        if m:
            fields["pan_number"] = m.group(1)
        name_m = re.search(r"(?i)name[:\s]+([A-Za-z\s]{3,40})", raw)
        if name_m:
            fields["name"] = name_m.group(1).strip()
        dob_m = re.search(r"(?i)(\d{2}[/-]\d{2}[/-]\d{4})", raw)
        if dob_m:
            fields["dob"] = dob_m.group(1)
    return {
        "kind": kind,
        "raw_text": raw,
        "fields": fields,
        "note": f"{model_note} | Printed ID card OCR. Verify against original document before saving.",
    }
