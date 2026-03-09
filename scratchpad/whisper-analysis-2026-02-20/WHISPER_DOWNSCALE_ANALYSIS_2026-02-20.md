# Whisper Worker Downscale Analysis (2026-02-20)

## Scope

- Repo/infrastructure review: `infrastructure/whisper-worker/`, `infrastructure/terraform/modules/whisper`, `infrastructure/terraform/modules/monitoring`, `infrastructure/terraform/environments/prod`.
- AWS historical pull: CloudWatch metrics, ASG activity, alarms, Cost Explorer, Spot price history.
- Goal: feasibility/capacity/cost of GPU -> CPU downscale (Spot-first).

## Current Production Topology

- ASG: `chalk-whisper-prod-20260126085717939200000005`
- Instance type: `g4dn.xlarge` (Spot), min/desired/max `1/1/2`
- Region/account: `us-east-1` / `688819141892`
- Queue: Redis lists (`transcription:jobs`, `transcription:jobs:processing`)
- Autoscaling signal: custom metric `Chalk/Whisper:TranscriptionQueueDepth`
- Monitoring alarms:
  - `chalk-whisper-prod-queue-depth-high` (threshold 10)
  - `chalk-whisper-prod-queue-depth-low` (threshold 2)
  - `chalk-prod-whisper-*` monitoring alarms (queue depth/wait/failures)

## Observability Reality

- CloudWatch metrics present + useful for throughput/backlog.
- CloudWatch logs mostly event names (`whisper.queue_depth`) with minimal payload; rich fields are not queryable in CW logs.
- No GPU utilization metric exported (no CWAgent `gpu`/`nvidia` metric series).
- Net: capacity analysis possible, but GPU saturation confidence limited.

## Historical Data Pulled

- CloudWatch `Chalk/Whisper` daily window: `2025-01-01` to `2026-02-20`
- High resolution window: `2026-02-13` to `2026-02-20` (10-minute period)
- EC2 ASG-dimension CPU/Network: same 10-minute window
- ASG activity events: 59 events (`2026-01-26` to `2026-02-19`)
- Cost Explorer EC2 compute + g4dn daily costs
- Spot price history (31 days): 3,135 records across candidate types

## Load & Stress Findings

### Workload volume

- Active metric history in prod: 7 days (`2026-02-13`..`2026-02-19`)
- Total jobs: `405`
- Completed: `315`
- Failed: `90` (all on `2026-02-13`)
- Post-`2026-02-14`: `165` completed, `0` failed (stable run)

### Queue health

- Queue depth daily max: `92` (single burst on `2026-02-13`)
- Post-burst queue depth max: `1`
- 10-minute queue-depth datapoints >0: `5 / 953` (`0.52%`)
- 10-minute queue-depth datapoints >1: `2 / 953`

### Latency/processing

- Processing p95 median (daily): `109.29s`
- Audio duration p95 median (daily): `114.88s`
- Effective RTF estimate p95: `~0.95` (near realtime on current GPU path)
- Queue wait p95 usually sub-second after initial outlier day

### Infra stress/reliability

- Spot interruptions: `4` terminations in 4 days (`2026-02-16`..`2026-02-19`)
- Failed launch attempts (insufficient `g4dn.xlarge` capacity): `10` (9 on `2026-02-19`)
- Historical scale-to-zero happened on `2026-02-12` via queue-depth-low policy (older config at that point)
- Metric coverage in 7-day 10m window: `953 / 1008` intervals (`94.54%`) -> indicates brief no-worker periods

## Cost Findings

### Observed actuals (Cost Explorer)

- g4dn on-demand phase (`2026-02-01`..`2026-02-11`):
  - avg hourly `~$0.526`
  - projected monthly `~$378.7`
- g4dn recent spot phase (`2026-02-14`..`2026-02-19`):
  - avg hourly `~$0.190`
  - projected monthly `~$136.9`

### 31-day Spot averages (us-east-1)

- `g4dn.xlarge`: `$0.205/h`
- `c7i.xlarge`: `$0.072/h`
- `c7i.2xlarge`: `$0.163/h`
- `c6i.2xlarge`: `$0.157/h`
- `m7i.2xlarge`: `$0.177/h`

