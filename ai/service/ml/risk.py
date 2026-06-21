"""ML service — risk scoring, anomaly detection, vitals forecasting.

Models:
  - risk: XGBoost binary classifier (readmission/ER risk)
  - anomaly: Isolation Forest (per-patient vitals outlier detection)
  - forecast: Prophet / Naive fallback for vitals time-series

Training data: synthetic for the demo. Real production would use
the engine's patient data with proper labels. We expose `trained_on:
synthetic` in every response so the doctor knows.
"""
from __future__ import annotations
import math
import os
import pickle
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from joblib import dump, load
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

from ..common.db import q, q1
from ..config import DATA_DIR, MODELS_DIR

# ─── Risk model (XGBoost) ───────────────────────────────────────────


def _train_risk_model():
    """Train an XGBoost risk model on synthetic data.

    Honest: real production needs actual labeled outcomes. We use
    a synthetic generation that mimics clinical intuition:
    - High recent HbA1c, BP, comorbidity count, age → higher risk
    - Good adherence, regular follow-ups → lower risk
    """
    import xgboost as xgb
    rng = np.random.default_rng(42)
    n = 2000
    age = rng.normal(55, 15, n).clip(18, 95)
    comorbidity_count = rng.poisson(2, n).clip(0, 8)
    last_hba1c = rng.normal(7.5, 1.8, n).clip(4, 14)
    last_systolic = rng.normal(140, 25, n).clip(80, 220)
    last_diastolic = rng.normal(85, 15, n).clip(50, 130)
    adherence_30d = rng.beta(5, 2, n).clip(0, 1)  # 0-1
    days_since_last_visit = rng.exponential(20, n).clip(0, 365)
    er_visits_6mo = rng.poisson(0.4, n).clip(0, 5)

    # Synthetic risk label: weighted sum + noise
    risk_score = (
        (last_hba1c - 7).clip(0, 8) * 0.4
        + (last_systolic - 140).clip(0, 80) * 0.02
        + (comorbidity_count - 2).clip(0, 6) * 0.3
        + (days_since_last_visit - 30).clip(0, 200) * 0.015
        + er_visits_6mo * 0.4
        - adherence_30d * 1.5
        + rng.normal(0, 0.5, n)
    )
    risk_label = (risk_score > 0.8).astype(int)

    X = np.column_stack([
        age, comorbidity_count, last_hba1c,
        last_systolic, last_diastolic, adherence_30d,
        days_since_last_visit, er_visits_6mo,
    ])
    model = xgb.XGBClassifier(
        n_estimators=80, max_depth=4, learning_rate=0.1,
        random_state=42, use_label_encoder=False, eval_metric="logloss",
        n_jobs=1,  # avoid macOS threadpool issues
    )
    model.fit(X, risk_label)
    path = MODELS_DIR / "risk_xgb.joblib"
    dump({"model": model, "trained_on": "synthetic"}, path)
    return model


def get_risk_model():
    path = MODELS_DIR / "risk_xgb.joblib"
    if not path.exists():
        return _train_risk_model()
    bundle = load(path)
    return bundle["model"]


def predict_risk(patient_id: str) -> dict[str, Any]:
    """Compute risk score for a patient from their engine data."""
    feats = _extract_risk_features(patient_id)
    if not feats:
        return {"error": "insufficient patient data"}
    X = np.array([[feats[k] for k in [
        "age", "comorbidity_count", "last_hba1c",
        "last_systolic", "last_diastolic", "adherence_30d",
        "days_since_last_visit", "er_visits_6mo",
    ]]])
    model = get_risk_model()
    proba = model.predict_proba(X)[0, 1] 
    # Feature importance (proxy)
    importance = model.feature_importances_
    feature_names = [
        "age", "comorbidity_count", "last_hba1c",
        "last_systolic", "last_diastolic", "adherence_30d",
        "days_since_last_visit", "er_visits_6mo",
    ]
    top = sorted(
        zip(feature_names, importance.tolist()),
        key=lambda x: -x[1]
    )[:3]
    return {
        "patient_id": patient_id,
        "risk_score": round(float(proba), 3),
        "risk_band": "high" if proba > 0.7 else ("medium" if proba > 0.4 else "low"),
        "top_factors": [{"feature": f, "importance": round(v, 3)} for f, v in top],
        "features_used": feats,
        "trained_on": "synthetic",
        "note": "Trained on synthetic data. Validate on real outcomes before clinical use.",
    }


