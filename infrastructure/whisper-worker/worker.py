#!/usr/bin/env python3
"""
Whisper transcription worker.

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
import uuid

import boto3
import redis
from job_processor import TranscriptionJobProcessor
from observability import emit_event, setup_axiom_logging
from otel import init_tracing
from transcriber import WhisperTranscriber
from worker_config import (
    GPU_METRICS_ENABLED,
    JOB_QUEUE,
    LOG_LEVEL,
    POLL_TIMEOUT_SECONDS,
    PROCESSING_HEARTBEAT_INTERVAL_SECONDS,
    PROCESSING_QUEUE,
    PROCESSING_RECOVERY_INTERVAL_SECONDS,
    REDIS_CONNECT_TIMEOUT,
    REDIS_HEALTHCHECK_INTERVAL,
    REDIS_RETRY_ON_TIMEOUT,
    REDIS_SOCKET_TIMEOUT,
    REDIS_URL,
)
from worker_metrics import WorkerMetricsPublisher
from worker_queue import WorkerQueue
from worker_types import TranscriptionJob, TranscriptionResult

logger = logging.getLogger("whisper-worker")
_BOOTSTRAPPED = False


def _build_log_handlers() -> list[logging.Handler]:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    log_path = os.getenv("WHISPER_LOG_FILE", "/var/log/whisper-worker.log")
    log_dir = os.path.dirname(log_path)

    try:
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        handlers.append(logging.FileHandler(log_path))
    except Exception:
        pass

    return handlers


def bootstrap_worker_runtime() -> None:
    global _BOOTSTRAPPED
    if _BOOTSTRAPPED:
        return

    logging.basicConfig(
        level=getattr(logging, LOG_LEVEL, logging.INFO),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=_build_log_handlers(),
        force=True,
    )
    setup_axiom_logging(log_level=LOG_LEVEL)
    init_tracing(service_name="whisper-worker", env=os.getenv("ENVIRONMENT", "dev"))
    _BOOTSTRAPPED = True


def create_redis_client():
    return redis.from_url(
        REDIS_URL,
        decode_responses=True,
        socket_connect_timeout=REDIS_CONNECT_TIMEOUT,
        socket_timeout=REDIS_SOCKET_TIMEOUT,
        retry_on_timeout=REDIS_RETRY_ON_TIMEOUT,
        health_check_interval=REDIS_HEALTHCHECK_INTERVAL,
    )


def create_cloudwatch_client():
    return boto3.client("cloudwatch", region_name=os.getenv("AWS_REGION") or None)


class WhisperWorker:
    def __init__(self, *, redis_client=None, transcriber=None, cloudwatch_client=None) -> None:
        bootstrap_worker_runtime()

        self.worker_id = uuid.uuid4().hex
        self.redis = redis_client or create_redis_client()
        self.transcriber = transcriber or WhisperTranscriber()
        self.metric_namespace = os.getenv("WHISPER_METRIC_NAMESPACE", "Chalk/Whisper")
        self.cloudwatch = cloudwatch_client or create_cloudwatch_client()
        self.enable_gpu_metrics = GPU_METRICS_ENABLED

        self.queue = WorkerQueue(
            redis_client=self.redis,
            worker_id=self.worker_id,
            logger=logger,
        )
        self.metrics = WorkerMetricsPublisher(
            cloudwatch_client=self.cloudwatch,
            metric_namespace=self.metric_namespace,
            logger=logger,
            enable_gpu_metrics=self.enable_gpu_metrics,
        )
        self.job_processor = TranscriptionJobProcessor(
            logger=logger,
            transcriber=self.transcriber,
            metrics_publisher=self.metrics,
        )

    def _result_key(self, job_id: str) -> str:
        return self.queue.result_key(job_id)

    def _done_key(self, job_id: str) -> str:
        return self.queue.done_key(job_id)

    def _processing_lock_key(self, job_id: str) -> str:
        return self.queue.processing_lock_key(job_id)

    def _has_completed_job(self, job_id: str) -> bool:
        return self.queue.has_completed_job(job_id)

    def _mark_job_completed(self, job_id: str) -> None:
        self.queue.mark_job_completed(job_id)

    def _acquire_processing_lock(self, job: TranscriptionJob) -> bool:
        return self.queue.acquire_processing_lock(job.job_id)

    def _refresh_processing_lock(self, job: TranscriptionJob) -> None:
        self.queue.refresh_processing_lock(job.job_id)

    def _release_processing_lock(self, job: TranscriptionJob) -> None:
        self.queue.release_processing_lock(job.job_id)

    def _start_processing_heartbeat(self, job: TranscriptionJob):
        return self.queue.start_processing_heartbeat(job.job_id)

    def process_job(
        self,
        job: TranscriptionJob,
        *,
        queue_depth: int,
        use_batched: bool,
    ) -> TranscriptionResult:
        return self.job_processor.process(
            job,
            queue_depth=queue_depth,
            use_batched=use_batched,
        )

    def store_result(self, result: TranscriptionResult) -> None:
        self.queue.store_result(result)

    def publish_queue_metrics(self) -> None:
        self.metrics.publish_queue(self.redis)

    def publish_gpu_metrics(self) -> None:
        self.metrics.publish_gpu()

    def requeue_processing_jobs(self) -> None:
        self.queue.recover_stale_processing_jobs()

    def ack_processing_job(self, job_data: str) -> None:
        self.queue.acknowledge_processing_job(job_data)

    def run(self) -> None:
        emit_event(logger, level=logging.INFO, event={"event": "worker.start"})
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
                    job = TranscriptionJob(**json.loads(job_data))
                except (json.JSONDecodeError, TypeError) as error:
                    emit_event(
                        logger,
                        level=logging.ERROR,
                        event={
                            "event": "queue.invalid_job",
                            "error": str(error),
                            "error_class": error.__class__.__name__,
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
                except Exception as error:
                    emit_event(
                        logger,
                        level=logging.WARNING,
                        event={
                            "event": "queue.lock_acquire_failed",
                            "job_id": job.job_id,
                            "error": str(error),
                            "error_class": error.__class__.__name__,
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

            except (redis.ConnectionError, redis.exceptions.TimeoutError) as error:
                emit_event(
                    logger,
                    level=logging.ERROR,
                    event={
                        "event": "redis.connection_error",
                        "error": str(error),
                        "error_class": error.__class__.__name__,
                        "error_stack": traceback.format_exc(),
                    },
                )
                time.sleep(5)
            except KeyboardInterrupt:
                emit_event(logger, level=logging.INFO, event={"event": "worker.shutdown"})
                break
            except Exception as error:
                emit_event(
                    logger,
                    level=logging.ERROR,
                    event={
                        "event": "worker.unexpected_error",
                        "error": str(error),
                        "error_class": error.__class__.__name__,
                        "error_stack": traceback.format_exc(),
                    },
                )
                time.sleep(1)


def main() -> None:
    WhisperWorker().run()


if __name__ == "__main__":
    main()
