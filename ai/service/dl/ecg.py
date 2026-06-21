"""DL service — ECG arrhythmia + Diabetic retinopathy.

These are intentionally SIMPLE DEMO MODELS trained on synthetic data.
Per the user's "honest not implemented" preference, every response
includes `trained_on: 'synthetic'` and a clinical disclaimer.

For production deployment:
  - ECG: use HuggingFace pre-trained 1D U-Net (Hannun et al.)
  - Retinopathy: use ImageNet-pretrained backbone fine-tuned on Kaggle DR
  - Both need GPU + real labeled datasets
"""
from __future__ import annotations
import io
import os
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from ..config import MODELS_DIR, DATA_DIR

# We use a tiny PyTorch CNN. Built lazily on first call.
import torch
import torch.nn as nn


# ─── ECG arrhythmia classifier ──────────────────────────────────────


class _TinyECG(nn.Module):
    """1D CNN for ECG classification. Demo-grade — 5 rhythm classes."""

    def __init__(self, n_classes: int = 5):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv1d(1, 16, kernel_size=7, stride=2, padding=3),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(16, 32, kernel_size=5, stride=2, padding=2),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(32, 64, kernel_size=3, stride=1, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(8),
            nn.Flatten(),
            nn.Linear(64 * 8, 64),
            nn.ReLU(),
            nn.Linear(64, n_classes),
        )

    def forward(self, x):
        return self.net(x)


_ECG_MODEL = None
_ECG_CLASSES = ["Normal Sinus", "Atrial Fibrillation", "PVC", "Bradycardia", "Tachycardia"]


def _load_ecg_model():
    global _ECG_MODEL
    if _ECG_MODEL is not None:
        return _ECG_MODEL
    path = MODELS_DIR / "ecg_tiny.pt"
    model = _TinyECG(n_classes=len(_ECG_CLASSES))
    if path.exists():
        try:
            model.load_state_dict(torch.load(path, map_location="cpu"))
        except Exception:
            _train_ecg_synthetic(model, path)
    else:
        _train_ecg_synthetic(model, path)
    model.eval()
    _ECG_MODEL = model
    return model


def _train_ecg_synthetic(model: "_TinyECG", path: Path):
    """Train on synthetic ECG-like signals — for demo only.

    Each class gets a distinctive pattern:
      - Normal: regular sinusoidal at ~1.2 Hz
      - AFib: irregular amplitude + slight noise
      - PVC: periodic extra-large spike
      - Brady: low-frequency sinusoidal (~0.6 Hz)
      - Tachy: high-frequency sinusoidal (~2.0 Hz)
    """
    n_per_class = 60
    sr = 125
    duration_s = 10
    n_samples = sr * duration_s
    Xs, ys = [], []
    rng = np.random.default_rng(42)
    for cls_idx in range(len(_ECG_CLASSES)):
        for _ in range(n_per_class):
            t = np.linspace(0, duration_s, n_samples)
            if cls_idx == 0:  # Normal
                sig = np.sin(2 * np.pi * 1.2 * t) + 0.05 * rng.normal(size=n_samples)
            elif cls_idx == 1:  # AFib
                sig = 0.6 * np.sin(2 * np.pi * 1.2 * t) + 0.4 * rng.normal(size=n_samples)
            elif cls_idx == 2:  # PVC
                sig = np.sin(2 * np.pi * 1.2 * t)
                for spike_t in np.arange(0.5, duration_s, 2.0):
                    idx = int(spike_t * sr)
                    if idx + 10 < n_samples:
                        sig[idx:idx + 10] += 2.0
            elif cls_idx == 3:  # Bradycardia
                sig = np.sin(2 * np.pi * 0.6 * t) + 0.05 * rng.normal(size=n_samples)
            else:  # Tachycardia
                sig = np.sin(2 * np.pi * 2.0 * t) + 0.05 * rng.normal(size=n_samples)
            Xs.append(sig.astype(np.float32))
            ys.append(cls_idx)
    X = np.stack(Xs)[:, None, :]  # (N, 1, T)
    y = np.array(ys, dtype=np.int64)
    Xt = torch.from_numpy(X)
    yt = torch.from_numpy(y)
    model.train()
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    crit = nn.CrossEntropyLoss()
    for epoch in range(40):
        perm = torch.randperm(len(Xt))
        for i in range(0, len(Xt), 16):
            idx = perm[i:i + 16]
            xb, yb = Xt[idx], yt[idx]
            opt.zero_grad()
            loss = crit(model(xb), yb)
            loss.backward()
            opt.step()
    model.eval()
    torch.save(model.state_dict(), path)


def classify_ecg(signal: list[float] | None = None,
                 image_bytes: bytes | None = None) -> dict[str, Any]:
    """Classify ECG rhythm.

    Accepts either:
      - signal: a 1D list of floats (10s at 125 Hz = 1250 samples ideally)
      - image_bytes: ECG image (we'll downsample to signal proxy)
    """
    if signal is None and image_bytes is None:
        return {"error": "provide signal: [...] or image_bytes"}
    if signal is None:
        # Convert image → 1D by averaging pixel rows
        img = Image.open(io.BytesIO(image_bytes)).convert("L").resize((1250, 1))
        arr = np.array(img, dtype=np.float32).flatten()
        signal = arr.tolist()
    # Pad/truncate to 1250
    target = 1250
    if len(signal) < target:
        signal = signal + [0.0] * (target - len(signal))
    elif len(signal) > target:
        signal = signal[:target]
    # Normalize
    arr = np.array(signal, dtype=np.float32)
    arr = (arr - arr.mean()) / (arr.std() + 1e-6)
    model = _load_ecg_model()
    with torch.no_grad():
        x = torch.from_numpy(arr[None, None, :])
        logits = model(x)
        probs = torch.softmax(logits, dim=-1)[0].tolist()
    pred = int(np.argmax(probs))
    return {
        "rhythm": _ECG_CLASSES[pred],
        "confidence": round(probs[pred], 3),
        "all_scores": {c: round(p, 3) for c, p in zip(_ECG_CLASSES, probs)},
        "samples_used": target,
        "trained_on": "synthetic",
        "model": "1D-CNN-tiny",
        "note": "Trained on synthetic ECG patterns. NOT for clinical use. Production: use pre-trained 1D U-Net (Hannun et al.) on real PTB-XL / CPSC data.",
    }


