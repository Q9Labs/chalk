from __future__ import annotations

import json
import logging
import multiprocessing
import traceback
from dataclasses import asdict

import redis

from .observability import emit_event
from .worker_config import (
    DONE_KEY_PREFIX,
    DONE_TTL_SECONDS,
    JOB_QUEUE,
    PROCESSING_HEARTBEAT_INTERVAL_SECONDS,
    PROCESSING_LOCK_KEY_PREFIX,
    PROCESSING_LOCK_TTL_SECONDS,
    PROCESSING_QUEUE,
    PROCESSING_RECOVERY_LOCK_KEY,
    PROCESSING_RECOVERY_LOCK_TTL_SECONDS,
    REDIS_CONNECT_TIMEOUT,
    REDIS_HEALTHCHECK_INTERVAL,
    REDIS_RETRY_ON_TIMEOUT,
    REDIS_SOCKET_TIMEOUT,
    REDIS_URL,
    RESULT_KEY_PREFIX,
    RESULT_TTL_SECONDS,
)
from .worker_types import TranscriptionJob, TranscriptionResult


def _create_heartbeat_redis_client():
    return redis.from_url(
        REDIS_URL,
        decode_responses=True,
        socket_connect_timeout=REDIS_CONNECT_TIMEOUT,
        socket_timeout=REDIS_SOCKET_TIMEOUT,
        retry_on_timeout=REDIS_RETRY_ON_TIMEOUT,
        health_check_interval=REDIS_HEALTHCHECK_INTERVAL,
    )


def _processing_heartbeat_loop(job_id: str, worker_id: str, stop_event) -> None:
    logger = logging.getLogger("whisper-worker")
    lock_key = f"{PROCESSING_LOCK_KEY_PREFIX}{job_id}"
    redis_client = _create_heartbeat_redis_client()

    while not stop_event.wait(PROCESSING_HEARTBEAT_INTERVAL_SECONDS):
        try:
            owner = redis_client.get(lock_key)
            if owner == worker_id:
                redis_client.expire(lock_key, PROCESSING_LOCK_TTL_SECONDS)
        except Exception as error:
            emit_event(
                logger,
                level=logging.WARNING,
                event={
                    "event": "queue.lock_refresh_failed",
                    "job_id": job_id,
                    "error": str(error),
                    "error_class": error.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )


class WorkerQueue:
    def __init__(self, *, redis_client, worker_id: str, logger: logging.Logger) -> None:
        self.redis = redis_client
        self.worker_id = worker_id
        self.logger = logger

    def result_key(self, job_id: str) -> str:
        return f"{RESULT_KEY_PREFIX}{job_id}"

    def done_key(self, job_id: str) -> str:
        return f"{DONE_KEY_PREFIX}{job_id}"

    def processing_lock_key(self, job_id: str) -> str:
        return f"{PROCESSING_LOCK_KEY_PREFIX}{job_id}"

    def has_completed_job(self, job_id: str) -> bool:
        try:
            return bool(self.redis.exists(self.done_key(job_id)))
        except Exception:
            return False

    def mark_job_completed(self, job_id: str) -> None:
        self.redis.setex(self.done_key(job_id), DONE_TTL_SECONDS, "completed")

    def acquire_processing_lock(self, job_id: str) -> bool:
        return bool(
            self.redis.set(
                self.processing_lock_key(job_id),
                self.worker_id,
                nx=True,
                ex=PROCESSING_LOCK_TTL_SECONDS,
            )
        )

    def refresh_processing_lock(self, job_id: str) -> None:
        lock_key = self.processing_lock_key(job_id)
        owner = self.redis.get(lock_key)
        if owner == self.worker_id:
            self.redis.expire(lock_key, PROCESSING_LOCK_TTL_SECONDS)

    def release_processing_lock(self, job_id: str) -> None:
        lock_key = self.processing_lock_key(job_id)
        try:
            owner = self.redis.get(lock_key)
            if owner == self.worker_id:
                self.redis.delete(lock_key)
        except Exception as error:
            emit_event(
                self.logger,
                level=logging.WARNING,
                event={
                    "event": "queue.lock_release_failed",
                    "job_id": job_id,
                    "error": str(error),
                    "error_class": error.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )

    def start_processing_heartbeat(self, job_id: str):
        stop_event = multiprocessing.Event()
        process = multiprocessing.Process(
            target=_processing_heartbeat_loop,
            args=(job_id, self.worker_id, stop_event),
            name=f"processing-heartbeat-{job_id}",
            daemon=True,
        )
        process.start()
        return stop_event, process

    def store_result(self, result: TranscriptionResult) -> None:
        result_dict = asdict(result)
        payload = {key: value for key, value in result_dict.items() if value is not None}
        self.redis.setex(
            self.result_key(result.job_id),
            RESULT_TTL_SECONDS,
            json.dumps(payload),
        )
        if result.status == "completed":
            self.mark_job_completed(result.job_id)

    def recover_stale_processing_jobs(self) -> None:
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
                    job = TranscriptionJob(**json.loads(job_data))
                except (json.JSONDecodeError, TypeError):
                    removed = self.redis.lrem(PROCESSING_QUEUE, 1, job_data)
                    if removed > 0:
                        invalid += removed
                    continue

                if self.has_completed_job(job.job_id):
                    removed = self.redis.lrem(PROCESSING_QUEUE, 1, job_data)
                    if removed > 0:
                        pruned_completed += removed
                    continue

                if self.redis.exists(self.processing_lock_key(job.job_id)):
                    continue

                removed = self.redis.lrem(PROCESSING_QUEUE, 1, job_data)
                if removed > 0:
                    self.redis.lpush(JOB_QUEUE, job_data)
                    moved += removed
        except Exception as error:
            emit_event(
                self.logger,
                level=logging.WARNING,
                event={
                    "event": "queue.requeue_processing_failed",
                    "checked": checked,
                    "moved": moved,
                    "deleted": pruned_completed + invalid,
                    "error": str(error),
                    "error_class": error.__class__.__name__,
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
                self.logger,
                level=logging.INFO,
                event={
                    "event": "queue.requeue_processing_done",
                    "checked": checked,
                    "moved": moved,
                    "deleted": pruned_completed + invalid,
                },
            )

    def acknowledge_processing_job(self, job_data: str) -> None:
        try:
            removed = self.redis.lrem(PROCESSING_QUEUE, 1, job_data)
            if removed == 0:
                emit_event(
                    self.logger,
                    level=logging.WARNING,
                    event={"event": "queue.ack_missing"},
                )
        except Exception as error:
            emit_event(
                self.logger,
                level=logging.WARNING,
                event={
                    "event": "queue.ack_failed",
                    "error": str(error),
                    "error_class": error.__class__.__name__,
                    "error_stack": traceback.format_exc(),
                },
            )
