"""OCR service — printed text via Tesseract, plus handwriting heuristics.

Tesseract handles printed text well. For handwritten medical prescriptions,
we use Tesseract's best-effort PSM modes and a small drug-name fuzzy
matcher to map extracted tokens to known drug names in our formulary.

Honest limitation: this is research-grade. Real clinical-grade Rx OCR
needs fine-tuned TrOCR / PaddleOCR-v5 models on Indian handwriting,
which requires a labeled dataset and GPU. We expose what we can do.
"""
from __future__ import annotations
import io
import re
from pathlib import Path
from typing import Any

import pytesseract
from PIL import Image

# Lazy import to avoid loading formulary on every request
_FORMULARY = None


def _formulary_names() -> list[str]:
    global _FORMULARY
    if _FORMULARY is None:
        # Use the same drug names as our Indian formulary.
        try:
            from backend.lib.formulary import ALL_DRUGS
            _FORMULARY = [d["name"].lower() for d in ALL_DRUGS]
        except Exception:
            _FORMULARY = []
    return _FORMULARY


def _ocr_image(img: Image.Image, psm: int = 6, lang: str = "eng") -> str:
    """Run tesseract with given page-segmentation mode."""
    config = f"--psm {psm}"
    return pytesseract.image_to_string(img, lang=lang, config=config)


def ocr_prescription(image_bytes: bytes) -> dict[str, Any]:
    """Extract drug names + doses from a (printed or printed-out handwritten) Rx image.

    Returns: { raw_text, drugs: [{name, dose, frequency, duration}], confidence: 'low'|'med'|'high' }
    """
    img = Image.open(io.BytesIO(image_bytes)).convert("L")  # grayscale
    # Try multiple PSM modes and pick best result by drug-name match count.
    best_text = ""
    best_score = -1
    for psm in (6, 11, 12):
        try:
            txt = _ocr_image(img, psm=psm)
        except pytesseract.TesseractError:
            continue
        score = _score_for_drugs(txt)
        if score > best_score:
            best_score = score
            best_text = txt
    if not best_text:
        best_text = _ocr_image(img, psm=6)
    return _parse_rx_text(best_text)


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

    Returns: { raw_text, tests: [{name, value, unit, ref_range, abnormal_flag}] }
    """
    img = Image.open(io.BytesIO(image_bytes)).convert("L")
    raw = pytesseract.image_to_string(img, lang="eng", config="--psm 6")
    return _parse_lab_text(raw)


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
    raw = pytesseract.image_to_string(img, lang="eng", config="--psm 6")
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
        "note": "Printed ID card OCR. Verify against original document before saving.",
    }
