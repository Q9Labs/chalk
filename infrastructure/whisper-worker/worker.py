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
import tempfile
import time
import traceback
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

import redis

from observability import audio_url_meta, emit_event, setup_axiom_logging
from transcriber import WhisperTranscriber
from worker_types import TranscriptionJob, TranscriptionResult

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
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

# Configuration
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
JOB_QUEUE = "transcription:jobs"
RESULT_KEY_PREFIX = "transcription:result:"
RESULT_TTL_SECONDS = 24 * 60 * 60  # 24 hours
POLL_TIMEOUT_SECONDS = 30


class WhisperWorker:
    def __init__(self) -> None:
        self.redis = redis.from_url(REDIS_URL, decode_responses=True)
        self.transcriber = WhisperTranscriber()

    def _download_audio(self, url: str) -> tuple[str, Optional[int], int]:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as f:
            tmp_path = f.name
            size_bytes = 0
            http_status: Optional[int] = None
            success = False
            try:
                with urlopen(url, timeout=300) as response:
                    http_status = getattr(response, "status", None) or response.getcode()
                    while chunk := response.read(8192):
                        f.write(chunk)
                        size_bytes += len(chunk)
                success = True
                return tmp_path, http_status, size_bytes
            finally:
                if not success and os.path.exists(tmp_path):
                    os.unlink(tmp_path)

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

        wide_event = {
            "event": "whisper.transcription",
            "job_id": job.job_id,
            "language": job.language,
            "queue_depth": queue_depth,
            "use_batched": use_batched,
            **audio_url_meta(job.audio_url),
        }

        try:
            error_stage = "download"
            try:
                audio_path, download_http_status, download_size_bytes = self._download_audio(
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
            emit_event(logger, level=logging.INFO, event=wide_event)
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
            queue_depth = self.redis.llen(JOB_QUEUE)
            metric = {
                "_aws": {
                    "Timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
                    "CloudWatchMetrics": [
                        {
                            "Namespace": "Chalk/Whisper",
                            "Dimensions": [["Environment"]],
                            "Metrics": [{"Name": "TranscriptionQueueDepth", "Unit": "Count"}],
                        }
                    ],
                },
                "Environment": os.getenv("ENVIRONMENT", "dev"),
                "TranscriptionQueueDepth": queue_depth,
            }
            print(json.dumps(metric), flush=True)
            emit_event(
                logger,
                level=logging.INFO,
                event={"event": "whisper.queue_depth", "queue_depth": queue_depth},
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

    def run(self) -> None:
        emit_event(logger, level=logging.INFO, event={"event": "worker.start"})
        last_metric_time = 0.0

        while True:
            try:
                now = time.time()
                if now - last_metric_time >= 60:
                    self.publish_queue_metrics()
                    last_metric_time = now

                result = self.redis.brpop(JOB_QUEUE, timeout=POLL_TIMEOUT_SECONDS)
                if result is None:
                    continue

                _, job_data = result

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
                    continue

                remaining = self.redis.llen(JOB_QUEUE)
                use_batched = remaining >= 1

                transcription_result = self.process_job(
                    job,
                    queue_depth=remaining + 1,
                    use_batched=use_batched,
                )
                self.store_result(transcription_result)

            except redis.ConnectionError as e:
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

