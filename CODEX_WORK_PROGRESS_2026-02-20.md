# CODEX Work Progress — 2026-02-20

## 07:30 PKT

- Task start: Whisper worker downscale feasibility (GPU -> CPU spot)
- Scope: infra review, observability audit, AWS historical metrics, cost/capacity forecast, faster-whisper CPU feasibility research
- Action: discovered whisper worker code at `infrastructure/whisper-worker/`

## 07:35 PKT

- Spawned explorer swarm:
  - infra/runtime map: `019c78e6-bf6c-7370-ab4e-850b43590481`
  - observability map: `019c78e6-bfb0-73b1-85fb-d890faea7212`
  - infra+scaling map: `019c78e6-bfb5-74e1-80f1-1328833b07ec`
- Next: gather AWS inventory + long-range metrics while explorers read code

## 07:41 PKT

- Confirmed AWS target: account `688819141892`, region `us-east-1`, ASG `chalk-whisper-prod-20260126085717939200000005`
- Live whisper capacity: 1x `g4dn.xlarge` Spot (`i-01984d504395fe9ef`), ASG min/desired/max `1/1/2`
- Observed repeated recent Spot capacity launch failures for g4dn.xlarge before eventual success (capacity risk signal)
- Confirmed custom metrics in `Chalk/Whisper` namespace: queue depth, wait, throughput, failures, duration, processing time, download size
- Confirmed no CWAgent GPU metrics currently emitted (no `CWAgent` gpu/nvidia metrics found)

## 08:05 PKT

- Completed historical pull window:
  - CloudWatch custom metrics (`Chalk/Whisper`) daily (2025-01-01..2026-02-20) + 10m (2026-02-13..2026-02-20)
  - EC2 ASG-dimension metrics (CPU/Network) 10m + daily
  - ASG scaling activities (59 events)
  - Alarm state/history for whisper queue/failures alarms
  - Cost Explorer EC2 costs (monthly + daily g4dn.xlarge)
  - Spot history (31-day, 3,135 price points across candidate instance types)
- Key quantitative findings:
  - 7 active production metric days only (2026-02-13..2026-02-19)
  - Transcriptions: total=405, completed=315, failed=90 (all failures on 2026-02-13)
  - Queue depth max=92 (single burst on 2026-02-13); post-burst max=1
  - Queue wait p95 usually sub-second; one outlier day with very high p95 due old backlog
  - Processing p95 ~109s vs audio-duration p95 ~115s -> near real-time on current GPU setup
  - EC2 CPU avg~2.78%, p95~6.75%, max~53.85%
  - Spot reliability risk: 4 interruption terminations (2026-02-16..2026-02-19) + 10 failed g4dn launch attempts from insufficient capacity
  - Historical scale-to-zero event observed on 2026-02-12 from queue-depth-low policy (older config)
- Cost findings:
  - g4dn.xlarge on-demand observed daily ~12.624 USD/day (~0.526/hr)
  - g4dn.xlarge spot observed recently ~5 USD/day (~0.208/hr)
  - 31-day avg spot prices:
    - g4dn.xlarge ~0.205/hr
    - c7i.xlarge ~0.072/hr
    - c7i.2xlarge ~0.163/hr
    - c6i.2xlarge ~0.157/hr

## 08:12 PKT

- Wrote analysis report: `scratchpad/whisper-analysis-2026-02-20/WHISPER_DOWNSCALE_ANALYSIS_2026-02-20.md`
- Report includes: topology map, historical metrics summary, interruption/capacity incidents, cost baselines, CPU feasibility envelopes, downscale recommendations + guardrails
- Pulled upstream research sources (faster-whisper, ctranslate2, AWS Spot best practices) for recommendation grounding

## 08:18 PKT

- User approved infra change path via subagent for focus
- Subagent implemented CPU canary in Terraform:
  - module whisper now supports CPU/GPU toggle (`use_gpu`) + runtime env vars (`whisper_device`, `whisper_compute_type`, `whisper_cpu_threads`)
  - conditional AMI selection + conditional NVIDIA setup + conditional docker `--gpus all`
  - prod whisper set to single `c7i.xlarge` Spot with CPU settings and autoscaling disabled
