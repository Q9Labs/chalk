# Whisper Worker

Keep docs minimal. Source of truth is the code in this directory and the Terraform that runs it.

## Layout

- entrypoints: `worker.py`, `transcribe_file.py`
- implementation: `whisper_worker/`
- tests: `tests/`
- runtime/deploy config: `infrastructure/terraform/` + `.github/workflows/whisper-worker.yml`
- Python env/deps: `uv` only

## Read First

- worker runtime: `whisper_worker/service.py`
- transcription behavior: `whisper_worker/transcriber.py`
- job execution: `whisper_worker/job_processor.py`
- queue behavior: `whisper_worker/worker_queue.py`
- env/Redis keys: `whisper_worker/worker_config.py`

## Verify

```bash
python3 -m py_compile infrastructure/whisper-worker/*.py infrastructure/whisper-worker/whisper_worker/*.py infrastructure/whisper-worker/tests/*.py
infrastructure/whisper-worker/.venv/bin/python -m unittest infrastructure/whisper-worker/tests/test_audio_download.py infrastructure/whisper-worker/tests/test_transcriber.py infrastructure/whisper-worker/tests/test_worker_queue.py infrastructure/whisper-worker/tests/test_worker_integration.py
```

## Local Setup

```bash
cd infrastructure/whisper-worker
uv venv .venv
uv pip install -r requirements.txt
```

## Local Smoke

```bash
WHISPER_MODEL=tiny.en \
WHISPER_DEVICE=cpu \
WHISPER_COMPUTE_TYPE=int8 \
WHISPER_MULTILINGUAL=0 \
infrastructure/whisper-worker/.venv/bin/python \
infrastructure/whisper-worker/transcribe_file.py <audio-file> --expect-contains "<expected text>"
```

## Notes

- `pip` is not the workflow here; use `uv`
- install deps with `uv pip install -r requirements.txt`
- Docker still runs `python3 worker.py`
- keep wrappers thin; move behavior into `whisper_worker/`
- do not treat this doc as a contract if code says otherwise
