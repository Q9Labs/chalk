from __future__ import annotations

import importlib.util
import json
import logging
import os
import pathlib
import sys
import tempfile
import types
import unittest
from urllib.error import HTTPError


WORKER_DIR = pathlib.Path(__file__).resolve().parent


class _FakeRedis:
    def __init__(self) -> None:
        self.kv: dict[str, str] = {}
        self.lists: dict[str, list[str]] = {}

    def set(self, key: str, value: str, nx: bool = False, ex: int | None = None) -> bool | None:
        if nx and key in self.kv:
            return None
        self.kv[key] = value
        return True

    def setex(self, key: str, ttl: int, value: str) -> None:
        self.kv[key] = value

    def exists(self, key: str) -> int:
        return 1 if key in self.kv else 0

    def get(self, key: str) -> str | None:
        return self.kv.get(key)

    def delete(self, key: str) -> int:
        return 1 if self.kv.pop(key, None) is not None else 0

    def expire(self, key: str, ttl: int) -> int:
        return 1 if key in self.kv else 0

    def lrange(self, key: str, start: int, end: int) -> list[str]:
        items = list(self.lists.get(key, []))
        if end == -1:
            return items[start:]
        return items[start : end + 1]

    def lrem(self, key: str, count: int, value: str) -> int:
        items = list(self.lists.get(key, []))
        removed = 0
        remaining: list[str] = []
        for item in items:
            if removed < count and item == value:
                removed += 1
                continue
            remaining.append(item)
        self.lists[key] = remaining
        return removed

    def lpush(self, key: str, value: str) -> int:
        self.lists.setdefault(key, []).insert(0, value)
        return len(self.lists[key])

    def llen(self, key: str) -> int:
        return len(self.lists.get(key, []))


class _FakeCloudWatch:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def put_metric_data(self, **kwargs) -> None:
        self.calls.append(kwargs)


class _FakeTranscriber:
    def __init__(self) -> None:
        self.multilingual = False
        self.chunk_length_seconds = 0
        self.condition_on_previous_text = False
        self.last_inference_mode = "single"
        self.last_batch_size = None
        self.last_oom_retries = 0
        self.last_no_speech = False
        self.result_factory = lambda: None

    def should_use_batched(self, remaining: int) -> bool:
        return False

    def transcribe(self, audio_path: str, *, language: str | None, use_batched: bool):
        return self.result_factory()


