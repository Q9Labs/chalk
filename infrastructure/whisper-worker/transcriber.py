from __future__ import annotations

import logging
import os
import time
from dataclasses import asdict
from typing import Optional

from faster_whisper import BatchedInferencePipeline, WhisperModel, decode_audio

from worker_types import TranscriptionResult, TranscriptionSegment

logger = logging.getLogger("whisper-worker")


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "t", "yes", "y", "on"}


def _default_batch_size_max(model_name: str) -> int:
    # T4 16GB: distil models can usually push higher batch sizes than full large-v3.
    if model_name.startswith("distil-"):
        return 16
    return 8


class WhisperTranscriber:
    def __init__(self):
        self.model_name = os.getenv("WHISPER_MODEL", "distil-large-v3.5")
        self.device = os.getenv("WHISPER_DEVICE", "cuda")
        self.compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "float16")
        self.cpu_threads = int(os.getenv("WHISPER_CPU_THREADS", "4"))

        self.beam_size = int(os.getenv("WHISPER_BEAM_SIZE", "5"))
        self.multilingual = _env_bool("WHISPER_MULTILINGUAL", True)

        # Segment-level timestamps are desired; keep timestamps enabled by default.
        self.without_timestamps = _env_bool("WHISPER_WITHOUT_TIMESTAMPS", False)

        # VAD tuning for meetings; keep fairly small silence splits for better batching/latency.
        self.vad_filter = _env_bool("WHISPER_VAD_FILTER", True)
        self.vad_min_silence_ms = int(os.getenv("WHISPER_VAD_MIN_SILENCE_MS", "500"))

        batch_size_env = os.getenv("WHISPER_BATCH_SIZE_MAX")
        self.batch_size_max = (
            int(batch_size_env)
            if batch_size_env is not None
            else _default_batch_size_max(self.model_name)
        )
        self.batch_size_min = int(os.getenv("WHISPER_BATCH_SIZE_MIN", "1"))

        logger.info(
            "Loading faster-whisper model: model=%s device=%s compute_type=%s cpu_threads=%d beam_size=%d multilingual=%s",
            self.model_name,
            self.device,
            self.compute_type,
            self.cpu_threads,
            self.beam_size,
            self.multilingual,
        )
        load_start = time.time()
        self.model = WhisperModel(
            self.model_name,
            device=self.device,
            compute_type=self.compute_type,
            cpu_threads=self.cpu_threads,
        )
        self.pipeline = BatchedInferencePipeline(self.model)
        logger.info("Model loaded in %.2fs", time.time() - load_start)

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

    def _transcribe_single(
        self, audio_path: str, *, language: Optional[str], start: float
    ) -> TranscriptionResult:
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
            # v1.2.1 edge-case: silent audio + VAD can yield empty features and crash language detection.
            # Requirement: treat silent/near-silent recordings as completed with empty transcript.
            if "max() arg is an empty sequence" in str(e):
                audio = decode_audio(audio_path, sampling_rate=16000)
                duration_seconds = int(round(audio.shape[0] / 16000))
                logger.info(
                    "No speech detected (treated as empty transcript): duration_seconds=%d",
                    duration_seconds,
                )
                return self._empty_result(
                    duration_seconds=duration_seconds,
                    processing_time_seconds=round(time.time() - start, 2),
                )

            raise

    def _transcribe_batched(
        self, audio_path: str, *, language: Optional[str], start: float
    ) -> TranscriptionResult:
        batch_size = max(self.batch_size_min, self.batch_size_max)

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
                # OOM guard: step down batch size and retry.
                msg = str(e).lower()
                oom = "out of memory" in msg or "cuda" in msg and "memory" in msg
                if not oom:
                    raise

                next_batch_size = batch_size // 2
                if next_batch_size < self.batch_size_min:
                    raise

                logger.warning(
                    "OOM during batched transcription; retrying with smaller batch_size: batch_size=%d next_batch_size=%d",
                    batch_size,
                    next_batch_size,
                )
                batch_size = next_batch_size
