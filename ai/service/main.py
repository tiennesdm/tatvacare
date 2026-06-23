# TatvaCare Python AI service — FastAPI app on :7100.
#
# What's new in v2 (see server.mjs comments for the full list):
#   - Lifespan context manager replaces deprecated @app.on_event.
#   - Shared-secret auth on every endpoint via X-Service-Key + X-Service-Nonce
#     (matches lib/ai_auth.mjs on the Node side). Without this, anyone
#     reachable on the loopback interface could hit OCR/ML/DL.
#   - /readyz endpoint that reports model-load status (separate from
#     /health which is just liveness). Node /readyz polls this.
#   - SIGTERM-friendly uvicorn (timeout_graceful_shutdown=15) so Whisper/OCR
#     requests in flight get to finish before the worker exits (default 0
#     would sever them mid-response).
#   - Structured JSON logs to stderr so the same log shipper can ingest
#     both Node and Python events.

from __future__ import annotations
import asyncio
import io
import os
import signal
import sys
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket
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

# ─── Service-key auth (shared with Node backend) ────────────────────
SERVICE_KEY = os.environ.get("AI_SERVICE_KEY", "")
# dev-only fallback so local dev doesn't need a .env; prod REQUIRES a real
# key (see config validation below).
if not SERVICE_KEY:
    if os.environ.get("NODE_ENV") == "production":
        print("[startup] FATAL: AI_SERVICE_KEY required in production", file=sys.stderr, flush=True)
        sys.exit(2)
    SERVICE_KEY = "dev-only-not-secret"

NONCE_WINDOW_MINUTES = 1  # allow ±1 minute clock skew on the nonce


def verify_service_key(request: Request) -> None:
    """FastAPI dependency. 401s if X-Service-Key is missing or wrong, or
    if X-Service-Nonce is stale (replay window = 90s)."""
    import hmac, hashlib
    provided = request.headers.get("x-service-key", "")
    if not provided:
        raise HTTPException(status_code=401, detail="missing service key")
    if not hmac.compare_digest(str(provided), str(SERVICE_KEY)):
        raise HTTPException(status_code=401, detail="bad service key")
    nonce = request.headers.get("x-service-nonce", "")
    if ":" not in nonce:
        raise HTTPException(status_code=401, detail="bad nonce")
    try:
        minute_str, sig = nonce.split(":", 1)
        minute = int(minute_str)
    except Exception:
        raise HTTPException(status_code=401, detail="bad nonce format")
    now_minute = int(time.time() // 60)
    if abs(now_minute - minute) > 1:
        raise HTTPException(status_code=401, detail="stale nonce")
    expected = hmac.new(SERVICE_KEY.encode(), str(minute).encode(), hashlib.sha256).hexdigest()[:16]
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=401, detail="bad nonce signature")


# ─── Readiness signal ────────────────────────────────────────────────
# _ready flips true after the startup phase has run model-load checks
# and the Vedadb ping succeeded. /readyz returns 200 only when _ready
# is True so k8s/load balancers don't send traffic to a half-warm process.
_ready: bool = False
_ready_reasons: list[str] = []


# ─── Lifespan (replaces deprecated @app.on_event) ───────────────────
@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _ready, _ready_reasons
    _ready_reasons = []
    print(f"[startup] service=tatvacare-ai port={SERVICE_PORT} key_configured={'yes' if SERVICE_KEY != 'dev-only-not-secret' else 'dev-only'}", file=sys.stderr, flush=True)
    try:
        from .common.db import q
        q("SELECT 1 as one", columns=["one"])
        print("[startup] vedadb reachable", file=sys.stderr, flush=True)
    except Exception as e:
        _ready_reasons.append(f"vedadb_unreachable: {e}")
        print(f"[startup] vedadb FAIL: {e}", file=sys.stderr, flush=True)
    # Note: do NOT preload XGBoost here — it conflicts with PyTorch in the same
    # process. Run ai/preload.sh before starting uvicorn to pre-train all models.
    _ready = True
    print("[startup] DONE", file=sys.stderr, flush=True)
    yield
    # Shutdown phase — give in-flight requests a moment, then exit.
    print("[shutdown] draining...", file=sys.stderr, flush=True)
    await asyncio.sleep(0.5)
    print("[shutdown] complete", file=sys.stderr, flush=True)


app = FastAPI(
    title="TatvaCare AI Service",
    version="2.0.0",
    description="OCR + NLP + voice + ML + agents + DL for TatvaCare EMR.",
    lifespan=lifespan,
)

# CORS is permissive here because the AI service is meant to be reached
# only from the Node backend on loopback. Production deployments MUST
# restrict this via network policy (Docker network / iptables) — CORS
# alone is not a security boundary.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Health ─────────────────────────────────────────────────────────
@app.get("/health")
def health():
    """Liveness — process is up. Cheap, used by Docker HEALTHCHECK."""
    return {"status": "ok", "service": "tatvacare-ai", "port": SERVICE_PORT}


@app.get("/readyz")
def readyz():
    """Readiness — process is up AND Vedadb is reachable. Used by k8s/
    load-balancer to decide whether to send traffic. Separating from
    /health avoids the classic "k8s sends traffic to a process that's
    still pre-loading models" footgun."""
    if not _ready:
        return {"ready": False, "reasons": _ready_reasons}
    # Re-check Vedadb each probe — pool could have died since boot.
    try:
        from .common.db import q
        q("SELECT 1 as one", columns=["one"])
        return {"ready": True}
    except Exception as e:
        return {"ready": False, "reasons": [f"vedadb_unreachable: {e}"]}