def _load_worker_module():
    sys.path.insert(0, str(WORKER_DIR))
    logging.FileHandler = lambda *args, **kwargs: logging.StreamHandler(sys.stderr)

    fake_boto3 = types.ModuleType("boto3")
    fake_boto3.client = lambda *args, **kwargs: None
    sys.modules["boto3"] = fake_boto3

    fake_redis = types.ModuleType("redis")
    fake_redis.ConnectionError = RuntimeError
    fake_redis.exceptions = types.SimpleNamespace(TimeoutError=RuntimeError)
    fake_redis.from_url = lambda *args, **kwargs: None
    sys.modules["redis"] = fake_redis

    fake_audio_download = types.ModuleType("audio_download")
    fake_audio_download.download_audio = lambda url: (_ for _ in ()).throw(NotImplementedError)
    sys.modules["audio_download"] = fake_audio_download

    fake_gpu_metrics = types.ModuleType("gpu_metrics")
    fake_gpu_metrics.read_gpu_metrics = lambda: None
    sys.modules["gpu_metrics"] = fake_gpu_metrics

    fake_observability = types.ModuleType("observability")
    fake_observability.audio_url_meta = lambda url: {}
    fake_observability.emit_event = lambda *args, **kwargs: None
    fake_observability.setup_axiom_logging = lambda **kwargs: None
    sys.modules["observability"] = fake_observability

    fake_otel = types.ModuleType("otel")
    fake_otel.extract_context_from_traceparent = lambda traceparent: None
    fake_otel.init_tracing = lambda **kwargs: None
    sys.modules["otel"] = fake_otel

    fake_transcriber = types.ModuleType("transcriber")

    class _FakeWhisperTranscriber:
        multilingual = False
        chunk_length_seconds = 0
        condition_on_previous_text = False
        last_inference_mode = None
        last_batch_size = None
        last_oom_retries = None
        last_no_speech = None

        def should_use_batched(self, remaining: int) -> bool:
            return False

    fake_transcriber.WhisperTranscriber = _FakeWhisperTranscriber
    sys.modules["transcriber"] = fake_transcriber

    spec = importlib.util.spec_from_file_location("worker_under_test", WORKER_DIR / "worker.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class WhisperWorkerQueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.worker_module = _load_worker_module()

    def _make_worker(self):
        transcriber = _FakeTranscriber()
        cloudwatch = _FakeCloudWatch()
        worker = self.worker_module.WhisperWorker(
            redis_client=_FakeRedis(),
            transcriber=transcriber,
            cloudwatch_client=cloudwatch,
        )
        worker.worker_id = "worker-1"
        worker.queue.worker_id = "worker-1"
        return worker, transcriber, cloudwatch

    def test_requeue_processing_jobs_moves_only_unlocked_jobs(self) -> None:
        worker, _, _ = self._make_worker()

        stale_job = json.dumps({"job_id": "stale", "audio_url": "https://example.com/a"})
        locked_job = json.dumps({"job_id": "locked", "audio_url": "https://example.com/b"})
        done_job = json.dumps({"job_id": "done", "audio_url": "https://example.com/c"})

        worker.redis.lists[self.worker_module.PROCESSING_QUEUE] = [
            stale_job,
            locked_job,
            done_job,
        ]
        worker.redis.kv[worker._processing_lock_key("locked")] = "other-worker"
        worker.redis.kv[worker._done_key("done")] = "completed"

        worker.requeue_processing_jobs()

        self.assertEqual(worker.redis.lists[self.worker_module.JOB_QUEUE], [stale_job])
        self.assertEqual(worker.redis.lists[self.worker_module.PROCESSING_QUEUE], [locked_job])

    def test_store_result_marks_only_completed_jobs_done(self) -> None:
        worker, _, _ = self._make_worker()

        completed = self.worker_module.TranscriptionResult(job_id="done", status="completed", text="ok")
        failed = self.worker_module.TranscriptionResult(job_id="failed", status="failed", error="boom")

        worker.store_result(completed)
        worker.store_result(failed)

        self.assertIn(worker._result_key("done"), worker.redis.kv)
        self.assertIn(worker._result_key("failed"), worker.redis.kv)
        self.assertIn(worker._done_key("done"), worker.redis.kv)
        self.assertNotIn(worker._done_key("failed"), worker.redis.kv)

    def test_process_job_success_cleans_up_temp_file_and_publishes_metrics(self) -> None:
        worker, transcriber, cloudwatch = self._make_worker()

        temp_audio = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        temp_audio.write(b"audio")
        temp_audio.close()

        def _download_audio(url: str):
            return temp_audio.name, 200, 4

        transcriber.result_factory = lambda: self.worker_module.TranscriptionResult(
            job_id="",
            status="completed",
            text="hello chalk",
            segments=[],
            language="en",
            duration_seconds=2,
            word_count=2,
            processing_time_seconds=0.4,
        )
        worker.job_processor.download_audio = _download_audio

        result = worker.process_job(
            self.worker_module.TranscriptionJob(
                job_id="job-1",
                audio_url="file:///tmp/fake.wav",
            ),
            queue_depth=1,
            use_batched=False,
        )

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.text, "hello chalk")
        self.assertFalse(os.path.exists(temp_audio.name))
        self.assertGreaterEqual(len(cloudwatch.calls), 1)
        self.assertEqual(cloudwatch.calls[-1]["MetricData"][2]["MetricName"], "TranscriptionsCompleted")

    def test_process_job_http_error_sets_download_diagnostics(self) -> None:
        worker, _, cloudwatch = self._make_worker()

        def _download_audio(url: str):
            raise HTTPError(url, 404, "not found", hdrs=None, fp=None)

        worker.job_processor.download_audio = _download_audio

        result = worker.process_job(
            self.worker_module.TranscriptionJob(
                job_id="job-404",
                audio_url="https://example.com/missing.wav",
            ),
            queue_depth=3,
            use_batched=False,
        )

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.error_stage, "download")
        self.assertEqual(result.download_http_status, 404)
        self.assertEqual(result.download_size_bytes, 0)
        self.assertGreaterEqual(len(cloudwatch.calls), 1)
        self.assertEqual(cloudwatch.calls[-1]["MetricData"][2]["MetricName"], "TranscriptionsFailed")


if __name__ == "__main__":
    unittest.main()
