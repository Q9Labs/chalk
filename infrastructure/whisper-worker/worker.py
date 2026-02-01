#!/usr/bin/env python3
"""
Whisper Transcription Worker

Polls Redis queue `transcription:jobs`, transcribes via faster-whisper, stores result at `transcription:result:{job_id}` (TTL 24h).
Failure payload includes diagnostic fields (`error_stage`, `error_class`, `download_http_status`, `download_size_bytes`) consumed by apps/api.
"""
import json
import logging
import os
import sys
import tempfile
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

import redis
from transcriber import WhisperTranscriber
from worker_types import TranscriptionJob, TranscriptionResult

# Configure logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("/var/log/whisper-worker.log"),
    ],
)
logger = logging.getLogger("whisper-worker")

# Configuration
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
JOB_QUEUE = "transcription:jobs"
RESULT_KEY_PREFIX = "transcription:result:"
RESULT_TTL_SECONDS = 24 * 60 * 60  # 24 hours
POLL_TIMEOUT_SECONDS = 30

class WhisperWorker:
    def __init__(self):
        self.redis = redis.from_url(REDIS_URL, decode_responses=True)
        self.transcriber = WhisperTranscriber()

    def _download_audio(self, url: str) -> tuple[str, Optional[int], int]:
        """Download audio to a temporary file."""
        logger.debug(f"Downloading audio from {url[:50]}...")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as f:
            tmp_path = f.name
            size_bytes = 0
            http_status: Optional[int] = None
            success = False
            try:
                with urlopen(url, timeout=300) as response:
                    http_status = (
                        getattr(response, "status", None) or response.getcode()
                    )
                    while chunk := response.read(8192):
                        f.write(chunk)
                        size_bytes += len(chunk)
                success = True
                return tmp_path, http_status, size_bytes
            except HTTPError as e:
                http_status = e.code
                raise
            except URLError:
                raise
            finally:
                if not success and os.path.exists(tmp_path):
                    os.unlink(tmp_path)

    def process_job(self, job: TranscriptionJob, *, use_batched: bool) -> TranscriptionResult:
        """Process a single transcription job."""
        logger.info("Processing job %s (use_batched=%s)", job.job_id, use_batched)
        audio_path = None
        download_http_status: Optional[int] = None
        download_size_bytes: Optional[int] = None
        error_stage: Optional[str] = None

        try:
            # Download audio
            error_stage = "download"
            try:
                audio_path, download_http_status, download_size_bytes = (
                    self._download_audio(job.audio_url)
                )
            except HTTPError as e:
                download_http_status = e.code
                download_size_bytes = 0
                raise

            if download_size_bytes == 0:
                raise ValueError("downloaded 0 bytes")
            logger.debug(f"Audio downloaded to {audio_path}")

            # Transcribe
            error_stage = "transcribe"
            result = self.transcriber.transcribe(
                audio_path,
                language=job.language,
                use_batched=use_batched,
            )
            result.job_id = job.job_id

            logger.info(
                "Job completed %s: word_count=%s duration_seconds=%s processing_time_seconds=%s",
                job.job_id,
                result.word_count,
                result.duration_seconds,
                result.processing_time_seconds,
            )
            return result

        except Exception as e:
            logger.exception(f"Job {job.job_id} failed: {e}")
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
            # Clean up temporary file
            if audio_path and os.path.exists(audio_path):
                os.unlink(audio_path)

    def store_result(self, result: TranscriptionResult):
        """Store transcription result in Redis."""
        key = f"{RESULT_KEY_PREFIX}{result.job_id}"
        result_dict = asdict(result)

        # Filter out None values
        result_dict = {k: v for k, v in result_dict.items() if v is not None}

        self.redis.setex(
            key,
            RESULT_TTL_SECONDS,
            json.dumps(result_dict),
        )
        logger.debug(f"Stored result for job {result.job_id}")

    def publish_queue_metrics(self):
        """Publish queue depth metric to CloudWatch (via stdout for agent)."""
        try:
            queue_depth = self.redis.llen(JOB_QUEUE)
            # Log in CloudWatch embedded metric format
            metric = {
                "_aws": {
                    "Timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
                    "CloudWatchMetrics": [
                        {
                            "Namespace": "Chalk/Whisper",
                            "Dimensions": [["Environment"]],
                            "Metrics": [
                                {"Name": "TranscriptionQueueDepth", "Unit": "Count"}
                            ],
                        }
                    ],
                },
                "Environment": os.getenv("ENVIRONMENT", "dev"),
                "TranscriptionQueueDepth": queue_depth,
            }
            print(json.dumps(metric), flush=True)
        except Exception as e:
            logger.warning(f"Failed to publish metrics: {e}")

    def run(self):
        """Main worker loop."""
        logger.info("Starting worker loop")
        last_metric_time = 0

        while True:
            try:
                # Publish metrics every minute
                now = time.time()
                if now - last_metric_time >= 60:
                    self.publish_queue_metrics()
                    last_metric_time = now

                # Block-pop from queue
                result = self.redis.brpop(JOB_QUEUE, timeout=POLL_TIMEOUT_SECONDS)

                if result is None:
                    # Timeout, continue loop
                    continue

                _, job_data = result

                try:
                    job_dict = json.loads(job_data)
                    job = TranscriptionJob(**job_dict)
                except (json.JSONDecodeError, TypeError) as e:
                    logger.error(f"Invalid job data: {e}")
                    continue

                # Heuristic: if backlog exists, use batched inference for throughput.
                # Note: brpop already removed this job; remaining depth + 1 approximates total depth.
                remaining = self.redis.llen(JOB_QUEUE)
                use_batched = remaining >= 1

                # Process and store result
                transcription_result = self.process_job(job, use_batched=use_batched)
                self.store_result(transcription_result)

            except redis.ConnectionError as e:
                logger.error(f"Redis connection error: {e}")
                time.sleep(5)

            except KeyboardInterrupt:
                logger.info("Shutting down")
                break

            except Exception as e:
                logger.exception(f"Unexpected error: {e}")
                time.sleep(1)


def main():
    worker = WhisperWorker()
    worker.run()


if __name__ == "__main__":
    main()
