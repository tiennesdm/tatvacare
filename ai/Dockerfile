# TatvaCare Python AI service Dockerfile (production).
#
# Multi-stage build that keeps the runtime image small:
#   - builder : full deps (torch is huge) — used only to verify imports compile.
#   - run     : minimal deps + pre-built wheels where possible.
#
# Models are NOT baked into the image — they're downloaded at runtime by the
# application on first use (PaddleOCR ~200MB, Whisper tiny ~75MB, BioBERT
# ~440MB). Pre-training is done via ai/preload.sh on a faster machine.
FROM python:3.11-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential gcc g++ \
    && rm -rf /var/lib/apt/lists/*
COPY ai/requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

FROM python:3.11-slim AS run
# tini for proper SIGTERM forwarding (uvicorn worker is PID 1 otherwise).
# libgomp1 is required by XGBoost; libgl1 + libglib2 are pulled by Pillow
# in the OCR pipeline.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini libgomp1 libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /root/.local /home/app/.local
COPY ai/ ./
ENV PATH=/home/app/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    SERVICE_PORT=7100

# Run as non-root
RUN useradd -m -u 1001 app && chown -R app:app /app
USER app

EXPOSE 7100

# Pre-train heavy ML/DL models in a separate process (XGBoost vs torch
# OpenMP conflict — same machine, two processes — see preload.sh rationale).
# We do NOT run preload here because models are cached; first request to
# /ml/risk etc. will load them. For pre-warmed deploys, override CMD with:
#   ["sh", "-c", "python -m service.ml.risk && python -m service.dl.ecg && uvicorn ..."]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "service.main:app", "--host", "0.0.0.0", "--port", "7100", "--timeout-graceful-shutdown", "15"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7100/health || exit 1