def _extract_risk_features(patient_id: str) -> dict[str, float] | None:
    """Pull patient features from engine. If patient has minimal data, fall back to synthetic."""
    pat = q1("SELECT patient_id, date_of_birth FROM patients WHERE patient_id = %s",
            [patient_id], columns=["patient_id", "date_of_birth"])
    if not pat:
        return None
    # Age from DOB
    age = 55.0
    if pat.get("date_of_birth"):
        try:
            dob = datetime.fromisoformat(str(pat["date_of_birth"])[:10])
            age = float((datetime.now() - dob).days / 365.25)
        except ValueError:
            pass
    comorbidity_count = float(len(q(
        "SELECT problem_id FROM patient_problems WHERE patient_id = %s",
        [patient_id], columns=["problem_id"]
    )))
    # Last HbA1c from vitals (column hba1c)
    vitals_hba1c = q(
        "SELECT hba1c as value FROM vitals WHERE patient_id = %s AND hba1c IS NOT NULL ORDER BY recorded_at DESC LIMIT 1",
        [patient_id], columns=["value"]
    )
    last_hba1c = 7.5
    if vitals_hba1c:
        v = vitals_hba1c[0]["value"]
        if v is not None and v != "NULL":
            try:
                last_hba1c = float(v)
            except (TypeError, ValueError):
                last_hba1c = 7.5
    # Last BP — vitals has bp_systolic / bp_diastolic columns
    bp_rows = q(
        "SELECT bp_systolic as value, bp_diastolic as diastolic FROM vitals WHERE patient_id = %s AND bp_systolic IS NOT NULL ORDER BY recorded_at DESC LIMIT 1",
        [patient_id], columns=["value", "diastolic"]
    )
    last_systolic = 140.0
    last_diastolic = 85.0
    if bp_rows:
        s, d = bp_rows[0].get("value"), bp_rows[0].get("diastolic")
        if s is not None and s != "NULL":
            try: last_systolic = float(s)
            except (TypeError, ValueError): pass
        if d is not None and d != "NULL":
            try: last_diastolic = float(d)
            except (TypeError, ValueError): pass
    # Adherence — proxy by recent prescription activity
    rx_rows = q(
        "SELECT COUNT(*) as cnt FROM prescriptions WHERE patient_id = %s AND created_at > current_date - INTERVAL '30 days'",
        [patient_id], columns=["cnt"]
    )
    adherence_30d = min(1.0, float(rx_rows[0]["cnt"]) / 2.0) if rx_rows else 0.5
    # Days since last visit (proxy by last prescription)
    last_rx = q(
        "SELECT created_at FROM prescriptions WHERE patient_id = %s ORDER BY created_at DESC LIMIT 1",
        [patient_id], columns=["created_at"]
    )
    days_since_last_visit = 30.0
    if last_rx and last_rx[0].get("created_at"):
        try:
            ts = str(last_rx[0]["created_at"])[:10]
            last = datetime.fromisoformat(ts)
            days_since_last_visit = float((datetime.now() - last).days)
        except ValueError:
            pass
    # ER visits proxy (no separate table — use 0)
    er_visits_6mo = 0.0
    return {
        "age": age,
        "comorbidity_count": comorbidity_count,
        "last_hba1c": last_hba1c,
        "last_systolic": last_systolic,
        "last_diastolic": last_diastolic,
        "adherence_30d": adherence_30d,
        "days_since_last_visit": days_since_last_visit,
        "er_visits_6mo": er_visits_6mo,
    }


# ─── Anomaly detection (Isolation Forest) ────────────────────────────


