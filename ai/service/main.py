"""TatvaCare Python AI service — FastAPI app on :7000."""
from __future__ import annotations
import io
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import SERVICE_HOST, SERVICE_PORT

# Import XGBoost-using service BEFORE torch (macOS OpenMP conflict avoidance).
# dl.* (torch) imports are LAZY (inside the route handlers) to avoid the
# conflict that crashes xgboost when both are in the same process.
from .ml.risk import predict_risk, get_risk_model
from .ml.anomaly import detect_vitals_anomalies
from .ml.forecast import forecast_vitals

from .ocr.service import ocr_prescription, ocr_lab_report, ocr_kyc
from .nlp.service import extract_entities, suggest_icd10
from .agents.orchestrator import (
    run_agent, recent_activity, AGENTS,
    lab_triage_agent, drug_ix_agent, followup_agent, soap_note_agent, coding_agent,
)
# voice.service imports whisper → torch. Lazy-load inside handlers.
# from .voice.service import transcribe_audio  # LAZY (whisper/torch)

app = FastAPI(
    title="TatvaCare AI Service",
    version="1.0.0",
    description="OCR + NLP + voice + ML + agents + DL for TatvaCare EMR.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def preload_models():
    """Pre-load models at startup.

    Models are pre-trained via preload.sh in a separate Python process
    (XGBoost training hangs in the same process as PyTorch on macOS).
    Here we just verify they're loadable.
    """
    import sys
    print("[startup] connecting to Vedadb...", file=sys.stderr, flush=True)
    try:
        from .common.db import q
        q("SELECT 1 as one", columns=["one"])
        print("[startup] vedadb reachable", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[startup] vedadb FAIL: {e}", file=sys.stderr, flush=True)
    # Note: do NOT preload XGBoost here — it conflicts with PyTorch in the same
    # process. Run ai/preload.sh before starting uvicorn to pre-train all models.
    print("[startup] DONE", file=sys.stderr, flush=True)


# ─── Health ─────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {"status": "ok", "service": "tatvacare-ai", "port": SERVICE_PORT}


# ─── OCR ────────────────────────────────────────────────────────────


@app.post("/ocr/prescription")
async def ocr_prescription_endpoint(file: UploadFile = File(...)):
    """Extract drug names + doses from a prescription image."""
    img_bytes = await file.read()
    return ocr_prescription(img_bytes)


@app.post("/ocr/lab-report")
async def ocr_lab_report_endpoint(file: UploadFile = File(...)):
    """Extract lab values from a lab report image/PDF page."""
    img_bytes = await file.read()
    return ocr_lab_report(img_bytes)


@app.post("/ocr/kyc")
async def ocr_kyc_endpoint(file: UploadFile = File(...), kind: str = Form("auto")):
    """Extract KYC fields from an ID card image."""
    img_bytes = await file.read()
    return ocr_kyc(img_bytes, kind=kind)


# ─── NLP ────────────────────────────────────────────────────────────


class TextRequest(BaseModel):
    text: str
    use_model: bool = False
    top_k: int = 5


@app.post("/nlp/extract-entities")
def nlp_entities(req: TextRequest):
    """Extract symptoms, problems, drugs, vitals from clinical note."""
    return extract_entities(req.text, use_model=req.use_model)


@app.post("/nlp/suggest-icd10")
def nlp_icd10(req: TextRequest):
    """Suggest top-K ICD-10 codes from a clinical note."""
    return {"suggestions": suggest_icd10(req.text, top_k=req.top_k)}


# ─── Voice ──────────────────────────────────────────────────────────


@app.post("/voice/transcribe")
async def voice_transcribe(file: UploadFile = File(...), language: str = Form("en")):
    """Transcribe an audio blob to text."""
    from .voice.service import transcribe_audio  # lazy (whisper/torch)
    audio_bytes = await file.read()
    return transcribe_audio(audio_bytes, language=language)


@app.websocket("/voice/stream")
async def voice_stream(ws: WebSocket):
    """Live dictation over WebSocket (accumulate chunks → final transcript)."""
    await ws.accept()
    audio_chunks: list[bytes] = []
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.receive":
                if "bytes" in msg:
                    audio_chunks.append(msg["bytes"])
                elif "text" in msg:
                    if msg["text"] == "stop":
                        break
            elif msg["type"] == "websocket.disconnect":
                break
        # Final transcription
        from .voice.service import live_transcribe_generator
        if audio_chunks:
            result = live_transcribe_generator(audio_chunks)
            await ws.send_json({"status": "ok", "transcript": result})
        else:
            await ws.send_json({"status": "no_audio"})
    except Exception as e:
        await ws.send_json({"status": "error", "message": str(e)})
    finally:
        await ws.close()


# ─── ML ─────────────────────────────────────────────────────────────


class PatientIdRequest(BaseModel):
    patient_id: str


@app.post("/ml/risk")
def ml_risk(req: PatientIdRequest):
    import traceback
    try:
        return predict_risk(req.patient_id)
    except Exception as e:
        traceback.print_exc()
        return {"error": str(e), "traceback": traceback.format_exc()}


@app.post("/ml/anomaly")
def ml_anomaly(req: PatientIdRequest, metric: str = "systolic"):
    return detect_vitals_anomalies(req.patient_id, metric=metric)


@app.post("/ml/forecast")
def ml_forecast(req: PatientIdRequest, metric: str = "systolic", horizon_days: int = 7):
    return forecast_vitals(req.patient_id, metric=metric, horizon_days=horizon_days)


# ─── Agents ─────────────────────────────────────────────────────────


class AgentRequest(BaseModel):
    agent: str
    patient_id: str | None = None
    new_drugs: list[str] | None = None
    transcript: str | None = None
    test_name: str | None = None
    value: float | None = None
    unit: str | None = None


@app.post("/agents/run")
def agents_run(req: AgentRequest):
    """Run an agent by name with the relevant inputs."""
    kwargs: dict[str, Any] = {}
    if req.patient_id is not None:
        kwargs["patient_id"] = req.patient_id
    if req.new_drugs is not None:
        kwargs["new_drugs"] = req.new_drugs
    if req.transcript is not None:
        kwargs["transcript"] = req.transcript
    if req.test_name is not None:
        kwargs["test_name"] = req.test_name
    if req.value is not None:
        kwargs["value"] = req.value
    if req.unit is not None:
        kwargs["unit"] = req.unit
    return run_agent(req.agent, **kwargs)


@app.get("/agents/list")
def agents_list():
    return {"agents": list(AGENTS.keys())}


@app.get("/agents/activity")
def agents_activity(limit: int = 20):
    return {"activity": recent_activity(limit=limit)}


# ─── DL ─────────────────────────────────────────────────────────────


@app.post("/dl/ecg/classify")
async def dl_ecg(file: UploadFile = File(...)):
    """Classify ECG rhythm from an image (or signal array via JSON)."""
    from .dl.ecg import classify_ecg  # lazy import (torch)
    img_bytes = await file.read()
    return classify_ecg(image_bytes=img_bytes)


class ECGSignalRequest(BaseModel):
    signal: list[float]


@app.post("/dl/ecg/classify-signal")
def dl_ecg_signal(req: ECGSignalRequest):
    from .dl.ecg import classify_ecg  # lazy import (torch)
    return classify_ecg(signal=req.signal)


@app.post("/dl/retinopathy/screen")
async def dl_retinopathy(file: UploadFile = File(...)):
    """Screen a fundus image for diabetic retinopathy grade."""
    from .dl.imaging import classify_retinopathy  # lazy import (torch)
    img_bytes = await file.read()
    return classify_retinopathy(img_bytes)


# ─── Run ────────────────────────────────────────────────────────────


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("service.main:app", host=SERVICE_HOST, port=SERVICE_PORT, reload=False)
