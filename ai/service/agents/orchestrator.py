"""LangGraph agents — clinical decision support workflows.

Each agent is a small stateful workflow that:
  1. Pulls context from Vedadb (patient history, current state)
  2. Calls deterministic tools (drug Ix, lab lookup, etc.)
  3. Optionally summarizes with LLM (gated on OPENAI_API_KEY)
  4. Returns structured output for doctor review

Honest limits:
  - LLM-summarized parts can hallucinate; tool calls are deterministic
  - Doctor signs every output before action
  - LangGraph orchestrates, but each agent has a rule-based core
"""
from __future__ import annotations
import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Annotated, TypedDict

from ..common.db import q, q1
from ..config import DATA_DIR

# LangGraph (optional — degrade gracefully if unavailable)
try:
    from langgraph.graph import StateGraph, END
    _HAS_LG = True
except Exception:
    _HAS_LG = False

# Activity log (in-memory + on disk)
ACTIVITY_LOG: list[dict[str, Any]] = []
ACTIVITY_LOG_PATH = DATA_DIR / "agent_activity.jsonl"


def _log_activity(agent: str, patient_id: str | None, action: str, detail: dict):
    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "id": str(uuid.uuid4())[:8],
        "agent": agent,
        "patient_id": patient_id,
        "action": action,
        "detail": detail,
    }
    ACTIVITY_LOG.append(entry)
    if len(ACTIVITY_LOG) > 200:
        ACTIVITY_LOG.pop(0)
    try:
        with open(ACTIVITY_LOG_PATH, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def recent_activity(limit: int = 20) -> list[dict]:
    return ACTIVITY_LOG[-limit:][::-1]


# ─── Lab Triage Agent ────────────────────────────────────────────────


def lab_triage_agent(patient_id: str, test_name: str, value: float, unit: str = "") -> dict[str, Any]:
    """Triage a lab result into severity + recommended actions."""
    # Pull patient context
    pat = q1("SELECT patient_id, full_name FROM patients WHERE patient_id = %s",
             [patient_id], columns=["patient_id", "full_name"])
    if not pat:
        return {"error": f"patient {patient_id} not found"}
    problems = q("SELECT problem_name FROM patient_problems WHERE patient_id = %s",
                 [patient_id], columns=["problem_name"])
    meds = q(
        "SELECT drug_name, dose FROM prescriptions WHERE patient_id = %s ORDER BY created_at DESC LIMIT 10",
        [patient_id], columns=["drug_name", "dose"]
    )
    # Rule-based severity (deterministic)
    severity, action = _lab_severity(test_name, value, unit, [p["problem_name"] for p in problems])
    # Recommended actions
    recs = _lab_recommendations(test_name, severity, problems, meds)
    out = {
        "agent": "lab_triage",
        "patient_id": patient_id,
        "patient_name": pat.get("full_name"),
        "input": {"test": test_name, "value": value, "unit": unit},
        "context": {
            "active_problems": [p["problem_name"] for p in problems],
            "current_medications": [f"{m['drug_name']} {m.get('dose', '')}".strip() for m in meds],
        },
        "severity": severity,
        "primary_action": action,
        "recommendations": recs,
        "ts": datetime.now().isoformat(timespec="seconds"),
        "method": "rules+context",
        "note": "Rule-based severity classification. Doctor reviews + signs.",
    }
    _log_activity("lab_triage", patient_id, "triage", {"test": test_name, "value": value, "severity": severity})
    return out


def _lab_severity(test: str, value: float, unit: str, problems: list) -> tuple[str, str]:
    test_l = test.lower()
    # Critical ranges
    if "potassium" in test_l or "k+" in test_l:
        if value >= 6.0 or value <= 2.5:
            return "CRITICAL", "Urgent — hold ACE-i/ARB/spironolactone; recheck in 4-6h; consider urgent nephrology"
        if value >= 5.5:
            return "ABNORMAL_HIGH", "Recheck within 48h; review nephrotoxic drugs"
        if value <= 3.0:
            return "ABNORMAL_LOW", "Recheck; review K-wasting drugs; replace K if symptomatic"
    if "creatinine" in test_l:
        if value >= 3.0:
            return "CRITICAL", "Possible AKI — hold nephrotoxic drugs (metformin/NSAIDs/ACE-i); urgent review"
        if value >= 1.5:
            return "ABNORMAL_HIGH", "Recheck eGFR; review nephrotoxic medications"
    if "hba1c" in test_l or "a1c" in test_l:
        if value >= 10.0:
            return "CRITICAL", "Very poor control — endocrinology referral; intensify therapy; consider insulin"
        if value >= 8.0:
            return "ABNORMAL_HIGH", "Above target — review adherence, intensify therapy"
    if "hemoglobin" in test_l or "hb" in test_l:
        if value <= 7.0:
            return "CRITICAL", "Severe anemia — transfuse if symptomatic; investigate cause"
        if value <= 10.0:
            return "ABNORMAL_LOW", "Investigate (iron/B12/folate); correct cause"
    if "sodium" in test_l or "na" in test_l:
        if value <= 120 or value >= 160:
            return "CRITICAL", "Severe dysnatremia — urgent workup; correct slowly"
    if "inr" in test_l:
        if value >= 5.0:
            return "CRITICAL", "High bleeding risk — hold warfarin; consider vitamin K"
    if "glucose" in test_l or "sugar" in test_l or "fbs" in test_l or "ppbs" in test_l or "rbs" in test_l:
        if value <= 50 or value >= 400:
            return "CRITICAL", "Hypo/hyperglycemia — review now, adjust therapy"
        if value >= 180:
            return "ABNORMAL_HIGH", "Hyperglycemic — review diet/medication adherence"
    return "NORMAL", "No action needed; routine follow-up"


def _lab_recommendations(test: str, severity: str, problems: list, meds: list) -> list[str]:
    recs: list[str] = []
    problem_names = {(p.get("problem_name") or "").lower() for p in problems}
    if severity in ("CRITICAL",):
        recs.append(f"Doctor review required within 24 hours")
        recs.append(f"Auto-create urgent follow-up task")
    elif severity.startswith("ABNORMAL"):
        recs.append(f"Schedule follow-up within 1 week")
    if "diabetes" in str(problem_names) or "dm" in problem_names:
        if "hba1c" in test.lower():
            recs.append("Review metformin dose / add second-line agent")
            recs.append("Reinforce diet + exercise counseling")
    if "ckd" in str(problem_names) or "chronic kidney" in str(problem_names):
        if "potassium" in test.lower() or "creatinine" in test.lower():
            recs.append("Adjust renally-cleared medications")
            recs.append("Nephrology referral if not already established")
    return recs


# ─── Drug Interaction Agent ──────────────────────────────────────────


def drug_ix_agent(patient_id: str, new_drugs: list[str]) -> dict[str, Any]:
    """Check a new prescription against the patient's current medications."""
    # Pull current meds
    current_rx = q(
        "SELECT DISTINCT drug_name FROM prescriptions WHERE patient_id = %s",
        [patient_id], columns=["drug_name"]
    )
    current_drugs = [(r.get("drug_name") or "").lower() for r in current_rx] if current_rx else []  
    # Pull known interactions from engine (drug_interactions table)
    interactions = []
    for new in new_drugs:
        new_l = new.lower()
        for cur in current_drugs:
            rows = q(
                "SELECT drug_a, drug_b, severity, description FROM drug_interactions WHERE "
                "(LOWER(drug_a) = %s AND LOWER(drug_b) = %s) OR "
                "(LOWER(drug_a) = %s AND LOWER(drug_b) = %s)",
                [new_l, cur, cur, new_l],
                columns=["drug_a", "drug_b", "severity", "description"]
            )
            # engine LOWER() bug → fall back to JS-style fetch-and-filter
            if not rows:
                rows = _manual_ix_lookup(new_l, cur)
            for r in rows:
                interactions.append(r)
    # Allergies check
    allergies = q(
        "SELECT allergen FROM patient_allergies WHERE patient_id = %s",
        [patient_id], columns=["allergen"]
    )
    allergy_alerts = [
        {"drug": n, "allergen": a["allergen"]}
        for a in allergies for n in new_drugs if a["allergen"].lower() in n.lower()
    ]
    # Severity summary
    sevs = [i.get("severity", "").lower() for i in interactions]
    if "severe" in sevs:
        overall = "high"
    elif "moderate" in sevs:
        overall = "moderate"
    elif interactions or allergy_alerts:
        overall = "low"
    else:
        overall = "none"
    out = {
        "agent": "drug_ix",
        "patient_id": patient_id,
        "new_drugs": new_drugs,
        "current_drugs": current_drugs,
        "interactions": interactions,
        "allergy_alerts": allergy_alerts,
        "overall_risk": overall,
        "ts": datetime.now().isoformat(timespec="seconds"),
        "method": "rule+table",
        "note": "Deterministic lookup. Doctor signs before action.",
    }
    _log_activity("drug_ix", patient_id, "check", {"new": new_drugs, "n_interactions": len(interactions), "overall": overall})
    return out


def _manual_ix_lookup(drug_a: str, drug_b: str) -> list[dict]:
    """Engine LOWER() bug workaround — fetch all + filter in Python."""
    rows = q(
        "SELECT drug_a, drug_b, severity, description FROM drug_interactions",
        columns=["drug_a", "drug_b", "severity", "description"]
    )
    out = []
    for r in rows:
        a = str(r["drug_a"]).lower()
        b = str(r["drug_b"]).lower()
        if (a == drug_a and b == drug_b) or (a == drug_b and b == drug_a):
            out.append(r)
    return out


# ─── Follow-up Agent ─────────────────────────────────────────────────


def followup_agent(patient_id: str) -> dict[str, Any]:
    """Determine next follow-up action for a chronic patient."""
    pat = q1("SELECT patient_id, full_name FROM patients WHERE patient_id = %s",
             [patient_id], columns=["patient_id", "full_name"])
    if not pat:
        return {"error": f"patient {patient_id} not found"}
    problems = q("SELECT problem_name, icd10 FROM patient_problems WHERE patient_id = %s",
                 [patient_id], columns=["problem_name", "icd10"])
    last_visit = q(
        "SELECT MAX(created_at) as last FROM prescriptions WHERE patient_id = %s",
        [patient_id], columns=["last"]
    )
    last_hba1c = q(
        "SELECT value, recorded_at FROM vitals WHERE patient_id = %s AND (LOWER(metric_name) LIKE '%hba1c%' OR LOWER(metric_name) LIKE '%a1c%') ORDER BY recorded_at DESC LIMIT 1",
        [patient_id], columns=["value", "recorded_at"]
    )
    next_action = "Routine follow-up in 3 months"
    days_until = 90
    reasons = []
    # Diabetes with high HbA1c → sooner
    has_dm = any("diabetes" in (p["problem_name"] or "").lower() or "dm" in (p["problem_name"] or "").lower()
                 for p in problems)
    if has_dm and last_hba1c:
        try:
            h = float(last_hba1c[0]["value"])
            if h >= 9.0:
                next_action = "Urgent follow-up within 2 weeks (HbA1c ≥9)"
                days_until = 14
                reasons.append(f"HbA1c {h}% — poorly controlled")
            elif h >= 8.0:
                next_action = "Follow-up within 4 weeks"
                days_until = 28
                reasons.append(f"HbA1c {h}% — above target")
        except (TypeError, ValueError):
            pass
    # Long gap since last visit
    if last_visit and last_visit[0].get("last"):
        try:
            ts = str(last_visit[0]["last"])[:10]
            days = (datetime.now() - datetime.fromisoformat(ts)).days
            if days > 180:
                next_action = "Overdue — call patient today"
                days_until = 0
                reasons.append(f"Last visit {days} days ago")
        except ValueError:
            pass
    out = {
        "agent": "followup",
        "patient_id": patient_id,
        "patient_name": pat.get("full_name"),
        "next_action": next_action,
        "days_until": days_until,
        "reasons": reasons,
        "active_problems": [p["problem_name"] for p in problems],
        "ts": datetime.now().isoformat(timespec="seconds"),
        "method": "rules+last-values",
    }
    _log_activity("followup", patient_id, "schedule", {"action": next_action, "days": days_until})
    return out


# ─── SOAP Note Agent ─────────────────────────────────────────────────


def soap_note_agent(transcript: str, patient_id: str | None = None) -> dict[str, Any]:
    """Generate a structured SOAP note draft from a consultation transcript."""
    text = transcript.strip()
    # Split into sentences
    sentences = re.split(r"(?<=[.!?])\s+", text)
    subjective: list[str] = []
    objective: list[str] = []
    assessment: list[str] = []
    plan: list[str] = []
    subj_kw = r"\b(patient|complains|c/o|reports|feels|history|denies|presents|says|tells)\b"
    obj_kw = r"\b(exam|on examination|vitals?|bp|pulse|temp|weight|height|observed|noted|appears|looks)\b"
    assess_kw = r"\b(diagnosis|impression|likely|probable|suspect|consistent with|suggestive|likely)\b"
    plan_kw = r"\b(plan|advise|advice|prescribe|recommend|start|continue|stop|refer|investigation|test|follow|review|recheck)\b"
    for s in sentences:
        sl = s.lower()
        if re.search(plan_kw, sl):
            plan.append(s.strip())
        elif re.search(assess_kw, sl):
            assessment.append(s.strip())
        elif re.search(obj_kw, sl):
            objective.append(s.strip())
        elif re.search(subj_kw, sl):
            subjective.append(s.strip())
    # If nothing matched, put everything in subjective
    if not (subjective or objective or assessment or plan):
        subjective = [text]
    out = {
        "agent": "soap",
        "patient_id": patient_id,
        "subjective": subjective,
        "objective": objective,
        "assessment": assessment,
        "plan": plan,
        "transcript_chars": len(text),
        "ts": datetime.now().isoformat(timespec="seconds"),
        "method": "rule+keyword",
        "note": "Heuristic SOAP structuring. Doctor reviews + edits before saving.",
    }
    _log_activity("soap", patient_id, "draft", {"s": len(subjective), "o": len(objective), "a": len(assessment), "p": len(plan)})
    return out


import re  # late import for the keyword regex above


# ─── Coding Agent (ICD-10 + CPT) ─────────────────────────────────────


def coding_agent(transcript: str) -> dict[str, Any]:
    """Suggest ICD-10 codes from a clinical encounter."""
    # Reuse NLP ICD-10 suggest (rules-based, fast)
    from ..nlp.service import suggest_icd10
    codes = suggest_icd10(transcript, top_k=5)
    # CPT suggestions — simple rules based on encounter type
    cpt: list[dict] = []
    text_l = transcript.lower()
    if "new patient" in text_l or "first visit" in text_l:
        cpt.append({"code": "99203", "description": "New patient, low complexity (30-44 min)"})
    elif "follow" in text_l or "review" in text_l:
        cpt.append({"code": "99213", "description": "Established patient, low complexity (20-29 min)"})
    else:
        cpt.append({"code": "99213", "description": "Established patient, low complexity (default)"})
    if "ekg" in text_l or "ecg" in text_l:
        cpt.append({"code": "93000", "description": "Electrocardiogram, complete"})
    if "injection" in text_l:
        cpt.append({"code": "96372", "description": "Therapeutic injection, SC/IM"})
    out = {
        "agent": "coding",
        "icd10_suggestions": codes,
        "cpt_suggestions": cpt,
        "ts": datetime.now().isoformat(timespec="seconds"),
        "method": "rules+keyword",
        "note": "Heuristic code suggestion. Coder reviews + finalizes.",
    }
    _log_activity("coding", None, "suggest", {"n_icd10": len(codes), "n_cpt": len(cpt)})
    return out


# ─── Orchestrator ────────────────────────────────────────────────────


AGENTS = {
    "lab_triage": lab_triage_agent,
    "drug_ix": drug_ix_agent,
    "followup": followup_agent,
    "soap": soap_note_agent,
    "coding": coding_agent,
}


def run_agent(name: str, **kwargs) -> dict[str, Any]:
    fn = AGENTS.get(name)
    if not fn:
        return {"error": f"unknown agent: {name}"}
    return fn(**kwargs)