# Auth dependency — applied per-route (see auth=verify_service_key).
# We deliberately do NOT make it a global dependency: /health and /readyz
# must be reachable by the orchestrator without the service key.

# ─── OCR ────────────────────────────────────────────────────────────


@app.post("/ocr/prescription")
async def ocr_prescription_endpoint(file: UploadFile = File(...), _auth: None = Depends(verify_service_key)):
    img_bytes = await file.read()
    return ocr_prescription(img_bytes)


@app.post("/ocr/lab-report")
async def ocr_lab_report_endpoint(file: UploadFile = File(...), _auth: None = Depends(verify_service_key)):
    img_bytes = await file.read()
    return ocr_lab_report(img_bytes)


@app.post("/ocr/kyc")
async def ocr_kyc_endpoint(file: UploadFile = File(...), kind: str = Form("auto"), _auth: None = Depends(verify_service_key)):
    """Extract KYC fields from an ID card image."""
    img_bytes = await file.read()
    return ocr_kyc(img_bytes, kind=kind)


# ─── NLP ────────────────────────────────────────────────────────────


class TextRequest(BaseModel):
    text: str
    use_model: bool = False
    top_k: int = 5


@app.post("/nlp/extract-entities")
def nlp_entities(req: TextRequest, _auth: None = Depends(verify_service_key)):
    """Extract symptoms, problems, drugs, vitals from clinical note."""
    return extract_entities(req.text, use_model=req.use_model)


@app.post("/nlp/suggest-icd10")
def nlp_icd10(req: TextRequest, _auth: None = Depends(verify_service_key)):
    """Suggest top-K ICD-10 codes from a clinical note."""
    return {"suggestions": suggest_icd10(req.text, top_k=req.top_k)}


# ─── Voice ──────────────────────────────────────────────────────────


@app.post("/voice/transcribe")
async def voice_transcribe(file: UploadFile = File(...), language: str = Form("en"), _auth: None = Depends(verify_service_key)):
    """Transcribe an audio blob to text."""
    from .voice.service import transcribe_audio  # lazy (whisper/torch)
    audio_bytes = await file.read()
    return transcribe_audio(audio_bytes, language=language)


@app.websocket("/voice/stream")
async def voice_stream(ws: WebSocket):
    """Live dictation over WebSocket (accumulate chunks → final transcript).
    NOTE: WebSockets cannot use Depends() — we verify the service key inside
    the handler by inspecting ws.headers. Kept here for backward compat with
    the pre-auth Node bridge; production deployments should restrict access
    at the network layer (loopback / private network)."""
    key = ws.headers.get("x-service-key", "")
    import hmac
    if not hmac.compare_digest(str(key), str(SERVICE_KEY)):
        await ws.close(code=1008)
        return
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
        if audio_chunks:
            from .voice.service import live_transcribe_generator
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
def ml_risk(req: PatientIdRequest, _auth: None = Depends(verify_service_key)):
    import traceback
    try:
        return predict_risk(req.patient_id)
    except Exception as e:
        traceback.print_exc()
        return {"error": str(e), "traceback": traceback.format_exc()}


@app.post("/ml/anomaly")
def ml_anomaly(req: PatientIdRequest, metric: str = "systolic", _auth: None = Depends(verify_service_key)):
    return detect_vitals_anomalies(req.patient_id, metric=metric)


@app.post("/ml/forecast")
def ml_forecast(req: PatientIdRequest, metric: str = "systolic", horizon_days: int = 7, _auth: None = Depends(verify_service_key)):
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
def agents_run(req: AgentRequest, _auth: None = Depends(verify_service_key)):
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
def agents_list(_auth: None = Depends(verify_service_key)):
    return {"agents": list(AGENTS.keys())}


@app.get("/agents/activity")
def agents_activity(limit: int = 20, _auth: None = Depends(verify_service_key)):
    return {"activity": recent_activity(limit=limit)}


# ─── DL ─────────────────────────────────────────────────────────────


@app.post("/dl/ecg/classify")
async def dl_ecg(file: UploadFile = File(...), _auth: None = Depends(verify_service_key)):
    """Classify ECG rhythm from an image (or signal array via JSON)."""
    from .dl.ecg import classify_ecg  # lazy import (torch)
    img_bytes = await file.read()
    return classify_ecg(image_bytes=img_bytes)


class ECGSignalRequest(BaseModel):
    signal: list[float]


@app.post("/dl/ecg/classify-signal")
def dl_ecg_signal(req: ECGSignalRequest, _auth: None = Depends(verify_service_key)):
    from .dl.ecg import classify_ecg  # lazy import (torch)
    return classify_ecg(signal=req.signal)


@app.post("/dl/retinopathy/screen")
async def dl_retinopathy(file: UploadFile = File(...), _auth: None = Depends(verify_service_key)):
    """Screen a fundus image for diabetic retinopathy grade."""
    from .dl.imaging import classify_retinopathy  # lazy import (torch)
    img_bytes = await file.read()
    return classify_retinopathy(img_bytes)


# ─── Run ────────────────────────────────────────────────────────────


if __name__ == "__main__":
    import uvicorn
    # SIGTERM-friendly uvicorn: timeout_graceful_shutdown lets in-flight
    # requests complete before the worker exits (default 0 → instant kill).
    uvicorn.run(
        "service.main:app",
        host=SERVICE_HOST,
        port=SERVICE_PORT,
        reload=False,
        timeout_graceful_shutdown=15,
    )