def detect_vitals_anomalies(patient_id: str, metric: str = "systolic") -> dict[str, Any]:
    """Detect anomalous vitals readings for a patient using Isolation Forest.

    metric ∈ {'systolic' (alias bp_systolic), 'diastolic', 'pulse', 'hba1c', 'glucose_fasting', 'weight_kg'}
    """
    metric_col = {
        "systolic": "bp_systolic",
        "diastolic": "bp_diastolic",
        "pulse": "pulse",
        "hba1c": "hba1c",
        "glucose": "glucose_fasting",
        "weight": "weight_kg",
    }.get(metric, "bp_systolic")
    rows = q(
        f"SELECT {metric_col} as value, recorded_at FROM vitals WHERE patient_id = %s AND {metric_col} IS NOT NULL ORDER BY recorded_at ASC",
        [patient_id], columns=["value", "recorded_at"]
    )
    if len(rows) < 5:
        return {"anomalies": [], "note": f"Need ≥5 readings for {metric}; have {len(rows)}."}
    values = []
    for r in rows:
        try:
            values.append(float(r["value"]))
        except (TypeError, ValueError):
            values.append(0.0)
    X = np.array(values).reshape(-1, 1)
    clf = IsolationForest(contamination=0.1, random_state=42)
    clf.fit(X)
    preds = clf.predict(X)
    scores = clf.decision_function(X)
    anomalies = []
    for i, (r, pred, sc) in enumerate(zip(rows, preds, scores)):
        if pred == -1:
            anomalies.append({
                "index": i,
                "value": float(r["value"]),
                "recorded_at": r["recorded_at"],
                "anomaly_score": round(float(sc), 3),
            })
    return {
        "patient_id": patient_id,
        "metric": metric,
        "n_readings": len(values),
        "n_anomalies": len(anomalies),
        "anomalies": anomalies[-10:],  # most recent
        "model": "IsolationForest",
        "trained_on": "per-patient-history",
        "note": "Anomaly score < 0 = anomalous. Doctor reviews flagged readings.",
    }


# ─── Vitals forecast (linear / Prophet fallback) ─────────────────────


def forecast_vitals(patient_id: str, metric: str = "systolic",
                     horizon_days: int = 7) -> dict[str, Any]:
    """Forecast next N days of vitals for a patient."""
    metric_col = {
        "systolic": "bp_systolic",
        "diastolic": "bp_diastolic",
        "pulse": "pulse",
        "hba1c": "hba1c",
        "glucose": "glucose_fasting",
        "weight": "weight_kg",
    }.get(metric, "bp_systolic")
    rows = q(
        f"SELECT {metric_col} as value, recorded_at FROM vitals WHERE patient_id = %s AND {metric_col} IS NOT NULL ORDER BY recorded_at ASC",
        [patient_id], columns=["value", "recorded_at"]
    )
    if len(rows) < 3:
        return {"forecast": [], "note": f"Need ≥3 readings; have {len(rows)}."}
    values = []
    dates = []
    for r in rows:
        try:
            v = float(r["value"])
            d = str(r["recorded_at"])[:10]
            values.append(v)
            dates.append(datetime.fromisoformat(d))
        except (TypeError, ValueError):
            continue
    if len(values) < 3:
        return {"forecast": [], "note": "Not enough valid readings."}
    # Linear regression on indices
    x = np.arange(len(values))
    y = np.array(values)
    a, b = np.polyfit(x, y, 1)
    # Residuals std for CI
    residuals = y - (a * x + b)
    sigma = float(np.std(residuals)) if len(residuals) > 1 else 1.0
    # Forecast
    forecast = []
    last_date = dates[-1]
    for i in range(1, horizon_days + 1):
        x_pred = len(values) - 1 + i
        yhat = a * x_pred + b
        forecast.append({
            "date": (last_date + timedelta(days=i)).isoformat()[:10],
            "value": round(float(yhat), 1),
            "lower": round(float(yhat - 1.96 * sigma), 1),
            "upper": round(float(yhat + 1.96 * sigma), 1),
        })
    # Trend direction
    if a > 0.1:
        trend = "rising"
    elif a < -0.1:
        trend = "falling"
    else:
        trend = "stable"
    return {
        "patient_id": patient_id,
        "metric": metric,
        "n_history": len(values),
        "trend": trend,
        "slope_per_reading": round(float(a), 3),
        "forecast": forecast,
        "model": "linear-regression",
        "note": "Linear projection; not clinical-grade. Sufficient for trend visualization.",
    }
