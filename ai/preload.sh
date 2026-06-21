#!/usr/bin/env bash
# Pre-train all heavy ML/DL models so uvicorn startup doesn't hang.
set -e
cd "$(dirname "$0")"
source .venv/bin/activate
python -c "
import sys
sys.path.insert(0, '.')
from service.ml.risk import _train_risk_model, get_risk_model
from service.dl.ecg import _load_ecg_model, _load_dr_model
print('Pre-training risk model...', flush=True)
_train_risk_model()
print('Pre-loading risk model...', flush=True)
get_risk_model()
print('Pre-training ECG model...', flush=True)
_load_ecg_model()
print('Pre-training DR model...', flush=True)
_load_dr_model()
print('All models pre-trained. Ready to start uvicorn.', flush=True)
"
