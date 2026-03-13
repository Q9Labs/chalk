from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest
from email.message import Message
from unittest import mock
from urllib.error import HTTPError, URLError

TESTS_DIR = pathlib.Path(__file__).resolve().parent
WORKER_DIR = TESTS_DIR.parent
sys.path.insert(0, str(WORKER_DIR))

from whisper_worker.audio_download import download_audio


class _FakeResponse:
    def __init__(self, *, body: bytes, status: int = 200, headers: Message | None = None) -> None:
        self._body = body
        self.status = status
        self.headers = headers or Message()
        self._offset = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def getcode(self) -> int:
        return self.status

    def read(self, chunk_size: int) -> bytes:
        if self._offset >= len(self._body):
            return b""

        chunk = self._body[self._offset : self._offset + chunk_size]
        self._offset += len(chunk)
        return chunk


class AudioDownloadTests(unittest.TestCase):
    def test_download_audio_retries_transient_http_error_then_succeeds(self) -> None:
        attempts: list[int] = []
        sleeps: list[float] = []
        headers = Message()
        headers.add_header("Content-Type", "audio/mpeg")

        def _open_url(url: str, *, timeout: int):
            attempts.append(timeout)
            if len(attempts) == 1:
                raise HTTPError(url, 503, "busy", hdrs=None, fp=None)
            return _FakeResponse(body=b"hello", headers=headers)

        path, status, size = download_audio(
            "https://example.com/audio",
            open_url=_open_url,
            sleep=sleeps.append,
            initial_backoff_seconds=0.25,
        )

        self.assertEqual(status, 200)
        self.assertEqual(size, 5)
        self.assertEqual(sleeps, [0.25])
        self.assertEqual(pathlib.Path(path).suffix, ".mp3")
        pathlib.Path(path).unlink()

    def test_download_audio_uses_filename_suffix_from_headers(self) -> None:
        headers = Message()
        headers.add_header("Content-Disposition", "attachment", filename="meeting.wav")

        path, _, _ = download_audio(
            "https://example.com/download",
            open_url=lambda url, *, timeout: _FakeResponse(body=b"abc", headers=headers),
            sleep=lambda _: None,
        )

        self.assertEqual(pathlib.Path(path).suffix, ".wav")
        pathlib.Path(path).unlink()

    def test_download_audio_cleans_up_failed_partial_file(self) -> None:
        temp_dir = pathlib.Path(tempfile.mkdtemp())
        before = {path.name for path in temp_dir.iterdir()}
        headers = Message()
        headers.add_header("Content-Type", "audio/webm")

        class _BrokenResponse(_FakeResponse):
            def read(self, chunk_size: int) -> bytes:
                if self._offset == 0:
                    self._offset = 1
                    return b"x"
                raise URLError("connection reset")

        original_named_temporary_file = tempfile.NamedTemporaryFile

        def _named_temporary_file(*args, **kwargs):
            kwargs["dir"] = temp_dir
            return original_named_temporary_file(*args, **kwargs)

        with mock.patch("whisper_worker.audio_download.tempfile.NamedTemporaryFile", _named_temporary_file):
            with self.assertRaises(URLError):
                download_audio(
                    "https://example.com/partial",
                    open_url=lambda url, *, timeout: _BrokenResponse(body=b"", headers=headers),
                    max_attempts=1,
                    sleep=lambda _: None,
                )

        after = {path.name for path in temp_dir.iterdir()}
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
