#!/usr/bin/env python3
"""
Whisper Transcription Worker

Polls Redis queue `transcription:jobs`, transcribes via faster-whisper, stores result at
`transcription:result:{job_id}` (TTL 24h).

Failure payload includes diagnostic fields (`error_stage`, `error_class`,
`download_http_status`, `download_size_bytes`) consumed by apps/api.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Optional
from urllib.error import HTTPError, URLError

import boto3
import redis
from audio_download import download_audio
from observability import audio_url_meta, emit_event, setup_axiom_logging
from otel import extract_context_from_traceparent, init_tracing
from transcriber import WhisperTranscriber
from worker_config import (
    JOB_QUEUE,
    LOG_LEVEL,
    LOG_TRANSCRIPT,
    LOG_TRANSCRIPT_MAX_CHARS,
    POLL_TIMEOUT_SECONDS,
    PROCESSING_QUEUE,
    REDIS_CONNECT_TIMEOUT,
    REDIS_HEALTHCHECK_INTERVAL,
    REDIS_RETRY_ON_TIMEOUT,
    REDIS_SOCKET_TIMEOUT,
    REDIS_URL,
    RESULT_KEY_PREFIX,
    RESULT_TTL_SECONDS,
)
from worker_types import TranscriptionJob, TranscriptionResult

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("/var/log/whisper-worker.log"),
    ],
)
logger = logging.getLogger("whisper-worker")

setup_axiom_logging(log_level=LOG_LEVEL)
init_tracing(service_name="whisper-worker", env=os.getenv("ENVIRONMENT", "dev"))

class WhisperWorker:
    def __init__(self) -> None:
        self.redis = redis.from_url(
            REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=REDIS_CONNECT_TIMEOUT,
            socket_timeout=REDIS_SOCKET_TIMEOUT,
            retry_on_timeout=REDIS_RETRY_ON_TIMEOUT,
            health_check_interval=REDIS_HEALTHCHECK_INTERVAL,
        )
        self.transcriber = WhisperTranscriber()
        self.metric_namespace = os.getenv("WHISPER_METRIC_NAMESPACE", "Chalk/Whisper")
        self.cloudwatch = boto3.client("cloudwatch", region_name=os.getenv("AWS_REGION") or None)

    def _compute_queue_wait_ms(self, created_at: Optional[str]) -> Optional[int]:
        if not created_at:
            return None

        try:
            created_at_dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            wait_ms = (datetime.now(timezone.utc) - created_at_dt).total_seconds() * 1000
            return max(0, round(wait_ms))
        except Exception:
            return None

    def publish_transcription_metrics(
        self,
        *,
        outcome: str,
        duration_ms: int,
        queue_wait_ms: Optional[int],
        download_size_bytes: Optional[int],
        processing_time_seconds: Optional[float],
    ) -> None:
        try:
            environment = os.getenv("ENVIRONMENT", "dev")
            metric_data = [
                {
                    "MetricName": "TranscriptionsTotal",
                    "Dimensions": [{"Name": "Environment", "Value": environment}],
                    "Timestamp": datetime.now(timezone.utc),
                    "Unit": "Count",
                    "Value": 1,
                },
                {
                    "MetricName": "TranscriptionDurationMs",
                    "Dimensions": [{"Name": "Environment", "Value": environment}],
                    "Timestamp": datetime.now(timezone.utc),
                    "Unit": "Milliseconds",
                    "Value": duration_ms,
                },
            ]

            if outcome == "completed":
                metric_data.append(
                    {
                        "MetricName": "TranscriptionsCompleted",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Count",
                        "Value": 1,
                    }
                )
            else:
                metric_data.append(
                    {
                        "MetricName": "TranscriptionsFailed",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Count",
                        "Value": 1,
                    }
                )

            if queue_wait_ms is not None:
                metric_data.append(
                    {
                        "MetricName": "QueueWaitMs",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Milliseconds",
                        "Value": queue_wait_ms,
                    }
                )

            if processing_time_seconds is not None:
                metric_data.append(
                    {
                        "MetricName": "ProcessingTimeSeconds",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Seconds",
                        "Value": processing_time_seconds,
                    }
                )

            if download_size_bytes is not None and download_size_bytes > 0:
                metric_data.append(
                    {
                        "MetricName": "DownloadSizeBytes",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Bytes",
                        "Value": download_size_bytes,
                    }
                )

            self.cloudwatch.put_metric_data(
                Namespace=self.metric_namespace,
                MetricData=metric_data,
            )
        except Exception as e:
            emit_event(
                logger,
                level=logging.WARNING,
                event={
                    "event": "metrics.transcription_publish_failed",
                    "error": str(e),
                    "error_class": e.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )

    def process_job(
        self,
        job: TranscriptionJob,
        *,
        queue_depth: int,
        use_batched: bool,
    ) -> TranscriptionResult:
        start_time = time.time()
        error_stage: Optional[str] = None
        download_http_status: Optional[int] = None
        download_size_bytes: Optional[int] = None
        audio_path: Optional[str] = None
        queue_wait_ms = self._compute_queue_wait_ms(job.created_at)

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

        parent_ctx = extract_context_from_traceparent(job.traceparent)

        try:
            from opentelemetry import trace as ot_trace

            tracer = ot_trace.get_tracer("whisper-worker")
        except Exception:
            tracer = None

        try:
            if tracer is not None:
                with tracer.start_as_current_span(
                    "whisper.transcription",
                    context=parent_ctx,
                    attributes={
                        "chalk.job_id": job.job_id,
                        "chalk.queue_depth": queue_depth,
                    },
                ):
                    error_stage = "download"
                    try:
                        with tracer.start_as_current_span("whisper.download_audio"):
                            audio_path, download_http_status, download_size_bytes = download_audio(
                                job.audio_url
                            )
                    except HTTPError as e:
                        download_http_status = e.code
                        download_size_bytes = 0
                        raise
                    except URLError:
                        raise

                    if download_size_bytes == 0:
                        raise ValueError("downloaded 0 bytes")

                    error_stage = "transcribe"
                    with tracer.start_as_current_span("whisper.transcribe"):
                        result = self.transcriber.transcribe(
                            audio_path,
                            language=job.language,
                            use_batched=use_batched,
                        )
                    result.job_id = job.job_id
            else:
                error_stage = "download"
                try:
                    audio_path, download_http_status, download_size_bytes = download_audio(
                        job.audio_url
                    )
                except HTTPError as e:
                    download_http_status = e.code
                    download_size_bytes = 0
                    raise
                except URLError:
                    raise

                if download_size_bytes == 0:
                    raise ValueError("downloaded 0 bytes")

                error_stage = "transcribe"
                result = self.transcriber.transcribe(
                    audio_path,
                    language=job.language,
                    use_batched=use_batched,
                )
                result.job_id = job.job_id

            wide_event.update(
                {
                    "outcome": "success",
                    "status": "completed",
                    "duration_ms": round((time.time() - start_time) * 1000),
                    "download_http_status": download_http_status,
                    "download_size_bytes": download_size_bytes,
                    "duration_seconds": result.duration_seconds,
                    "word_count": result.word_count,
                    "processing_time_seconds": result.processing_time_seconds,
                    "inference_mode": self.transcriber.last_inference_mode,
                    "batch_size": self.transcriber.last_batch_size,
                    "oom_retries": self.transcriber.last_oom_retries,
                    "no_speech": self.transcriber.last_no_speech,
                }
            )
            if result.text:
                wide_event["transcript_chars"] = len(result.text)
            emit_event(logger, level=logging.INFO, event=wide_event)
            self.publish_transcription_metrics(
                outcome="completed",
                duration_ms=wide_event["duration_ms"],
                queue_wait_ms=queue_wait_ms,
                download_size_bytes=download_size_bytes,
                processing_time_seconds=result.processing_time_seconds,
            )
            return result

        except Exception as e:
            wide_event.update(
                {
                    "outcome": "error",
                    "status": "failed",
                    "duration_ms": round((time.time() - start_time) * 1000),
                    "error": str(e),
                    "error_class": e.__class__.__name__,
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
            emit_event(logger, level=logging.ERROR, event=wide_event)
            self.publish_transcription_metrics(
                outcome="failed",
                duration_ms=wide_event["duration_ms"],
                queue_wait_ms=queue_wait_ms,
                download_size_bytes=download_size_bytes,
                processing_time_seconds=None,
            )
            return TranscriptionResult(
                job_id=job.job_id,
                status="failed",
                error=str(e),
                error_class=e.__class__.__name__,
                error_stage=error_stage,
                download_http_status=download_http_status,
                download_size_bytes=download_size_bytes if download_size_bytes is not None else 0,
            )

        finally:
            if audio_path and os.path.exists(audio_path):
                os.unlink(audio_path)

    def store_result(self, result: TranscriptionResult) -> None:
        key = f"{RESULT_KEY_PREFIX}{result.job_id}"
        result_dict = asdict(result)
        result_dict = {k: v for k, v in result_dict.items() if v is not None}
        self.redis.setex(key, RESULT_TTL_SECONDS, json.dumps(result_dict))

    def publish_queue_metrics(self) -> None:
        try:
            # IMPORTANT: with BRPOPLPUSH, in-flight work moves from JOB_QUEUE -> PROCESSING_QUEUE.
            # Autoscaling and monitoring must consider both or we'll under-report load and scale down too aggressively.
            job_queue_depth = self.redis.llen(JOB_QUEUE)
            processing_queue_depth = self.redis.llen(PROCESSING_QUEUE)
            queue_depth = job_queue_depth + processing_queue_depth
            environment = os.getenv("ENVIRONMENT", "dev")
            self.cloudwatch.put_metric_data(
                Namespace=self.metric_namespace,
                MetricData=[
                    {
                        "MetricName": "TranscriptionQueueDepth",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Count",
                        "Value": queue_depth,
                    },
                    {
                        "MetricName": "TranscriptionJobQueueDepth",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Count",
                        "Value": job_queue_depth,
                    },
                    {
                        "MetricName": "TranscriptionProcessingQueueDepth",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Count",
                        "Value": processing_queue_depth,
                    },
                ],
            )
            emit_event(
                logger,
                level=logging.INFO,
                event={
                    "event": "whisper.queue_depth",
                    "queue_depth": queue_depth,
                    "job_queue_depth": job_queue_depth,
                    "processing_queue_depth": processing_queue_depth,
                },
            )
        except Exception as e:
            emit_event(
                logger,
                level=logging.WARNING,
                event={
                    "event": "metrics.publish_failed",
                    "error": str(e),
                    "error_class": e.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )

    def requeue_processing_jobs(self) -> None:
        # If the instance/container dies mid-job (common with Spot),
        # we must requeue items left in the processing list so they're not lost.
        moved = 0
        try:
            while True:
                job_data = self.redis.rpoplpush(PROCESSING_QUEUE, JOB_QUEUE)
                if job_data is None:
                    break
                moved += 1
        except Exception as e:
            emit_event(
                logger,
                level=logging.WARNING,
                event={
                    "event": "queue.requeue_processing_failed",
                    "moved": moved,
                    "error": str(e),
                    "error_class": e.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )
            return

        if moved > 0:
            emit_event(
                logger,
                level=logging.INFO,
                event={"event": "queue.requeue_processing_done", "moved": moved},
            )

    def ack_processing_job(self, job_data: str) -> None:
        try:
            self.redis.lrem(PROCESSING_QUEUE, 1, job_data)
        except Exception as e:
            emit_event(
                logger,
                level=logging.WARNING,
                event={
                    "event": "queue.ack_failed",
                    "error": str(e),
                    "error_class": e.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )

    def run(self) -> None:
        emit_event(logger, level=logging.INFO, event={"event": "worker.start"})
        last_metric_time = 0.0
        self.requeue_processing_jobs()

        while True:
            try:
                now = time.time()
                if now - last_metric_time >= 60:
                    self.publish_queue_metrics()
                    last_metric_time = now

                job_data = self.redis.brpoplpush(
                    JOB_QUEUE,
                    PROCESSING_QUEUE,
                    timeout=POLL_TIMEOUT_SECONDS,
                )
                if job_data is None:
                    continue

                try:
                    job_dict = json.loads(job_data)
                    job = TranscriptionJob(**job_dict)
                except (json.JSONDecodeError, TypeError) as e:
                    emit_event(
                        logger,
                        level=logging.ERROR,
                        event={
                            "event": "queue.invalid_job",
                            "error": str(e),
                            "error_class": e.__class__.__name__,
                            "error_stack": traceback.format_exc(),
                        },
                    )
                    self.ack_processing_job(job_data)
                    continue

                remaining = self.redis.llen(JOB_QUEUE)
                use_batched = remaining >= 1

                try:
                    transcription_result = self.process_job(
                        job,
                        queue_depth=remaining + 1,
                        use_batched=use_batched,
                    )
                    self.store_result(transcription_result)
                finally:
                    self.ack_processing_job(job_data)

            except (redis.ConnectionError, redis.exceptions.TimeoutError) as e:
                emit_event(
                    logger,
                    level=logging.ERROR,
                    event={
                        "event": "redis.connection_error",
                        "error": str(e),
                        "error_class": e.__class__.__name__,
                        "error_stack": traceback.format_exc(),
                    },
                )
                time.sleep(5)

            except KeyboardInterrupt:
                emit_event(logger, level=logging.INFO, event={"event": "worker.shutdown"})
                break

            except Exception as e:
                emit_event(
                    logger,
                    level=logging.ERROR,
                    event={
                        "event": "worker.unexpected_error",
                        "error": str(e),
                        "error_class": e.__class__.__name__,
                        "error_stack": traceback.format_exc(),
                    },
                )
                time.sleep(1)


def main() -> None:
    WhisperWorker().run()


if __name__ == "__main__":
    main()
