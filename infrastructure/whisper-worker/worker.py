#!/usr/bin/env python3
"""
Whisper Transcription Worker

Polls Redis queue for transcription jobs, processes with faster-whisper,
and stores results back in Redis.

Redis Job Schema (queue: transcription:jobs):
{
    "job_id": "uuid",
    "audio_url": "https://presigned-r2-url...",
    "language": "en",  # optional, auto-detect if not provided
    "created_at": "2024-01-15T10:00:00Z"
}

Redis Result Schema (key: transcription:result:{job_id}, TTL: 24h):
{
    "job_id": "uuid",
    "status": "completed" | "failed",
    "text": "Full transcript...",
    "segments": [{"start": 0.0, "end": 5.2, "text": "..."}],
    "language": "en",
    "duration_seconds": 3600,
    "word_count": 5000,
    "processing_time_seconds": 120,
    "error": null | "error message"
}
"""

import json
import logging
import os
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Optional
from urllib.request import urlopen

import redis
from faster_whisper import WhisperModel

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
MODEL_SIZE = os.getenv("WHISPER_MODEL", "large-v3")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "float16")  # float16 for GPU
DEVICE = os.getenv("WHISPER_DEVICE", "cuda")  # cuda or cpu
POLL_TIMEOUT_SECONDS = 30


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
    duration_seconds: Optional[float] = None
    word_count: Optional[int] = None
    processing_time_seconds: Optional[float] = None
    error: Optional[str] = None


class WhisperWorker:
    def __init__(self):
        logger.info(f"Initializing Whisper worker with model={MODEL_SIZE}, device={DEVICE}")
        self.redis = redis.from_url(REDIS_URL, decode_responses=True)
        self.model = None
        self._load_model()

    def _load_model(self):
        """Load the Whisper model."""
        logger.info(f"Loading Whisper model: {MODEL_SIZE} on {DEVICE}")
        start = time.time()
        self.model = WhisperModel(
            MODEL_SIZE,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
        )
        elapsed = time.time() - start
        logger.info(f"Model loaded in {elapsed:.2f}s")

    def _download_audio(self, url: str) -> str:
        """Download audio to a temporary file."""
        logger.debug(f"Downloading audio from {url[:50]}...")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as f:
            with urlopen(url, timeout=300) as response:
                while chunk := response.read(8192):
                    f.write(chunk)
            return f.name

    def _transcribe(self, audio_path: str, language: Optional[str] = None) -> TranscriptionResult:
        """Transcribe audio file using Whisper."""
        start = time.time()

        segments_list = []
        full_text_parts = []

        # Transcribe with faster-whisper
        segments, info = self.model.transcribe(
            audio_path,
            language=language,
            beam_size=5,
            vad_filter=True,  # Filter out non-speech
            vad_parameters=dict(min_silence_duration_ms=500),
        )

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
            full_text_parts.append(segment.text.strip())

        full_text = " ".join(full_text_parts)
        word_count = len(full_text.split())
        processing_time = time.time() - start

        return TranscriptionResult(
            job_id="",  # Will be set by caller
            status="completed",
            text=full_text,
            segments=segments_list,
            language=info.language,
            duration_seconds=round(info.duration, 2),
            word_count=word_count,
            processing_time_seconds=round(processing_time, 2),
        )

    def process_job(self, job: TranscriptionJob) -> TranscriptionResult:
        """Process a single transcription job."""
        logger.info(f"Processing job {job.job_id}")
        audio_path = None

        try:
            # Download audio
            audio_path = self._download_audio(job.audio_url)
            logger.debug(f"Audio downloaded to {audio_path}")

            # Transcribe
            result = self._transcribe(audio_path, job.language)
            result.job_id = job.job_id

            logger.info(
                f"Job {job.job_id} completed: {result.word_count} words, "
                f"{result.duration_seconds}s audio, {result.processing_time_seconds}s processing"
            )
            return result

        except Exception as e:
            logger.exception(f"Job {job.job_id} failed: {e}")
            return TranscriptionResult(
                job_id=job.job_id,
                status="failed",
                error=str(e),
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
                            "Metrics": [{"Name": "TranscriptionQueueDepth", "Unit": "Count"}],
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

                # Process and store result
                transcription_result = self.process_job(job)
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
