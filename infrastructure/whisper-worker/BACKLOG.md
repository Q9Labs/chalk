# whisper-worker backlog

Future considerations / TODOs (keep updated as we discover issues).

## Correctness

- Pass `language` into Redis job (from apps/api) to skip auto-detect + avoid silent-audio language-detect edge cases.
- Replace "max() arg is an empty sequence" string-match with an explicit "no speech" detection path (e.g. VAD -> 0 segments).
- Validate segment timestamps contract for batched path (restore speech timestamps, ensure non-decreasing times).

## Performance (g4dn.xlarge / T4)

- Benchmark `compute_type=int8_float16` vs `float16` (speed/VRAM/quality) and decide default.
- Tune `WHISPER_BATCH_SIZE_MAX` for real meeting distributions (OOM-free max batch); record chosen batch in logs/metrics.
- Evaluate `large-v3-turbo` vs `distil-large-v3.5` vs `large-v3` on chalk meeting samples (WER + latency).
- Consider lowering `beam_size` (e.g. 2/1) if quality acceptable; measure end-to-end.

## Multilingual

- Confirm always-on `multilingual=True` behavior on code-switching meetings; watch for language jitter.
- If jitter/overhead is unacceptable, gate via env/tenant config (default on/off decision).

## Reliability

- Add download retries/backoff for transient URL/timeout errors; record final HTTP status + bytes.
- Consider optional "repair" step for corrupted/truncated media (ffmpeg re-mux) if PyAV decode proves fragile.

## Observability

- Emit embedded metrics: processing time, duration_after_vad, empty-transcript count, failures by stage/class, OOM fallback count.
- Log which path used per job: `WhisperModel` vs `BatchedInferencePipeline`, plus effective batch_size.

## API/Worker Contract

- Add `language` to job schema end-to-end (Go -> Redis -> Python types) once upstream source exists.
- Include optional debug fields on success (e.g. `duration_after_vad`, `language_probability`) if useful for tenants/support.
