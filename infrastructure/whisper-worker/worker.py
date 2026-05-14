#!/usr/bin/env python3
from whisper_worker.service import WhisperWorker, main
from whisper_worker.worker_config import JOB_QUEUE, PROCESSING_QUEUE
from whisper_worker.worker_types import TranscriptionJob, TranscriptionResult


if __name__ == "__main__":
    main()
