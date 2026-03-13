from __future__ import annotations

import logging
import os
import time
from dataclasses import asdict
from typing import Optional

import numpy as np

from faster_whisper import BatchedInferencePipeline, WhisperModel, decode_audio

from .env_utils import (
    env_bool,
    env_bool_relaxed,
    env_float,
    env_int,
    env_optional_positive_int,
)
from .worker_types import TranscriptionResult, TranscriptionSegment

logger = logging.getLogger("whisper-worker")


def _default_batch_size_max(model_name: str) -> int:
    # T4 16GB: distil models can usually push higher batch sizes than full large-v3.
    if model_name.startswith("distil-"):
        return 16
    return 8


def _looks_like_oom(error: Exception) -> bool:
    msg = str(error).lower()
    if "cuda" in msg and "memory" in msg:
        return True

    markers = (
        "out of memory",
        "mkl_malloc",
        "unable to allocate",
        "cannot allocate memory",
        "memoryerror",
    )
    return any(marker in msg for marker in markers)


def _audio_duration_seconds(audio: np.ndarray, sample_rate: int = 16000) -> int:
    return int(round(audio.shape[0] / sample_rate))


class WhisperTranscriber:
    def __init__(self):
        self.model_name = os.getenv("WHISPER_MODEL", "distil-large-v3.5")
        self.device = os.getenv("WHISPER_DEVICE", "cuda")
        self.compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "float16")
        self.cpu_threads = int(os.getenv("WHISPER_CPU_THREADS", "4"))

        self.beam_size = int(os.getenv("WHISPER_BEAM_SIZE", "5"))
        self.multilingual = env_bool("WHISPER_MULTILINGUAL", True)

        default_chunk_length_seconds = 15 if self.multilingual else None
        chunk_length_set, chunk_length_override = env_optional_positive_int(
            "WHISPER_CHUNK_LENGTH_SECONDS"
        )
        self.chunk_length_seconds = (
            default_chunk_length_seconds
            if not chunk_length_set
            else chunk_length_override
        )

        default_condition_on_prev = not self.multilingual
        self.condition_on_previous_text = env_bool_relaxed(
            "WHISPER_CONDITION_ON_PREVIOUS_TEXT", default_condition_on_prev
        )

        self.language_detection_segments = max(
            1, env_int("WHISPER_LANGUAGE_DETECTION_SEGMENTS", 1)
        )
        self.language_detection_threshold = min(
            1.0, max(0.0, env_float("WHISPER_LANGUAGE_DETECTION_THRESHOLD", 0.5))
        )
        self.no_speech_threshold = min(
            1.0, max(0.0, env_float("WHISPER_NO_SPEECH_THRESHOLD", 0.6))
        )
        self.silence_rms_threshold = max(
            0.0, env_float("WHISPER_SILENCE_RMS_THRESHOLD", 1e-4)
        )
        self.silence_peak_threshold = max(
            0.0, env_float("WHISPER_SILENCE_PEAK_THRESHOLD", 1e-3)
        )

        # Segment-level timestamps are desired; keep timestamps enabled by default.
        self.without_timestamps = env_bool("WHISPER_WITHOUT_TIMESTAMPS", False)

        # VAD tuning for meetings; keep fairly small silence splits for better batching/latency.
        self.vad_filter = env_bool("WHISPER_VAD_FILTER", True)
        self.vad_min_silence_ms = int(os.getenv("WHISPER_VAD_MIN_SILENCE_MS", "500"))

        batch_size_env = os.getenv("WHISPER_BATCH_SIZE_MAX")
        self.batch_size_max = (
            int(batch_size_env)
            if batch_size_env is not None
            else _default_batch_size_max(self.model_name)
        )
        self.batch_size_min = int(os.getenv("WHISPER_BATCH_SIZE_MIN", "1"))
        self.batched_enabled = env_bool(
            "WHISPER_BATCHED_ENABLED", self.device.strip().lower() != "cpu"
        )
        self.batched_min_queue_depth = max(
            1, env_int("WHISPER_BATCHED_MIN_QUEUE_DEPTH", 2)
        )

        self.last_inference_mode: Optional[str] = None
        self.last_batch_size: Optional[int] = None
        self.last_oom_retries = 0
        self.last_no_speech = False

        logger.info(
            "whisper.model_load_start",
            extra={
                "event": "whisper.model_load_start",
                "model": self.model_name,
                "device": self.device,
                "compute_type": self.compute_type,
                "cpu_threads": self.cpu_threads,
                "beam_size": self.beam_size,
                "multilingual": self.multilingual,
                "chunk_length_seconds": self.chunk_length_seconds,
                "condition_on_previous_text": self.condition_on_previous_text,
                "language_detection_segments": self.language_detection_segments,
                "language_detection_threshold": self.language_detection_threshold,
                "no_speech_threshold": self.no_speech_threshold,
                "silence_rms_threshold": self.silence_rms_threshold,
                "silence_peak_threshold": self.silence_peak_threshold,
                "batched_enabled": self.batched_enabled,
                "batched_min_queue_depth": self.batched_min_queue_depth,
            },
        )
        load_start = time.time()
        self.model = WhisperModel(
            self.model_name,
            device=self.device,
            compute_type=self.compute_type,
            cpu_threads=self.cpu_threads,
        )
        self.pipeline = BatchedInferencePipeline(self.model)
        logger.info(
            "whisper.model_load_complete",
            extra={
                "event": "whisper.model_load_complete",
                "model": self.model_name,
                "load_seconds": round(time.time() - load_start, 2),
            },
        )

    def _segments_to_payload(self, segments) -> tuple[list, str]:
        segments_list = []
        full_text_parts = []
        for segment in segments:
            segments_list.append(
                asdict(
                    TranscriptionSegment(
                        start=round(segment.start, 2),
                        end=round(segment.end, 2),
                        text=segment.text.strip(),
                    )
                )
            )
            if segment.text:
                full_text_parts.append(segment.text.strip())

        full_text = " ".join(part for part in full_text_parts if part)
        return segments_list, full_text

    def _empty_result(
        self, *, duration_seconds: int, processing_time_seconds: float
    ) -> TranscriptionResult:
        return TranscriptionResult(
            job_id="",
            status="completed",
            text="",
            segments=[],
            duration_seconds=duration_seconds,
            word_count=0,
            processing_time_seconds=processing_time_seconds,
        )

    def _is_effective_silence(self, audio_path: str) -> tuple[bool, int]:
        audio = decode_audio(audio_path, sampling_rate=16000)
        duration_seconds = _audio_duration_seconds(audio)
        if audio.size == 0:
            return True, duration_seconds

        rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
        peak = float(np.max(np.abs(audio)))
        is_silence = rms <= self.silence_rms_threshold and peak <= self.silence_peak_threshold
        return is_silence, duration_seconds

    def transcribe(
        self,
        audio_path: str,
        *,
        language: Optional[str],
        use_batched: bool,
    ) -> TranscriptionResult:
        start = time.time()

        if use_batched:
            return self._transcribe_batched(audio_path, language=language, start=start)

        return self._transcribe_single(audio_path, language=language, start=start)

    def should_use_batched(self, queued_jobs: int) -> bool:
        if not self.batched_enabled:
            return False
        return queued_jobs >= self.batched_min_queue_depth

    def _transcribe_single(
        self, audio_path: str, *, language: Optional[str], start: float
    ) -> TranscriptionResult:
        self.last_inference_mode = "single"
        self.last_batch_size = None
        self.last_oom_retries = 0
        self.last_no_speech = False
        try:
            segments, info = self.model.transcribe(
                audio_path,
                language=language,
                task="transcribe",
                beam_size=self.beam_size,
                multilingual=self.multilingual,
                vad_filter=self.vad_filter,
                vad_parameters=(
                    {"min_silence_duration_ms": self.vad_min_silence_ms}
                    if self.vad_filter
                    else None
                ),
                without_timestamps=self.without_timestamps,
                word_timestamps=False,
                chunk_length=self.chunk_length_seconds,
                no_speech_threshold=self.no_speech_threshold,
                condition_on_previous_text=self.condition_on_previous_text,
                language_detection_segments=self.language_detection_segments,
                language_detection_threshold=self.language_detection_threshold,
            )

            segments_list, full_text = self._segments_to_payload(segments)
            word_count = len(full_text.split())

            return TranscriptionResult(
                job_id="",
                status="completed",
                text=full_text,
                segments=segments_list,
                language=info.language,
                duration_seconds=int(info.duration),
                word_count=word_count,
                processing_time_seconds=round(time.time() - start, 2),
            )

        except Exception as e:
            # Silent/near-silent recordings should resolve to an empty completed result.
            is_silence, duration_seconds = self._is_effective_silence(audio_path)
            if is_silence:
                self.last_no_speech = True
                return self._empty_result(
                    duration_seconds=duration_seconds,
                    processing_time_seconds=round(time.time() - start, 2),
                )

            raise

    def _transcribe_batched(
        self, audio_path: str, *, language: Optional[str], start: float
    ) -> TranscriptionResult:
        batch_size = max(self.batch_size_min, self.batch_size_max)
        oom_retries = 0
        self.last_inference_mode = "batched"
        self.last_no_speech = False

        while True:
            try:
                segments, info = self.pipeline.transcribe(
                    audio_path,
                    language=language,
                    task="transcribe",
                    beam_size=self.beam_size,
                    multilingual=self.multilingual,
                    vad_filter=self.vad_filter,
                    vad_parameters=(
                        {"min_silence_duration_ms": self.vad_min_silence_ms}
                        if self.vad_filter
                        else None
                    ),
                    without_timestamps=self.without_timestamps,
                    word_timestamps=False,
                    batch_size=batch_size,
                    chunk_length=self.chunk_length_seconds,
                    no_speech_threshold=self.no_speech_threshold,
                    language_detection_segments=self.language_detection_segments,
                    language_detection_threshold=self.language_detection_threshold,
                )

                segments_list, full_text = self._segments_to_payload(segments)
                word_count = len(full_text.split())
                self.last_batch_size = batch_size
                self.last_oom_retries = oom_retries

                return TranscriptionResult(
                    job_id="",
                    status="completed",
                    text=full_text,
                    segments=segments_list,
                    language=info.language,
                    duration_seconds=int(info.duration),
                    word_count=word_count,
                    processing_time_seconds=round(time.time() - start, 2),
                )

            except Exception as e:
                # Silent/near-silent recordings should resolve to an empty completed result.
                is_silence, duration_seconds = self._is_effective_silence(audio_path)
                if is_silence:
                    self.last_no_speech = True
                    self.last_batch_size = batch_size
                    self.last_oom_retries = oom_retries
                    return self._empty_result(
                        duration_seconds=duration_seconds,
                        processing_time_seconds=round(time.time() - start, 2),
                    )

                # OOM guard: step down batch size and retry.
                if not _looks_like_oom(e):
                    raise

                oom_retries += 1
                next_batch_size = batch_size // 2
                if self.batch_size_min <= next_batch_size < batch_size:
                    batch_size = next_batch_size
                    continue

                # If we can't step down further, fall back to single inference to avoid failing the job.
                fallback = self._transcribe_single(
                    audio_path, language=language, start=start
                )
                self.last_inference_mode = "single_fallback"
                self.last_batch_size = batch_size
                self.last_oom_retries = oom_retries
                return fallback
