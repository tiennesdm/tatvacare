"""Voice service — Whisper transcription.

Uses openai-whisper with the 'tiny' model by default for CPU speed.
Honest limitation: 'tiny' has higher WER on Indian English + Hindi
medical terms. For clinical-grade transcription, use 'base' or 'small'
with fine-tuning on medical audio. We expose the model choice via env.
"""
from __future__ import annotations
import io
import os
import tempfile
from pathlib import Path
from typing import Any

import whisper

from ..config import WHISPER_MODEL, UPLOADS_DIR

_MODEL = None


def _load_model():
    global _MODEL
    if _MODEL is None:
        _MODEL = whisper.load_model(WHISPER_MODEL)
    return _MODEL


def transcribe_audio(audio_bytes: bytes, language: str = "en") -> dict[str, Any]:
    """Transcribe an audio blob to text + segments + detected language.

    audio_bytes: any format ffmpeg supports (webm, wav, mp3, m4a, ogg).
    """
    model = _load_model()
    # Whisper needs a file path. Write to a temp file.
    suffix = ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=str(UPLOADS_DIR)) as f:
        f.write(audio_bytes)
        tmp_path = f.name
    try:
        result = model.transcribe(tmp_path, language=language, fp16=False, verbose=False)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    return {
        "text": result.get("text", "").strip(),
        "language": result.get("language", language),
        "segments": [
            {"start": s["start"], "end": s["end"], "text": s["text"]}
            for s in result.get("segments", [])
        ],
        "model": WHISPER_MODEL,
        "note": f"Transcribed with Whisper {WHISPER_MODEL}. Clinical-grade accuracy requires fine-tuning on Indian medical audio.",
    }


def live_transcribe_generator(audio_chunks: list[bytes], language: str = "en"):
    """Stub for WebSocket streaming — accumulate audio, return final text.
    Real-time per-chunk streaming would require Whisper streaming extensions.
    """
    audio_bytes = b"".join(audio_chunks)
    return transcribe_audio(audio_bytes, language=language)
