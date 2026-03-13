from __future__ import annotations

import logging
import os
import time
import traceback
from contextlib import nullcontext
from urllib.error import HTTPError, URLError

from audio_download import download_audio
from observability import audio_url_meta, emit_event
from otel import extract_context_from_traceparent
from worker_config import LOG_TRANSCRIPT, LOG_TRANSCRIPT_MAX_CHARS
from worker_types import TranscriptionJob, TranscriptionResult


class TranscriptionJobProcessor:
    def __init__(
        self,
        *,
        logger: logging.Logger,
        transcriber,
        metrics_publisher,
        download_audio_fn=download_audio,
    ) -> None:
        self.logger = logger
        self.transcriber = transcriber
        self.metrics = metrics_publisher
        self.download_audio = download_audio_fn

    def process(
        self,
        job: TranscriptionJob,
        *,
        queue_depth: int,
        use_batched: bool,
    ) -> TranscriptionResult:
        start_time = time.time()
        error_stage = None
        download_http_status = None
        download_size_bytes = None
        audio_path = None
        queue_wait_ms = self.metrics.compute_queue_wait_ms(job.created_at)

        wide_event = {
            "event": "whisper.transcription",
            "job_id": job.job_id,
            "language": job.language,
            "queue_depth": queue_depth,
            "queue_wait_ms": queue_wait_ms,
            "use_batched": use_batched,
            "multilingual": self.transcriber.multilingual,
            "chunk_length_seconds": self.transcriber.chunk_length_seconds,
            "condition_on_previous_text": self.transcriber.condition_on_previous_text,
            **audio_url_meta(job.audio_url),
        }

        tracer = self._get_tracer()
        parent_ctx = extract_context_from_traceparent(job.traceparent)

        try:
            span_context = (
                tracer.start_as_current_span(
                    "whisper.transcription",
                    context=parent_ctx,
                    attributes={
                        "chalk.job_id": job.job_id,
                        "chalk.queue_depth": queue_depth,
                    },
                )
                if tracer is not None
                else nullcontext()
            )

            with span_context:
                error_stage = "download"
                try:
                    audio_path, download_http_status, download_size_bytes = self._download_audio(
                        job.audio_url,
                        tracer=tracer,
                    )
                except HTTPError as error:
                    download_http_status = error.code
                    download_size_bytes = 0
                    raise
                except URLError:
                    raise

                if download_size_bytes == 0:
                    raise ValueError("downloaded 0 bytes")

                error_stage = "transcribe"
                result = self._transcribe_audio(
                    audio_path,
                    language=job.language,
                    use_batched=use_batched,
                    tracer=tracer,
                )
                result.job_id = job.job_id

            duration_ms = round((time.time() - start_time) * 1000)
            rtf_ratio = self.metrics.compute_rtf_ratio(
                result.processing_time_seconds,
                result.duration_seconds,
            )
            wide_event.update(
                {
                    "outcome": "success",
                    "status": "completed",
                    "duration_ms": duration_ms,
                    "download_http_status": download_http_status,
                    "download_size_bytes": download_size_bytes,
                    "duration_seconds": result.duration_seconds,
                    "word_count": result.word_count,
                    "processing_time_seconds": result.processing_time_seconds,
                    "audio_duration_seconds": result.duration_seconds,
                    "rtf_ratio": rtf_ratio,
                    "inference_mode": self.transcriber.last_inference_mode,
                    "batch_size": self.transcriber.last_batch_size,
                    "oom_retries": self.transcriber.last_oom_retries,
                    "no_speech": self.transcriber.last_no_speech,
                }
            )
            if result.text:
                wide_event["transcript_chars"] = len(result.text)
                if LOG_TRANSCRIPT:
                    max_chars = max(0, LOG_TRANSCRIPT_MAX_CHARS)
                    wide_event["transcript"] = result.text[:max_chars] if max_chars > 0 else ""

            emit_event(self.logger, level=logging.INFO, event=wide_event)
            self.metrics.publish_transcription(
                outcome="completed",
                duration_ms=duration_ms,
                queue_wait_ms=queue_wait_ms,
                download_size_bytes=download_size_bytes,
                processing_time_seconds=result.processing_time_seconds,
                audio_duration_seconds=result.duration_seconds,
                rtf_ratio=rtf_ratio,
            )
            return result
        except Exception as error:
            duration_ms = round((time.time() - start_time) * 1000)
            wide_event.update(
                {
                    "outcome": "error",
                    "status": "failed",
                    "duration_ms": duration_ms,
                    "error": str(error),
                    "error_class": error.__class__.__name__,
                    "error_stage": error_stage,
                    "error_stack": traceback.format_exc(),
                    "download_http_status": download_http_status,
                    "download_size_bytes": download_size_bytes if download_size_bytes is not None else 0,
                    "inference_mode": self.transcriber.last_inference_mode,
                    "batch_size": self.transcriber.last_batch_size,
                    "oom_retries": self.transcriber.last_oom_retries,
                    "no_speech": self.transcriber.last_no_speech,
                }
            )
            emit_event(self.logger, level=logging.ERROR, event=wide_event)
            self.metrics.publish_transcription(
                outcome="failed",
                duration_ms=duration_ms,
                queue_wait_ms=queue_wait_ms,
                download_size_bytes=download_size_bytes,
                processing_time_seconds=None,
                audio_duration_seconds=None,
                rtf_ratio=None,
            )
            return TranscriptionResult(
                job_id=job.job_id,
                status="failed",
                error=str(error),
                error_class=error.__class__.__name__,
                error_stage=error_stage,
                download_http_status=download_http_status,
                download_size_bytes=download_size_bytes if download_size_bytes is not None else 0,
            )
        finally:
            if audio_path and os.path.exists(audio_path):
                os.unlink(audio_path)

    def _download_audio(self, audio_url: str, *, tracer):
        span_context = (
            tracer.start_as_current_span("whisper.download_audio")
            if tracer is not None
            else nullcontext()
        )
        with span_context:
            return self.download_audio(audio_url)

    def _transcribe_audio(self, audio_path: str, *, language: str | None, use_batched: bool, tracer):
        span_context = (
            tracer.start_as_current_span("whisper.transcribe")
            if tracer is not None
            else nullcontext()
        )
        with span_context:
            return self.transcriber.transcribe(
                audio_path,
                language=language,
                use_batched=use_batched,
            )

    @staticmethod
    def _get_tracer():
        try:
            from opentelemetry import trace as ot_trace

            return ot_trace.get_tracer("whisper-worker")
        except Exception:
            return None
