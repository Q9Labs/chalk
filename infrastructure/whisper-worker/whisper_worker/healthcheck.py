from __future__ import annotations

import json
import sys

from .service import WhisperWorker, create_redis_client


class _HealthcheckTranscriber:
    multilingual = False
    chunk_length_seconds = None
    condition_on_previous_text = False
    last_inference_mode = None
    last_batch_size = None
    last_oom_retries = 0
    last_no_speech = False

    def should_use_batched(self, queued_jobs: int) -> bool:
        return False

    def transcribe(self, audio_path: str, *, language: str | None, use_batched: bool):
        raise NotImplementedError("healthcheck transcriber should never run inference")


class _HealthcheckCloudWatch:
    def put_metric_data(self, **kwargs) -> None:
        return None


def main() -> int:
    try:
        worker = WhisperWorker(
            redis_client=create_redis_client(),
            transcriber=_HealthcheckTranscriber(),
            cloudwatch_client=_HealthcheckCloudWatch(),
        )
        worker.queue.result_key("healthcheck")
        worker.metrics.compute_queue_wait_ms(None)
        print("OK")
        return 0
    except Exception as error:
        print(
            json.dumps(
                {
                    "event": "worker.healthcheck_failed",
                    "error": str(error),
                    "error_class": error.__class__.__name__,
                },
                ensure_ascii=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
