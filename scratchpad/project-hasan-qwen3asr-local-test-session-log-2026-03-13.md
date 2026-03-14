2026-03-13 22:37 PKT
- Goal: run offline local test of Qwen3-ASR-1.7B on Hasan's Apple M4 Air 16 GB.
- Environment: Apple M4, 16 GB RAM, ~43 GB free, `python3`, `uv`, `ffmpeg` available.
- Plan: use Apple-Silicon-friendly MLX path for Qwen3-ASR, fetch a mixed-language sample from the internet, run transcription, assess turn-level language switching.

2026-03-13 23:58 PKT
- Installed isolated test env in `scratchpad/qwen3-asr-local/.venv`.
- Installed packages: `mlx-qwen3-asr`, `datasets`, `soundfile`, `yt-dlp`.
- Source used for first real test: `https://www.youtube.com/watch?v=QDb_ANH8654` (`ARABIC-ENGLISH bilingual #conversations | My friend is not doing well صديقي ليس بخير | Learn Arabic`).
- Downloaded audio to `scratchpad/qwen3-asr-local/samples/QDb_ANH8654.wav`.
- Ran full 180s clip with `Qwen/Qwen3-ASR-1.7B` via MLX.
- First-run model cache size reached ~4.4G under `~/.cache/huggingface/hub/models--Qwen--Qwen3-ASR-1.7B`.
- Full 180s clip result:
  - Transcript preserved both English and Arabic text in one output.
  - Top-level reported language was `English`.
  - Wall time ~292s for 180s audio on first run.
  - Peak memory footprint reported by `/usr/bin/time -l`: ~13.38 GB.
- Focused 55s-95s Arabic segment result:
  - Reported language: `Arabic`.
  - Transcript returned Arabic text correctly.
- Fixed 30s window pass over the 180s clip using one shared `Session(model='Qwen/Qwen3-ASR-1.7B')`:
  - `QDb_ANH8654_000.wav` -> `English`
  - `QDb_ANH8654_001.wav` -> `English`
  - `QDb_ANH8654_002.wav` -> `Arabic`
  - `QDb_ANH8654_003.wav` -> `Arabic`
  - `QDb_ANH8654_004.wav` -> `English`
  - `QDb_ANH8654_005.wav` -> `English`
- Conclusion from local run: Qwen3-ASR-1.7B can transcribe mixed-language content on this Mac, but a single long file still tends to carry one coarse top-level language label. Offline segmentation enables turn/window-level language switching behavior.

2026-03-14 00:34 PKT
- Installed `faster-whisper==1.2.1` in the same isolated venv for comparison.
- Compared on the same source clip `QDb_ANH8654_first180.wav` using `WhisperModel('large-v3', device='cpu', compute_type='int8')`.
- Full 180s clip result:
  - Reported language: `ar` with probability `0.562`.
  - Output heavily favored Arabic.
  - English instructional speech at the start was not preserved faithfully; much of it was rendered as Arabic/Arabic-leaning output instead of keeping the source mix.
  - Wall time: ~805.92s for 180s audio on this machine.
  - Peak memory footprint: ~5.66 GB.
- Focused 55s-95s Arabic segment:
  - Reported language: `ar` with probability `0.984`.
  - Arabic dialogue transcribed correctly.
- Fixed 30s window pass over same 180s clip:
  - `QDb_ANH8654_000.wav` -> `ar` (`0.562`) and rendered the English intro as Arabic-leaning output
  - `QDb_ANH8654_001.wav` -> `en` (`0.862`) and preserved English
  - `QDb_ANH8654_002.wav` -> `ar` (`0.978`) and preserved Arabic
  - `QDb_ANH8654_003.wav` -> `en` (`0.897`) but mostly dropped the Arabic content, keeping only brief English
  - `QDb_ANH8654_004.wav` -> `en` (`0.954`)
  - `QDb_ANH8654_005.wav` -> `en` (`0.925`)
- Practical comparison:
  - Qwen full-file output preserved both English and Arabic text in one transcript, though with one coarse top-level label.
  - Whisper full-file output locked Arabic and distorted/lost mixed-language fidelity.
  - With offline windows, both can flip labels, but Whisper still mishandled mixed windows more often.

2026-03-14 00:52 PKT
- Repo architecture read for replacement feasibility:
  - API provider enqueues JSON jobs into Redis list `transcription:jobs` and polls `transcription:result:{job_id}`; contract is in `apps/api/internal/infrastructure/transcription/whisper.go`.
  - Worker runtime is Python in `infrastructure/whisper-worker/whisper_worker/`.
  - Current transcriber is tightly coupled to `faster-whisper` / `BatchedInferencePipeline` in `transcriber.py`.
  - Lean prod worker infra is singleton EC2 ASG in `infrastructure/terraform/modules/ec2-whisper-lean`, currently defaulting to CPU `c7i.xlarge`, `WHISPER_DEVICE=cpu`, `WHISPER_COMPUTE_TYPE=int8`, `WHISPER_CPU_THREADS=4`.
  - Existing lean module is Docker-on-AL2023 x86_64 only; no NVIDIA toolkit setup there.
- Replacement conclusion:
  - Queue/API/result contract is reusable for a Qwen backend with minimal API-side change.
  - Current lean compute/runtime assumptions are not reusable as-is for Qwen if we want acceptable performance.
  - In-place replacement on current `c7i.xlarge` CPU worker is not recommended.
  - Feasible path is new transcriber implementation + likely GPU-backed deployment (or separate Qwen worker image/canary path) while preserving Redis job/result shape.