### On-demand reference (us-east-1 pricing API)

- `g4dn.xlarge`: `$0.526/h`
- `c7i.xlarge`: `$0.1785/h`
- `c7i.2xlarge`: `$0.357/h`
- `c6i.2xlarge`: `$0.340/h`

## CPU Feasibility Model (Decision Envelope)

Assumptions for capacity envelope:

- steady-state observed peak (post-burst): `12 jobs / 10m` (`72 jobs/h`)
- future stress target: `2x` peak = `144 jobs/h`
- avg audio length approx `40s/job`
- CPU RTF scenarios for `distil-large-v3.5` on CPU:
  - optimistic `1.2x`
  - base `2.0x`
  - conservative `3.0x`

Per-worker capacity formula:

- `jobs_per_hour = 3600 / (audio_seconds * RTF)`

Estimated capacity:

- RTF 1.2 -> `~75 jobs/h`
- RTF 2.0 -> `~45 jobs/h`
- RTF 3.0 -> `~30 jobs/h`

Required CPU workers:

- To cover current observed peak (72/h):
  - RTF 1.2: `1`
  - RTF 2.0: `2`
  - RTF 3.0: `3`
- To cover 2x future peak (144/h):
  - RTF 1.2: `2`
  - RTF 2.0: `4`
  - RTF 3.0: `5`

Cost implication vs current GPU-Spot baseline (`~$137/mo`):

- `c7i.xlarge` spot (`~$52/mo each`):
  - 2 workers: `~$104/mo` (cheaper)
  - 3 workers: `~$156/mo` (more expensive)
- `c7i.2xlarge` spot (`~$117/mo each`):
  - 1 worker: `~$117/mo` (cheaper)
  - 2 workers: `~$234/mo` (more expensive)

Break-even conclusion:

- CPU downscale is cost-positive only if average CPU footprint stays roughly <=2 `c7i.xlarge` or <=1 `c7i.2xlarge`.

## Recommendation

### Recommendation A (safe + cost-efficient)

- Move to CPU Spot canary first, not direct full cutover.
- Target canary shape:
  - ASG: mixed CPU Spot overrides (`c7i.xlarge`, `c6i.xlarge`, optional `m7i.xlarge`)
  - min/desired/max: `1/1/4`
  - allocation strategy: `price-capacity-optimized`
- Worker CPU tuning baseline:
  - `WHISPER_DEVICE=cpu`
  - `WHISPER_COMPUTE_TYPE=int8`
  - `WHISPER_CPU_THREADS=8` (or vCPU-1)
  - start `WHISPER_BATCH_SIZE_MAX=2` (avoid RAM spikes)

### Recommendation B (guardrails for cutover)

Only complete GPU->CPU cut if ALL true for 7-14 days canary:

- `QueueWaitMs p95 < 60,000`
- `TranscriptionQueueDepth p95 <= 2`
- `TranscriptionsFailed / TranscriptionsTotal < 1%`
- no timeout/SLA regressions in API consumer

### Recommendation C (if CPU fails SLO)

- Keep GPU Spot as primary but harden reliability:
  - mixed instance policy across GPU families/AZ pools
  - capacity-optimized Spot allocation
  - optional on-demand base=1 fallback during interruptions

## High-Value Gaps to Fix Before Final Decision

- Add metric: `AudioDurationSeconds` (sum + percentiles) for exact load-to-capacity math.
- Add metric: processing/audio ratio per job (`rtf_ratio`) for direct CPU/GPU comparisons.
- Export GPU util/memory metrics (`nvidia-smi` -> CloudWatch/OTel).
- Improve structured CloudWatch logs (current log line strips most `extra` fields).

## Bottom Line

- **Feasibility:** CPU downscale is feasible for current steady-state load.
- **Risk:** major risk is not demand; it is interruption + capacity gaps + unknown CPU RTF on your exact model/settings.
- **Best next move:** CPU Spot canary with strict SLO guardrails; promote only if fleet stays <=2 x `c7i.xlarge` equivalent on average.