- Verification run:
  - `terraform -chdir=infrastructure/terraform/modules/whisper validate` ✅
  - `terraform -chdir=infrastructure/terraform/environments/prod validate` ✅

## 08:10 PKT

- Implemented observability additions in worker + monitoring module:
  - Worker now publishes `AudioDurationSeconds` and `RtfRatio` per completed job.
  - Added GPU exporter (`gpu_metrics.py`) reading `nvidia-smi` and emitting `GpuUtilizationPercent`, `GpuMemoryUtilizationPercent`, `GpuDeviceCount`.
  - Added runtime toggle `WHISPER_GPU_METRICS_ENABLED` and wired Terraform env passthrough.
  - Monitoring module adds `whisper_rtf_high` alarm + dashboard widgets for Audio/Processing/RTF and GPU metrics.
- Quality/validation:
  - `python3 -m py_compile infrastructure/whisper-worker/*.py` ✅
  - `terraform -chdir=infrastructure/terraform/modules/whisper validate` ✅
  - `terraform -chdir=infrastructure/terraform/modules/monitoring validate` ✅
  - `terraform -chdir=infrastructure/terraform/environments/prod validate` ✅
- Release prep:
  - Updated `CHANGELOG.md` (`[Unreleased]`) with Whisper observability + CPU canary infra entries.

## 08:18 PKT

- Committed + pushed observability and CPU canary changes:
  - Commit: `19fca25855deb78f5c63b2e4154599e4590cda36`
  - Message: `feat(whisper): add audio/rtf/gpu metrics and cpu canary infra`
- GitHub Actions status for this commit:
  - Infrastructure CI/CD (`22209753658`) ✅ success
    - Validate ✅
    - Plan (Prod) ✅
    - Apply (Prod) ✅
  - Whisper Worker Build (`22209753660`) ✅ success

## 08:30 PKT

- Post-deploy runtime verification (AWS CLI, profile `q9labs`, region `us-east-1`):
  - ASG instance rotation was needed (ASG initially still on LT v10/g4dn despite latest LT v11 available).
  - Started ASG instance refresh:
    - Refresh ID: `0a7a1f3b-0312-45d4-bd0a-1c6928067cbd`
    - Final status: `Successful` (100%)
  - Current worker instance:
    - Instance: `i-01aa458b972f52ecf`
    - Type: `c7i.xlarge`
    - Lifecycle: `spot`
    - ASG: `chalk-whisper-prod-20260126085717939200000005`
    - ASG capacity/health: desired=1 min=1 max=1, InService healthy=1
  - Container health:
    - `whisper-worker` container status: `Up ... (healthy)`
    - Env wiring confirmed in container:
      - `WHISPER_DEVICE=cpu`
      - `WHISPER_COMPUTE_TYPE=int8`
      - `WHISPER_CPU_THREADS=8`
      - `WHISPER_GPU_METRICS_ENABLED=false`

## 08:32 PKT

- Live transcription probe executed through Redis queue on prod worker:
  - Probe job: `probe-1771558050`
  - Audio URL: `https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac`
  - Result: `completed`
  - Output summary:
    - `duration_seconds`: 11
    - `processing_time_seconds`: 7.32
    - transcript returned successfully
- CloudWatch metrics verification (post-probe, Chalk/Whisper):
  - `AudioDurationSeconds` datapoint observed ✅ value `11.0`
  - `RtfRatio` datapoint observed ✅ value `0.665455`
  - `ProcessingTimeSeconds` datapoint observed ✅ value `7.32`
  - GPU util metrics currently absent by design on CPU canary (`WHISPER_GPU_METRICS_ENABLED=false`).

## 08:58 PKT

- User-requested certainty check: replayed an old successful job shape on live prod CPU worker.
- Replay command target:
  - Instance: `i-01aa458b972f52ecf` (`c7i.xlarge` spot)
  - Queue: `transcription:jobs`
  - Audio: `https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac`
