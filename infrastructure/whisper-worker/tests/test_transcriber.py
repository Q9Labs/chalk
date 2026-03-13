from __future__ import annotations

import math
import os
import pathlib
import sys
import tempfile
import unittest
import wave

TESTS_DIR = pathlib.Path(__file__).resolve().parent
WORKER_DIR = TESTS_DIR.parent
sys.path.insert(0, str(WORKER_DIR))

from whisper_worker.transcriber import WhisperTranscriber


def _write_wav(path: str, samples: list[int], sample_rate: int = 16000) -> None:
    with wave.open(path, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"".join(sample.to_bytes(2, "little", signed=True) for sample in samples))


class _ExplodingModel:
    def transcribe(self, *args, **kwargs):
        raise RuntimeError("decoder blew up")


class _ExplodingPipeline:
    def transcribe(self, *args, **kwargs):
        raise RuntimeError("batched decoder blew up")


class TranscriberNoSpeechTests(unittest.TestCase):
    def _make_transcriber(self) -> WhisperTranscriber:
        transcriber = WhisperTranscriber.__new__(WhisperTranscriber)
        transcriber.model_name = "tiny.en"
        transcriber.device = "cpu"
        transcriber.compute_type = "int8"
        transcriber.cpu_threads = 1
        transcriber.beam_size = 5
        transcriber.multilingual = False
        transcriber.chunk_length_seconds = None
        transcriber.condition_on_previous_text = True
        transcriber.language_detection_segments = 1
        transcriber.language_detection_threshold = 0.5
        transcriber.no_speech_threshold = 0.6
        transcriber.silence_rms_threshold = 1e-4
        transcriber.silence_peak_threshold = 1e-3
        transcriber.without_timestamps = False
        transcriber.vad_filter = True
        transcriber.vad_min_silence_ms = 500
        transcriber.batch_size_max = 8
        transcriber.batch_size_min = 1
        transcriber.batched_enabled = False
        transcriber.batched_min_queue_depth = 2
        transcriber.last_inference_mode = None
        transcriber.last_batch_size = None
        transcriber.last_oom_retries = 0
        transcriber.last_no_speech = False
        transcriber.model = _ExplodingModel()
        transcriber.pipeline = _ExplodingPipeline()
        return transcriber

    def test_is_effective_silence_detects_silent_audio(self) -> None:
        transcriber = self._make_transcriber()
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            _write_wav(path, [0] * 16000)
            is_silence, duration_seconds = transcriber._is_effective_silence(path)
        finally:
            os.unlink(path)

        self.assertTrue(is_silence)
        self.assertEqual(duration_seconds, 1)

    def test_is_effective_silence_rejects_audible_audio(self) -> None:
        transcriber = self._make_transcriber()
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        samples = [
            int(12000 * math.sin(2 * math.pi * 440 * index / 16000))
            for index in range(16000)
        ]
        try:
            _write_wav(path, samples)
            is_silence, duration_seconds = transcriber._is_effective_silence(path)
        finally:
            os.unlink(path)

        self.assertFalse(is_silence)
        self.assertEqual(duration_seconds, 1)

    def test_transcribe_single_returns_empty_result_for_silent_audio_even_if_decoder_error_changes(self) -> None:
        transcriber = self._make_transcriber()
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            _write_wav(path, [0] * 16000)
            result = transcriber._transcribe_single(path, language="en", start=0.0)
        finally:
            os.unlink(path)

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.text, "")
        self.assertEqual(result.word_count, 0)
        self.assertTrue(transcriber.last_no_speech)

    def test_transcribe_batched_returns_empty_result_for_silent_audio_even_if_decoder_error_changes(self) -> None:
        transcriber = self._make_transcriber()
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            _write_wav(path, [0] * 16000)
            result = transcriber._transcribe_batched(path, language="en", start=0.0)
        finally:
            os.unlink(path)

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.text, "")
        self.assertEqual(result.word_count, 0)
        self.assertTrue(transcriber.last_no_speech)


if __name__ == "__main__":
    unittest.main()
