"""TatvaCare AI service configuration."""
import os
from pathlib import Path

# Repo layout
SERVICE_ROOT = Path(__file__).resolve().parent.parent  # ai/
REPO_ROOT = SERVICE_ROOT.parent  # tatvacare/
MODELS_DIR = SERVICE_ROOT / "models"
DATA_DIR = SERVICE_ROOT / "data"
UPLOADS_DIR = SERVICE_ROOT / "uploads"

for d in (MODELS_DIR, DATA_DIR, UPLOADS_DIR):
    d.mkdir(exist_ok=True)

# Vedadb engine
VBP_HOST = os.environ.get("VEDADB_VBP_HOST", "127.0.0.1")
VBP_PORT = int(os.environ.get("VEDADB_VBP_PORT", "6381"))

# Node backend (for proxy + as fallback)
NODE_BACKEND_URL = os.environ.get("NODE_BACKEND_URL", "http://127.0.0.1:3000")

# LLM
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o-mini")
LOCAL_LLM_MODEL = os.environ.get("LOCAL_LLM_MODEL", "llama3.1")

# Whisper
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "tiny")  # tiny/base/small/medium/large

# Bio_ClinicalBERT
CLINICAL_BERT_MODEL = os.environ.get("CLINICAL_BERT_MODEL", "emilyalsentzer/Bio_ClinicalBERT")

# Service
SERVICE_HOST = os.environ.get("SERVICE_HOST", "0.0.0.0")
SERVICE_PORT = int(os.environ.get("SERVICE_PORT", "7000"))
