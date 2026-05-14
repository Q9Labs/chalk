from __future__ import annotations

import http.server
import importlib.util
import json
import logging
import os
import pathlib
import socketserver
import sys
import tempfile
import threading
import types
import unittest
import wave


TESTS_DIR = pathlib.Path(__file__).resolve().parent
WORKER_DIR = TESTS_DIR.parent


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


class _InspectingTranscriber:
    multilingual = False
    chunk_length_seconds = 0
    condition_on_previous_text = False
    last_inference_mode = "single"
    last_batch_size = None
    last_oom_retries = 0
    last_no_speech = False

    def __init__(self) -> None:
        self.audio_checks: list[dict[str, int | str]] = []

    def should_use_batched(self, remaining: int) -> bool:
        return False

    def transcribe(self, audio_path: str, *, language: str | None, use_batched: bool):
        file_size = os.path.getsize(audio_path)
        with wave.open(audio_path, "rb") as wav_file:
            self.audio_checks.append(
                {
                    "audio_path": audio_path,
                    "frames": wav_file.getnframes(),
                    "sample_rate": wav_file.getframerate(),
                    "file_size": file_size,
                }
            )

        from whisper_worker.worker_types import TranscriptionResult

        return TranscriptionResult(
            job_id="",
            status="completed",
            text="integration transcript",
            segments=[],
            language=language or "en",
            duration_seconds=1,
            word_count=2,
            processing_time_seconds=0.01,
        )


def _load_worker_module():
    sys.path.insert(0, str(WORKER_DIR))
    logging.FileHandler = lambda *args, **kwargs: logging.StreamHandler(sys.stderr)

    for module_name in list(sys.modules):
        if module_name == "worker_under_test" or module_name.startswith("whisper_worker"):
            del sys.modules[module_name]

    fake_boto3 = types.ModuleType("boto3")
    fake_boto3.client = lambda *args, **kwargs: None
    sys.modules["boto3"] = fake_boto3

    fake_redis = types.ModuleType("redis")
    fake_redis.ConnectionError = RuntimeError
    fake_redis.exceptions = types.SimpleNamespace(TimeoutError=RuntimeError)
    fake_redis.from_url = lambda *args, **kwargs: None
    sys.modules["redis"] = fake_redis

    fake_gpu_metrics = types.ModuleType("whisper_worker.gpu_metrics")
    fake_gpu_metrics.read_gpu_metrics = lambda: None
    sys.modules["whisper_worker.gpu_metrics"] = fake_gpu_metrics

    fake_observability = types.ModuleType("whisper_worker.observability")
    fake_observability.audio_url_meta = lambda url: {"audio_url_host": "127.0.0.1"}
    fake_observability.emit_event = lambda *args, **kwargs: None
    fake_observability.setup_axiom_logging = lambda **kwargs: None
    sys.modules["whisper_worker.observability"] = fake_observability

    fake_otel = types.ModuleType("whisper_worker.otel")
    fake_otel.extract_context_from_traceparent = lambda traceparent: None
    fake_otel.init_tracing = lambda **kwargs: None
    sys.modules["whisper_worker.otel"] = fake_otel

    fake_transcriber = types.ModuleType("whisper_worker.transcriber")

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
    sys.modules["whisper_worker.transcriber"] = fake_transcriber

    spec = importlib.util.spec_from_file_location("worker_under_test", WORKER_DIR / "worker.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _write_test_wav(path: pathlib.Path) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(b"\x00\x00" * 1600)


class _QuietHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


class WhisperWorkerIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.worker_module = _load_worker_module()

    def test_process_job_downloads_real_audio_over_http_and_stores_result(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = pathlib.Path(tmp_dir)
            audio_path = tmp_path / "sample.wav"
            _write_test_wav(audio_path)

            handler = lambda *args, **kwargs: _QuietHTTPHandler(  # noqa: E731
                *args, directory=tmp_dir, **kwargs
            )
            with socketserver.TCPServer(("127.0.0.1", 0), handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    transcriber = _InspectingTranscriber()
                    cloudwatch = _FakeCloudWatch()
                    worker = self.worker_module.WhisperWorker(
                        redis_client=_FakeRedis(),
                        transcriber=transcriber,
                        cloudwatch_client=cloudwatch,
                    )

                    result = worker.process_job(
                        self.worker_module.TranscriptionJob(
                            job_id="integration-job",
                            audio_url=f"http://127.0.0.1:{server.server_address[1]}/sample.wav",
                            language="en",
                        ),
                        queue_depth=1,
                        use_batched=False,
                    )
                    worker.store_result(result)
                finally:
                    server.shutdown()
                    thread.join(timeout=5)

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.text, "integration transcript")
        self.assertEqual(result.language, "en")
        self.assertEqual(len(transcriber.audio_checks), 1)
        self.assertGreater(transcriber.audio_checks[0]["file_size"], 0)
        self.assertEqual(transcriber.audio_checks[0]["sample_rate"], 16000)

        stored = json.loads(worker.redis.kv[worker._result_key("integration-job")])
        self.assertEqual(stored["status"], "completed")
        self.assertEqual(stored["text"], "integration transcript")
        self.assertIn(worker._done_key("integration-job"), worker.redis.kv)
        self.assertGreaterEqual(len(cloudwatch.calls), 1)
        self.assertEqual(cloudwatch.calls[-1]["MetricData"][2]["MetricName"], "TranscriptionsCompleted")


if __name__ == "__main__":
    unittest.main()
