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
import threading
import time
import traceback
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Optional
from urllib.error import HTTPError, URLError

import boto3
import redis
from audio_download import download_audio
from gpu_metrics import read_gpu_metrics
from observability import audio_url_meta, emit_event, setup_axiom_logging
from otel import extract_context_from_traceparent, init_tracing
from transcriber import WhisperTranscriber
from worker_config import (
    DONE_KEY_PREFIX,
    DONE_TTL_SECONDS,
    GPU_METRICS_ENABLED,
    JOB_QUEUE,
    LOG_LEVEL,
    LOG_TRANSCRIPT,
    LOG_TRANSCRIPT_MAX_CHARS,
    POLL_TIMEOUT_SECONDS,
    PROCESSING_HEARTBEAT_INTERVAL_SECONDS,
    PROCESSING_LOCK_KEY_PREFIX,
    PROCESSING_LOCK_TTL_SECONDS,
    PROCESSING_RECOVERY_INTERVAL_SECONDS,
    PROCESSING_RECOVERY_LOCK_KEY,
    PROCESSING_RECOVERY_LOCK_TTL_SECONDS,
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
        self.worker_id = uuid.uuid4().hex
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
        self.enable_gpu_metrics = GPU_METRICS_ENABLED

    def _result_key(self, job_id: str) -> str:
        return f"{RESULT_KEY_PREFIX}{job_id}"

    def _done_key(self, job_id: str) -> str:
        return f"{DONE_KEY_PREFIX}{job_id}"

    def _processing_lock_key(self, job_id: str) -> str:
        return f"{PROCESSING_LOCK_KEY_PREFIX}{job_id}"

    def _has_completed_job(self, job_id: str) -> bool:
        try:
            return bool(self.redis.exists(self._done_key(job_id)))
        except Exception:
            return False

    def _mark_job_completed(self, job_id: str) -> None:
        self.redis.setex(self._done_key(job_id), DONE_TTL_SECONDS, "completed")

    def _acquire_processing_lock(self, job: TranscriptionJob) -> bool:
        return bool(
            self.redis.set(
                self._processing_lock_key(job.job_id),
                self.worker_id,
                nx=True,
                ex=PROCESSING_LOCK_TTL_SECONDS,
            )
        )

    def _refresh_processing_lock(self, job: TranscriptionJob) -> None:
        lock_key = self._processing_lock_key(job.job_id)
        owner = self.redis.get(lock_key)
        if owner == self.worker_id:
            self.redis.expire(lock_key, PROCESSING_LOCK_TTL_SECONDS)

    def _release_processing_lock(self, job: TranscriptionJob) -> None:
        lock_key = self._processing_lock_key(job.job_id)
        try:
            owner = self.redis.get(lock_key)
            if owner == self.worker_id:
                self.redis.delete(lock_key)
        except Exception as e:
            emit_event(
                logger,
                level=logging.WARNING,
                event={
                    "event": "queue.lock_release_failed",
                    "job_id": job.job_id,
                    "error": str(e),
                    "error_class": e.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )

    def _start_processing_heartbeat(
        self, job: TranscriptionJob
    ) -> tuple[threading.Event, threading.Thread]:
        stop_event = threading.Event()

        def heartbeat() -> None:
            while not stop_event.wait(PROCESSING_HEARTBEAT_INTERVAL_SECONDS):
                try:
                    self._refresh_processing_lock(job)
                except Exception as e:
                    emit_event(
                        logger,
                        level=logging.WARNING,
                        event={
                            "event": "queue.lock_refresh_failed",
                            "job_id": job.job_id,
                            "error": str(e),
                            "error_class": e.__class__.__name__,
                            "error_stack": traceback.format_exc(),
                        },
                    )

        thread = threading.Thread(
            target=heartbeat,
            name=f"processing-heartbeat-{job.job_id}",
            daemon=True,
        )
        thread.start()
        return stop_event, thread

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
        audio_duration_seconds: Optional[int],
        rtf_ratio: Optional[float],
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

            if audio_duration_seconds is not None and audio_duration_seconds > 0:
                metric_data.append(
                    {
                        "MetricName": "AudioDurationSeconds",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Seconds",
                        "Value": audio_duration_seconds,
                    }
                )

            if rtf_ratio is not None and rtf_ratio >= 0:
                metric_data.append(
                    {
                        "MetricName": "RtfRatio",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "None",
                        "Value": rtf_ratio,
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

    def _compute_rtf_ratio(
        self, processing_time_seconds: Optional[float], audio_duration_seconds: Optional[int]
    ) -> Optional[float]:
        if processing_time_seconds is None:
            return None
        if audio_duration_seconds is None or audio_duration_seconds <= 0:
            return None
        return round(processing_time_seconds / audio_duration_seconds, 6)

    def publish_gpu_metrics(self) -> None:
        if not self.enable_gpu_metrics:
            return

        try:
            gpu_metrics = read_gpu_metrics()
            if gpu_metrics is None:
                return

            environment = os.getenv("ENVIRONMENT", "dev")
            self.cloudwatch.put_metric_data(
                Namespace=self.metric_namespace,
                MetricData=[
                    {
                        "MetricName": "GpuUtilizationPercent",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Percent",
                        "Value": gpu_metrics.utilization_gpu_pct,
                    },
                    {
                        "MetricName": "GpuMemoryUtilizationPercent",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Percent",
                        "Value": gpu_metrics.utilization_memory_pct,
                    },
                    {
                        "MetricName": "GpuDeviceCount",
                        "Dimensions": [{"Name": "Environment", "Value": environment}],
                        "Timestamp": datetime.now(timezone.utc),
                        "Unit": "Count",
                        "Value": gpu_metrics.device_count,
                    },
                ],
            )
        except Exception as e:
            emit_event(
                logger,
                level=logging.WARNING,
                event={
                    "event": "metrics.gpu_publish_failed",
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
                    "audio_duration_seconds": result.duration_seconds,
                    "rtf_ratio": self._compute_rtf_ratio(
                        result.processing_time_seconds, result.duration_seconds
                    ),
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
            emit_event(logger, level=logging.INFO, event=wide_event)
            self.publish_transcription_metrics(
                outcome="completed",
                duration_ms=wide_event["duration_ms"],
                queue_wait_ms=queue_wait_ms,
                download_size_bytes=download_size_bytes,
                processing_time_seconds=result.processing_time_seconds,
                audio_duration_seconds=result.duration_seconds,
                rtf_ratio=wide_event["rtf_ratio"],
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
                audio_duration_seconds=None,
                rtf_ratio=None,
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
        key = self._result_key(result.job_id)
        result_dict = asdict(result)
        result_dict = {k: v for k, v in result_dict.items() if v is not None}
        self.redis.setex(key, RESULT_TTL_SECONDS, json.dumps(result_dict))
        if result.status == "completed":
            self._mark_job_completed(result.job_id)

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
        # Recover only stale processing entries. Live jobs hold a short-lived lock
        # refreshed by the owning worker, so a new worker must not blindly replay them.
        moved = 0
        pruned_completed = 0
        invalid = 0
        checked = 0
        lock_acquired = False
        try:
            lock_acquired = bool(
                self.redis.set(
                    PROCESSING_RECOVERY_LOCK_KEY,
                    self.worker_id,
                    nx=True,
                    ex=PROCESSING_RECOVERY_LOCK_TTL_SECONDS,
                )
            )
            if not lock_acquired:
                return

            for job_data in self.redis.lrange(PROCESSING_QUEUE, 0, -1):
                checked += 1
                try:
                    job_dict = json.loads(job_data)
                    job = TranscriptionJob(**job_dict)
                except (json.JSONDecodeError, TypeError):
                    removed = self.redis.lrem(PROCESSING_QUEUE, 1, job_data)
                    if removed > 0:
                        invalid += removed
                    continue

                if self._has_completed_job(job.job_id):
                    removed = self.redis.lrem(PROCESSING_QUEUE, 1, job_data)
                    if removed > 0:
                        pruned_completed += removed
                    continue

                if self.redis.exists(self._processing_lock_key(job.job_id)):
                    continue

                removed = self.redis.lrem(PROCESSING_QUEUE, 1, job_data)
                if removed > 0:
                    self.redis.lpush(JOB_QUEUE, job_data)
                    moved += removed
        except Exception as e:
            emit_event(
                logger,
                level=logging.WARNING,
                event={
                    "event": "queue.requeue_processing_failed",
                    "checked": checked,
                    "moved": moved,
                    "deleted": pruned_completed + invalid,
                    "error": str(e),
                    "error_class": e.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )
            return
        finally:
            if lock_acquired:
                try:
                    owner = self.redis.get(PROCESSING_RECOVERY_LOCK_KEY)
                    if owner == self.worker_id:
                        self.redis.delete(PROCESSING_RECOVERY_LOCK_KEY)
                except Exception:
                    pass

        if moved > 0 or pruned_completed > 0 or invalid > 0:
            emit_event(
                logger,
                level=logging.INFO,
                event={
                    "event": "queue.requeue_processing_done",
                    "checked": checked,
                    "moved": moved,
                    "deleted": pruned_completed + invalid,
                },
            )

    def ack_processing_job(self, job_data: str) -> None:
        try:
            removed = self.redis.lrem(PROCESSING_QUEUE, 1, job_data)
            if removed == 0:
                emit_event(
                    logger,
                    level=logging.WARNING,
                    event={
                        "event": "queue.ack_missing",
                    },
                )
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
        emit_event(
            logger,
            level=logging.INFO,
            event={"event": "worker.start"},
        )
        last_metric_time = 0.0
        last_recovery_time = 0.0
        self.requeue_processing_jobs()

        while True:
            try:
                now = time.time()
                if now - last_metric_time >= 60:
                    self.publish_queue_metrics()
                    self.publish_gpu_metrics()
                    last_metric_time = now
                if now - last_recovery_time >= PROCESSING_RECOVERY_INTERVAL_SECONDS:
                    self.requeue_processing_jobs()
                    last_recovery_time = now

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

                if self._has_completed_job(job.job_id):
                    emit_event(
                        logger,
                        level=logging.INFO,
                        event={
                            "event": "queue.job_already_completed",
                            "job_id": job.job_id,
                        },
                    )
                    self.ack_processing_job(job_data)
                    continue

                try:
                    lock_acquired = self._acquire_processing_lock(job)
                except Exception as e:
                    emit_event(
                        logger,
                        level=logging.WARNING,
                        event={
                            "event": "queue.lock_acquire_failed",
                            "job_id": job.job_id,
                            "error": str(e),
                            "error_class": e.__class__.__name__,
                            "error_stack": traceback.format_exc(),
                        },
                    )
                    self.ack_processing_job(job_data)
                    continue

                if not lock_acquired:
                    emit_event(
                        logger,
                        level=logging.INFO,
                        event={
                            "event": "queue.job_locked_elsewhere",
                            "job_id": job.job_id,
                        },
                    )
                    self.ack_processing_job(job_data)
                    continue

                remaining = self.redis.llen(JOB_QUEUE)
                use_batched = self.transcriber.should_use_batched(remaining)
                heartbeat_stop, heartbeat_thread = self._start_processing_heartbeat(job)

                try:
                    transcription_result = self.process_job(
                        job,
                        queue_depth=remaining + 1,
                        use_batched=use_batched,
                    )
                    self.store_result(transcription_result)
                finally:
                    heartbeat_stop.set()
                    heartbeat_thread.join(timeout=PROCESSING_HEARTBEAT_INTERVAL_SECONDS)
                    self._release_processing_lock(job)
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
