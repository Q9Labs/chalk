from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class TranscriptionJob:
    job_id: str
    audio_url: str
    language: Optional[str] = None
    created_at: Optional[str] = None


@dataclass
class TranscriptionSegment:
    start: float
    end: float
    text: str
    speaker: Optional[str] = None


@dataclass
class TranscriptionResult:
    job_id: str
    status: str  # "completed" or "failed"
    text: Optional[str] = None
    segments: Optional[list] = None
    language: Optional[str] = None
    duration_seconds: Optional[int] = None  # API expects int
    word_count: Optional[int] = None
    processing_time_seconds: Optional[float] = None
    error: Optional[str] = None
    # Diagnostic fields populated on failure (mirrors apps/api whisperJobResult)
    error_class: Optional[str] = None
    error_stage: Optional[str] = None
    download_http_status: Optional[int] = None
    download_size_bytes: Optional[int] = None