- Replay result (SSM command `f95b72fe-9fee-4b0f-a2df-2203c2b29c01`):
  - `JOB_ID=replay-old-1771559825`
  - `QUEUE_TO_RESULT_SECONDS=8.537`
  - `status=completed`
  - `processing_time_seconds=7.68`
  - `audio_duration_seconds=11`
  - `word_count=22`
- CloudWatch verification after replay (namespace `Chalk/Whisper`, env `prod`):
  - `AudioDurationSeconds` latest: `11.0` at `2026-02-20T08:57:00+05:00`
  - `RtfRatio` latest: `0.698182` at `2026-02-20T08:57:00+05:00`
  - `ProcessingTimeSeconds` latest: `7.68` at `2026-02-20T08:57:00+05:00`
  - `TranscriptionsCompleted` latest sum: `1.0` at `2026-02-20T08:57:00+05:00`

## 10:13 PKT

- User-requested long recording validation executed on prod CPU worker.
- Created long spoken test file inside worker container by looping JFK sample:
  - Source: `tests/jfk.flac` (OpenAI whisper repo)
  - Generated: `/tmp/jfk_long_220s.flac` (220s, ~22MB)
  - URL queued: `file:///tmp/jfk_long_220s.flac`
- Queue run details (SSM command `b54c9db9-e525-4fd1-ad82-492892f8e2f3`):
  - `JOB_ID=long-speech-1771564257`
  - `status=completed`
  - `queue_to_result_seconds=109.382`
  - `processing_time_seconds=107.35`
  - `audio_duration_seconds=220`
  - computed `rtf_ratio=0.487955`
  - `word_count=445`
  - transcript produced (`text_chars=2215`)
- CloudWatch confirmation (namespace `Chalk/Whisper`, env `prod`):
  - `AudioDurationSeconds` latest: `220.0` at `2026-02-20T10:12:00+05:00`
  - `RtfRatio` latest: `0.487955` at `2026-02-20T10:12:00+05:00`
  - `ProcessingTimeSeconds` latest: `107.35` at `2026-02-20T10:12:00+05:00`

## 13:13 PKT

- User requested immediate further cost-down (no canary).
- Terraform change applied for Whisper prod module:
  - `instance_type: c7i.xlarge -> c7i.large`
  - `whisper_cpu_threads: 8 -> 2`
- Validation:
  - `terraform -chdir=infrastructure/terraform/environments/prod validate` ✅
- Next execution path: commit+push -> infra apply -> force instance refresh -> transcribe short+long audio probes on live worker.

## 13:30 PKT

- Commit/push for aggressive downsize:
  - Commit: `4f8f9f3283dc53aeb4deaacf82460153c2980128`
  - Message: `perf(infra): downsize whisper worker to c7i.large spot`
- Workflow status:
  - Infrastructure CI/CD run `22273415603` ✅ success
    - Validate ✅
    - Plan (Prod) ✅
    - Apply (Prod) ✅
- ASG rollout:
  - LT updated to v12 (`instance_type=c7i.large`)
  - Instance refresh `44d2e70f-b54e-4ecf-b0ba-b4088f35f344` ✅ Successful
  - New in-service instance: `i-01d06405df787874d` (`c7i.large`, spot)
- Worker health:
  - Container `whisper-worker` up + healthy
  - Observed active processing of a real production queued long audio item (~1h11m) from `transcription:jobs:processing`.

## 13:31 PKT

- Audio transcription tests on downscaled `c7i.large` instance:
  - Direct file test 1 (short speech `/tmp/jfk.flac`):
    - `status=completed`
    - `wall_seconds=20.004`
    - `processing_seconds=20.0`
    - `audio_seconds=11`
    - `rtf=1.818182`
    - `words=22`
  - Direct file test 2 (long speech `/tmp/jfk_long_220s.flac`, 220s):
    - `status=completed`
    - `wall_seconds=278.45`
    - `processing_seconds=278.45`
    - `audio_seconds=220`
    - `rtf=1.265682`
    - `words=445`
- Queue-path note:
  - A queue replay probe (`replay-old-1771748371`) timed out waiting for result because the worker was already busy on a large production backlog item.
  - This indicates queue serialization pressure at `c7i.large` under long-running jobs.