# ─── Diabetic retinopathy classifier ────────────────────────────────


class _TinyDR(nn.Module):
    """Tiny 2D CNN for fundus image classification. Demo-grade — 5 DR grades."""

    def __init__(self, n_classes: int = 5):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(3, 8, kernel_size=3, stride=2, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(8, 16, kernel_size=3, stride=2, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(16, 32, kernel_size=3, stride=2, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d(4),
            nn.Flatten(),
            nn.Linear(32 * 16, 32),
            nn.ReLU(),
            nn.Linear(32, n_classes),
        )

    def forward(self, x):
        return self.net(x)


_DR_MODEL = None
_DR_GRADES = [
    {"grade": 0, "label": "No DR", "description": "No diabetic retinopathy"},
    {"grade": 1, "label": "Mild NPDR", "description": "Microaneurysms only"},
    {"grade": 2, "label": "Moderate NPDR", "description": "More than just microaneurysms but less than severe NPDR"},
    {"grade": 3, "label": "Severe NPDR", "description": "Any of: >20 intraretinal hemorrhages, venous beading, IRMA"},
    {"grade": 4, "label": "Proliferative DR", "description": "Neovascularization or vitreous/preretinal hemorrhage"},
]


def _load_dr_model():
    global _DR_MODEL
    if _DR_MODEL is not None:
        return _DR_MODEL
    path = MODELS_DIR / "dr_tiny.pt"
    model = _TinyDR(n_classes=len(_DR_GRADES))
    if path.exists():
        try:
            model.load_state_dict(torch.load(path, map_location="cpu"))
        except Exception:
            _train_dr_synthetic(model, path)
    else:
        _train_dr_synthetic(model, path)
    model.eval()
    _DR_MODEL = model
    return model


def _train_dr_synthetic(model: "_TinyDR", path: Path):
    """Train on synthetic 64x64 fundus-like images. Demo only."""
    n_per_class = 30
    rng = np.random.default_rng(42)
    Xs, ys = [], []
    for grade in range(len(_DR_GRADES)):
        for _ in range(n_per_class):
            # Synthetic "fundus": red-ish disc + spots that increase with grade
            img = np.zeros((64, 64, 3), dtype=np.float32)
            img[..., 0] = 0.5 + 0.2 * rng.normal()  # R
            img[..., 1] = 0.2 + 0.1 * rng.normal()  # G
            img[..., 2] = 0.2 + 0.1 * rng.normal()  # B
            # Central disc
            cy, cx = 32, 32
            yy, xx = np.ogrid[:64, :64]
            disc = (yy - cy) ** 2 + (xx - cx) ** 2 < 100
            img[disc, 0] += 0.3
            # Grade-specific lesions
            n_spots = grade * 5
            for _ in range(n_spots):
                ry, rx = rng.integers(0, 64), rng.integers(0, 64)
                if abs(ry - cy) > 4 or abs(rx - cx) > 4:
                    img[ry, rx, 0] += 0.3
            img = np.clip(img, 0, 1).astype(np.float32)
            Xs.append(img.transpose(2, 0, 1))
            ys.append(grade)
    X = np.stack(Xs)
    y = np.array(ys, dtype=np.int64)
    Xt = torch.from_numpy(X)
    yt = torch.from_numpy(y)
    model.train()
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    crit = nn.CrossEntropyLoss()
    for epoch in range(30):
        perm = torch.randperm(len(Xt))
        for i in range(0, len(Xt), 8):
            idx = perm[i:i + 8]
            xb, yb = Xt[idx], yt[idx]
            opt.zero_grad()
            loss = crit(model(xb), yb)
            loss.backward()
            opt.step()
    model.eval()
    torch.save(model.state_dict(), path)


def classify_retinopathy(image_bytes: bytes) -> dict[str, Any]:
    """Classify diabetic retinopathy grade from a fundus image."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB").resize((64, 64))
    arr = np.array(img, dtype=np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)
    model = _load_dr_model()
    with torch.no_grad():
        x = torch.from_numpy(arr[None, ...])
        logits = model(x)
        probs = torch.softmax(logits, dim=-1)[0].tolist()
    pred = int(np.argmax(probs))
    grade_info = _DR_GRADES[pred]
    recommendation = (
        "Annual follow-up" if pred == 0
        else "Follow-up in 6-12 months" if pred == 1
        else "Refer to ophthalmologist within 3 months" if pred == 2
        else "Urgent ophthalmology referral (within 1 month)" if pred == 3
        else "Urgent ophthalmology referral (within 1 week) — high risk of vision loss"
    )
    return {
        "grade": grade_info["grade"],
        "label": grade_info["label"],
        "description": grade_info["description"],
        "confidence": round(probs[pred], 3),
        "all_scores": {_DR_GRADES[i]["label"]: round(p, 3) for i, p in enumerate(probs)},
        "recommendation": recommendation,
        "trained_on": "synthetic",
        "model": "2D-CNN-tiny",
        "note": "Trained on synthetic fundus images. NOT for clinical screening. Production: fine-tune EfficientNet on Kaggle DR / EyePACS dataset.",
    }
