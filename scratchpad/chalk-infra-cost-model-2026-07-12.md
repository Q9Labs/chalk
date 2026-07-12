# Chalk Infrastructure Cost Model

Status: Ratified companion to the infrastructure readiness spec. The guardrail
decisions are summarized in the parent's Cost Contract section; this file is
the normative cost model. The parametric planning model at the end is a
forecasting tool rather than ratified contract; where they diverge, the
contract sections govern.

Parent: `scratchpad/chalk-infrastructure-readiness-spec-2026-07-11.md`.

Owner: Hasan Shoaib

## Purpose and scope

This spec defines what every dated cost estimate must contain, the dated
provider price catalog, the recorder usage model and its pre-benchmark
envelopes, the current planning case, the fixed platform baseline, the Grafana
allowance budget, the launch cost guardrails, and the parametric model used to
recompute forecasts from measured inputs. The guardrail summary and the
recorder architecture the costs describe live in the parent and the recorder
spec respectively.

## Dated estimate requirements

Before any staging or production apply, CI produces a dated monthly estimate
using current provider prices and measured resource choices.

The estimate separates:

- EC2, EBS, public IPv4, backup, and AWS data transfer;
- PlanetScale staging and production compute, storage, backups, and egress;
- Cloudflare zone plan, Pages, Tunnel, R2 operations/storage, SFU egress, and
  observability/logging add-ons;
- GHCR storage and transfer if charged;
- recorder fixed/active compute and transfer;
- telemetry, incident delivery, and third-party provider costs;
- staging baseline and production baseline;
- fixed minimum, expected, high, and provider-price uncertainty;
- variable cost per meeting minute, recorded minute, transcription minute,
  stored GiB-month, 1,000 API calls, and peak concurrent room;
- taxes and credits as separate lines rather than hidden assumptions;
- usage-driven costs at expected 50, 80, and 100 percent of the ratified launch
  workload.

Known current fact: Cloudflare Tunnel adds zero direct subscription dollars for
public application publishing. It may avoid a static Elastic IP, but it does
not erase the AWS outbound/public-address or node-capacity cost.

Cloudflare's limits checked on 2026-07-11 allow 100 Workers but only five Cron
Triggers per account on Workers Free. The minimum web, API, sync, and status
services across staging and production need eight schedules. Workers Paid has a
$5 monthly account minimum, 250 Cron Triggers, and usage allowances. The cost
model includes the $5 plan; it never assumes eight free triggers.

## Dated price catalog

The first dated catalog hypothesis uses 730 hours per month and prices checked
on 2026-07-11 and 2026-07-12. AWS's live Price List reports Singapore Linux
on-demand rates of $0.0212/hour for `t4g.small`, $0.0424/hour for
`t4g.medium`, $0.005/hour for an in-use public IPv4 address, and $0.096 per
gp3 GB-month. T4g Unlimited surplus CPU is $0.04 per vCPU-hour in every AWS
region. AWS supplies a shared 100 GB monthly Internet-egress allowance; its live
Price List reports $0.12/GB for the first 10 TB from Singapore after that
allowance. PlanetScale's Singapore price sheet reports $5/month for non-HA PS-5
and $47/month for HA PS-10, each with the first 10 GB included. A
customer-managed AWS KMS key starts at $1/month. Its first and second key
material rotations each add another $1/month. The baseline uses five current
keys for state, environments, and recording envelopes; retaining two rotations
for each can raise their fixed line from $5 to $15 before request charges.

The selected recorder prices were checked on 2026-07-12. DigitalOcean's SGP1
CPU-Optimized 2-vCPU/4-GiB Droplet costs $0.0625/hour, capped at $42/month, and
includes 4,000 GiB of full-month outbound transfer. The TOR1 RTX 4000 GPU
Droplet costs $0.76/hour and includes 10 TB of full-month outbound transfer.
Droplets are billed per second with a 60-second or $0.01 minimum, and transfer
allowance accrues in proportion to active time. Inbound transfer is free and
outbound beyond the pooled allowance is $0.01/GiB. The GPU plan is a
contracted/provider-quota dependency and is unavailable in SGP1; M0 must
prove TOR1 access and a ten-node burst quota without creating production
capacity.

The selected transcription prices were checked on 2026-07-12. DeepInfra lists
`openai/whisper-large-v3-turbo` at $0.00020 per audio minute. Cloudflare lists
`@cf/openai/whisper-large-v3-turbo` at $0.00051 per audio minute. Each forecast
uses provider-reported billed audio by successful and failed attempt, not
meeting duration alone. The billed input is unique non-overlapping speaker-turn
audio plus actual overlapping speakers, deterministic boundary context, and
retry audio. Full-duration participant-track multiplication is prohibited.

## Recorder usage model

Recorder usage is modeled as four separate paths:

1. Cloudflare Realtime SFU to capture is inbound and free at DigitalOcean.
   Cloudflare charges $0.05/GB for data it sends after the account's shared
   1,000 GB monthly SFU/TURN allowance. A 3–4 Mbps selective input is about
   1.35–1.8 GB, or $0.0675–$0.09, per recorded hour when fully billable.
2. Capture to R2 uploads the same encrypted encoded media without transcoding.
   At the target four-meeting density, 3–4 Mbps per meeting fits within the CPU
   Droplet's time-accrued transfer allowance only at the 3 Mbps target; at the
   full 4 Mbps admission budget a four-meeting node uploads about 7.2 GB per
   hour against a roughly 6 GB-per-hour accrual rate, and the difference is
   charged as observed overage. The dated forecast
   still charges observed overage and never assumes unused pooled transfer.
3. R2 to TOR1 is free R2 egress and free DigitalOcean ingress. Final upload from
   TOR1 to R2 consumes the GPU pool's time-accrued allowance. At 2 Mbps output,
   minor overage is possible when one node renders far faster than real time and
   is charged from observed bytes rather than rounded away.
4. R2 Standard stores about 0.9 GB per 2-Mbps recorded hour at the published
   $0.015 per GB-month. One hour retained for a full month costs about $0.0135
   before the 10-GB storage allowance. Ten-to-fifteen-second capture creates
   240–360 Class A object writes per hour; the first million monthly Class A
   operations are included, then the published $4.50/million rate is about
   $0.0011–$0.0016 per recorded hour.

At 1,000 recorded meeting-hours per month, before transcription and ordinary
participant SFU/TURN traffic, the pre-benchmark recorder envelope is:

| Usage line                                  | Sustained full-load lower bound | Minimum-qualified lower bound |
| ------------------------------------------- | ------------------------------: | ----------------------------: |
| SGP1 capture compute, including N+1         |             $18.75 at four/node |            $34.38 at two/node |
| TOR1 render compute                         |         $38.00 at 20x real time |       $50.67 at 15x real time |
| Recorder-specific Cloudflare SFU egress     |         $17.50 after 1 TB at 3M |     $90.00 fully billed at 4M |
| Final R2 storage at 30-day steady retention |                          $13.50 |                        $13.50 |
| R2 operations and DigitalOcean overage      |                           $0–$2 |                         $0–$5 |
| Recorder-only usage subtotal                |                   about $88–$90 |                    about $194 |

The capture rows assume 1,000 meeting-hours packed continuously into 20 active
meetings: 50 wall-clock hours on six target-density nodes or eleven fallback
nodes. They include the ready spare but remain lower bounds. Partial bins,
five-minute prewarm, ten-minute no-shows, early endings, worker replacement,
render boot, and retries can increase node-hours materially. Every expected and
high forecast therefore replays the actual reservation time series through the
placement and render-deadline algorithms; it never divides aggregate hours by
density alone.

A renderer below 15x is unqualified for the ending-together deadline under the
ten-node ceiling. These figures expose why a browser-per-meeting fleet is
excluded and why the GPU throughput benchmark is a release gate. They also show
that the $200 fixed-platform ceiling cannot be represented as a $200 all-in
bill at this usage. The fixed baseline plus these recorder lower bounds is about
$188–$294 before normal participant media and transcription. Normal participant
media can consume the shared Cloudflare allowance before the recorder, and
transcription remains its own usage line.

Every dated forecast uses observed input by track and simulcast layer, render
factor, output bitrate, capture-bundle count, retries, retained bytes, playback
reads, normal participant SFU/TURN egress, and transcription-provider usage.
Cloudflare's shared free allowance is never assigned entirely to recorder
traffic in the expected or high case.

## 2,000-hour planning case

The current 2,000-one-hour-meeting planning case is 2,000 recorded room-hours,
or 120,000 base transcription minutes, with three participants on average,
stage-oriented 720p media, 30-day artifact retention, reservation-aware capture
packing, and no permanent recorder node. It is a budget forecast, not proven
capacity or a new fixed-resource ceiling:

| Monthly line                                       | Planning range | Load-bearing assumption                                       |
| -------------------------------------------------- | -------------: | ------------------------------------------------------------- |
| Fixed platform and dormant staging                 |        $100.48 | Current lean fixed topology                                   |
| SGP1 capture compute and bounded transfer          |       $60–$125 | Reservation packing, prewarm, N+1, and replacement overhead   |
| TOR1 render compute and bounded transfer           |       $80–$115 | 15–20x GPU factor, boot, verification, and bounded retry      |
| Cloudflare SFU/TURN, including recorder subscriber |      $140–$300 | Three-person average and measured subscribed video bitrate    |
| R2 storage and operations                          |        $30–$40 | 30-day steady retention, capture bundles, reads, and cleanup  |
| DeepInfra transcription and Lambda dispatch        |        $25–$40 | $24 base ASR plus measured overlap, context, retries, and AWS |
| Expected all-in total                              |      $435–$720 | Before taxes, credits, unusual TURN use, and provider changes |

The internal planning envelope is $850/month and the conservative external
estimate is $1,000/month until staging replaces these ranges with measured
time-series data. A full-month switch of all 120,000 base minutes from
DeepInfra to Cloudflare adds about $37.20; with a 20-percent overlap, context,
and retry allowance it adds about $44.64. That fallback remains inside the
envelope, but the forecast must recompute it from actual billed minutes.

## Fixed platform baseline

The pre-benchmark fixed and hourly split is:

| Scope                | Candidate line                                               | Monthly or hourly hypothesis |
| -------------------- | ------------------------------------------------------------ | ---------------------------- |
| Shared foundation    | Workers Paid account minimum                                 | $5.00/month                  |
| Shared foundation    | Current state customer-managed KMS key                       | $1.00/month                  |
| Shared foundation    | Serverless controller, ledger, and log reserve               | $1.00/month                  |
| Production           | One `t4g.medium` for 730 hours                               | $30.95/month                 |
| Production           | One in-use public IPv4 address for 730 hours                 | $3.65/month                  |
| Production           | 30 GB gp3 root-volume pricing hypothesis                     | $2.88/month                  |
| Production           | Current environment customer-managed KMS key                 | $1.00/month                  |
| Production           | Recording envelope key-encryption key                        | $1.00/month                  |
| Production           | PlanetScale Singapore HA PS-10                               | $47.00/month                 |
| Dormant staging      | PlanetScale Singapore non-HA PS-5                            | $5.00/month                  |
| Dormant staging      | Current environment customer-managed KMS key                 | $1.00/month                  |
| Dormant staging      | Recording envelope key-encryption key                        | $1.00/month                  |
| Active staging       | `t4g.small`, public IPv4, and prorated 30 GB gp3 root volume | $0.0301/hour                 |
| Active capture node  | DigitalOcean SGP1 CPU-Optimized, 2 vCPU/4 GiB                | $0.0625/hour                 |
| Active render node   | DigitalOcean TOR1 RTX 4000 GPU                               | $0.76/hour                   |
| Burstable compute    | T4g Unlimited surplus CPU above earned baseline              | $0.04/vCPU-hour              |
| Each rotated KMS key | First and second retained rotations                          | +$1.00/month each            |

Before recorder compute, production plus its shared foundation is about
$93.48/month. Keeping staging configured but dormant brings that subtotal to
about $100.48/month. An example 88-hour staging-app month adds about $2.65.
These totals assume no chargeable T4g surplus CPU; the capacity result must add
its measured 24-hour-equivalent cost.

The $1 serverless reserve covers the five-minute lease controller, EventBridge
schedule, on-demand activation and release records, and bounded CloudWatch logs
until a dated calculator quote replaces it; the dormant controller cadence is
about 8,640 invocations in a 30-day month. Usage beyond that reserve is a
visible variance.

Recorder compute has no idle floor, so the normal fixed combined baseline
remains about $100.48. Capture and render tests appear in a separate usage
ledger at their actual node-seconds, transfer, SFU, R2, and retry cost; a scale
test never disguises that spend as a permanent fixed resource.

These figures are hypotheses, not an apply quote: the measured root size,
DigitalOcean worker classes and app-node classes may change. S3 state, transfer,
Cloudflare usage, R2, SFU, GHCR, telemetry volume, browser/media runner compute,
paging, transcription, taxes, and credits remain separate measured lines. Any
enabled but unpriced resource blocks apply rather than disappearing inside the
rounded baseline.

## Grafana allowances and synthetic budget

Grafana's published pricing checked on 2026-07-12 gives each selected Free
account a $0 platform fee, one stack, 14-day retention for metrics, logs,
traces, and profiles, three active users, 10,000 active metric series, 50 GB
each of logs, traces, and profiles per month, 100,000 synthetic API-test
executions, and 10,000 browser-test executions per month. Each execution is
billed against its account allowance per probe location and runtime minute
rounded up. Frequency, locations, retries, duration, and every scripted test
remain explicit capacity inputs.

Free has no paid overage path. A forecast that exceeds either account's
allowances blocks production promotion and requires volume reduction or a
separately approved plan change. The automation never treats the second Free
account as pooled capacity and never upgrades to Pro automatically. The known
monitoring subscription floor is therefore $5/month for Workers Paid. The
non-Cloudflare paging destination and real-browser runner remain pending cost
lines.

The initial synthetic budget is a sizing hypothesis, not a provider promise.
The pre-proof execution sheet is:

| Uptime service      | Billed path and one-minute hypothesis       | Staging hypothesis                           | Production hypothesis                         | Required measurement before forecast                  |
| ------------------- | ------------------------------------------- | -------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Web edge            | Grafana API test plus separate browser test | 1 API location every 15 minutes: 2,880/month | 2 API locations every 5 minutes: 17,280/month | Browser cadence, duration, locations, and retries     |
| API control plane   | Grafana scripted API test                   | 1 location every 15 minutes: 2,880/month     | 2 locations every 5 minutes: 17,280/month     | Transaction duration, cleanup, and retries            |
| Sync realtime       | Grafana scripted WebSocket test             | 1 location every 15 minutes: 2,880/month     | 2 locations every 5 minutes: 17,280/month     | Script support, duration, reconnect, and retries      |
| Status and alerting | Grafana API/status test                     | 1 location every 15 minutes: 2,880/month     | 2 locations every 5 minutes: 17,280/month     | Full-path drill and notification-provider usage       |
| Media               | Selected real-browser runner                | Every 30 minutes                             | Every 15 minutes                              | Coordinated-client billing, runtime, compute, cleanup |
| Artifacts           | Recorder/browser runner                     | Daily and after deploy                       | Daily                                         | Recorder time, transcript cost, storage, and cleanup  |
| Telemetry pipeline  | Managed backend canary, outside synthetics  | Every minute                                 | Every minute                                  | Signal bytes, series, queries, retention, and alerts  |

Using Grafana's 43,200-minute monthly formula, the four production API-class
rows total about 69,120 executions in the production account. The four staging
rows remain at 11,520 executions while staging is dormant because they switch
to lease, controller, status, and target-absence assertions. Each remains below
its own 100,000-account allowance before retries and drills. Active-only media,
artifact, and application-telemetry tests are separate; the managed-backend
canary remains active every minute. The totals exclude browser tests, media,
artifacts, fallback replay checks, and telemetry ingestion. A two-minute billed
browser execution consumes twice the one-minute estimate, and a coordinated
two-client test may consume more than one browser execution. The final sheet
uses both the provider formula and a 31-day maximum, with one row per test,
location, retry policy, execution duration, coordinated client, and non-Grafana
runner resource.

Each Grafana account forecast also includes metric active series and data points
per minute, log/trace/profile GB ingested, frontend sessions, active users,
query/SLO features, notification delivery, and telemetry egress. Staging records
each measured input before production is activated. A forecast outside a Free
allowance blocks promotion until signal volume is reduced or Hasan approves a
different backend plan; production coverage is never weakened silently.

## Launch cost guardrails

Launch cost guardrails are stated before taxes and credits:

- production plus shared fixed foundation warns above $110/month;
- dormant and fixed staging resources warn above $15/month, excluding
  production, shared foundation, and explicitly metered activation work;
- the combined staging, production, and shared fixed-resource forecast has a
  $200/month hard ceiling;
- an automatic staging plan that adds more than $10/month relative to its last
  approved forecast pauses for Hasan's explicit cost approval; the 2026-07-12
  standing approval covers initial build-out staging deltas up to the ratified
  staging warning and combined ceiling;
- every production plan remains approval-only regardless of its amount; the
  initial production creation and first promotion are approved by the
  2026-07-12 standing approval with their payloads recorded in the execution
  ledger.

The normal selected baseline is about $93.48 for production plus shared
foundation and $7 for dormant staging, or $100.48 combined. Capture, render,
SFU, R2, transcription, active staging, and other work that scales with actual
use belongs to a separate usage forecast and ledger. At 1,000 recorded hours,
the recorder-only sustained-load lower bound adds about $88–$194 before normal
participant media and transcription. The fixed $200 ceiling is therefore a
platform-idle control and is never described as an all-in monthly bill.

Every recording reservation atomically reserves estimated concurrency, render
deadline capacity, tenant minutes, and dollar exposure from its usage budget.
The estimate settles to measured cost after finalization. Production has zero
unfunded recording quota: a tenant or internal program must have an approved
allocation before admission. Usage alerts fire at 50, 80, and 100 percent of
both tenant and global exposure. Reaching the limit closes new and unaccepted
admission; it never terminates an active capture or abandons an already accepted
reservation. Pricing or quota changes do not alter the infrastructure ceiling.

A warning emits a visible plan annotation and cost alert but does not by itself
authorize or block an otherwise valid staging apply. The hard ceiling, an
unpriced enabled resource, or a staging delta above $10 blocks apply. A hard
ceiling is a planned fixed-resource control rather than a provider billing cap.
A staging activation always retains its expiry and scale-to-zero behavior.

## Definition of done

This model is done for launch when every price above carries a source link
and check date, the guardrails are encoded in plan and policy checks, CI
produces the dated estimate before every apply, and staging measurements
have replaced each planning range with observed reservation, node-second,
transfer, object, and provider-billed data. Work stops there: forecast
precision beyond measured data is out of scope, and the stated ranges are
deliberately good enough until those measurements exist.

## Parametric planning model

This model recomputes forecasts from your own usage, room shape, and measured
inputs. Every price parameter binds to the dated price catalog above; this
section never restates prices, and the catalog governs when a cached value
diverges. The recorder envelope and the 2,000-hour planning case above are
instantiations of this model. The existing
[`chalk-cost-calculator.html`](./chalk-cost-calculator.html) models live SFU
traffic only until its recorder formulas implement the two-stage
capture/render contract.

### Usage inputs

- `room_minutes_per_month` — total room-minutes across all meetings.
- `room_hours = room_minutes_per_month / 60`.

### Room-shape inputs

- `participants` — average people per room.
- `audio_mbps` — per-participant audio bitrate (Opus ~0.064 Mbps).
- `active_video_mbps` — active-speaker video bitrate (0 to disable).
- `screenshare_mbps` — screenshare bitrate (0 to disable).
- `simultaneous` — whether active-speaker video and screenshare are sent at the
  same time. If false, screenshare replaces active-speaker video.

### Recording inputs

- `recorded_room_hours` — total successfully admitted recorded meeting-hours.
- `capture_input_mbps` — bounded selective encoded media received by the hidden
  native capture process; launch target 3 Mbps.
- `capture_admission_mbps` — maximum reserved input bitrate per recorded
  meeting; launch budget 4 Mbps.
- `capture_node_seconds` — actual SGP1 node lifetime from the reservation
  placement simulation, including N+1, prewarm, no-shows, failures, and drain.
- `render_node_seconds` — actual TOR1 GPU lifetime, including boot, render,
  verification, retry, and drain.
- `render_factor` — measured output-hours per GPU wall-clock hour; at least 15x
  for the ratified ending-together deadline profile.
- `recording_output_mbps` — finalized composite bitrate; launch target 2 Mbps.
- `retention_days` — how long composite recordings are kept.

### Transcription inputs

- `unique_turn_minutes` — non-overlapping speaker-turn audio, billed once
  regardless of participant count.
- `overlap_replay_minutes` — overlapping speech billed once for each audible
  participant track so no speaker is discarded.
- `boundary_context_minutes` — deterministic leading/trailing context added at
  speaker-turn boundaries.
- `retry_minutes` — audio billed again by a provider during a classified retry.
- `cloudflare_fallback_share` — forecast fraction of estimated billed minutes
  routed to Cloudflare after the DeepInfra circuit opens.
- `deepinfra_billed_minutes` and `cloudflare_billed_minutes` — provider-reported
  attempt totals used for settlement; these replace estimates after execution.
- `transcription_dispatch_cost` — Lambda requests, compute, logs, and temporary
  object operations for the scale-to-zero dispatcher.

### Price inputs

Values come from the dated price catalog above.

- `sfu_free_gb` — free monthly SFU/TURN egress pool.
- `sfu_per_gb` — SFU egress price beyond the free pool.
- `r2_per_gb_month` — R2 Standard storage price.
- `capture_per_hour` — SGP1 CPU-Optimized capture-node hourly price.
- `render_per_hour` — TOR1 RTX 4000 hourly price.
- `capture_transfer_included_gib` — full-month CPU Droplet outbound allowance.
- `render_transfer_included_gib` — full-month GPU Droplet outbound allowance.
- `sfu_transfer_included_gib` — pooled allowance for the selected future
  self-hosted SFU nodes.
- `transfer_overage_per_gib` — DigitalOcean transfer overage price.
- `deepinfra_asr_per_minute` and `cloudflare_asr_per_minute` — provider ASR
  prices per billed audio minute.

### Accounted cost lines

- `fixed_platform` — monthly foundation, production, and dormant-staging fixed
  cost from the infrastructure forecast.
- `r2_operations` — measured R2 Class A/Class B request cost.
- `capture_transfer_overage` — measured capture-Droplet transfer overage.
- `render_transfer_overage` — measured render-Droplet transfer overage.
- `transcription` — provider-billed audio plus scale-to-zero dispatch cost.
- `other_metered_usage` — remaining metered services kept outside recording.
- `redundant_sfu_compute` — future self-hosted SFU node cost, including its
  required redundancy floor.

### Formulas

Bandwidth-to-storage conversion: `1 Mbps for 1 hour ~= 0.45 GB`.

Per-room egress (Mbps):

- `video_mbps = simultaneous ? active_video_mbps + screenshare_mbps : max(active_video_mbps, screenshare_mbps)`
- `audio_fanout = participants * (participants - 1) * audio_mbps`
- `media_fanout = (participants - 1) * video_mbps`
- `live_egress_mbps = audio_fanout + media_fanout`

Recorder:

- `recorder_input_mbps = min(capture_input_mbps, capture_admission_mbps)`
- `capture_compute = (capture_node_seconds / 3600) * capture_per_hour`
- `render_compute = (render_node_seconds / 3600) * render_per_hour`
- `ideal_render_compute = (recorded_room_hours / render_factor) * render_per_hour`

`capture_compute` must come from a reservation time-series placement simulation.
Dividing meeting-hours by per-node meeting density omits the mandatory spare,
partial packing, prewarm, no-show drain, replacement, and retry time.

Monthly volumes (GB):

- `live_egress_gb = live_egress_mbps * room_hours * 0.45`
- `recorder_egress_gb = recorder_input_mbps * recorded_room_hours * 0.45`
- `recorded_gb = recording_output_mbps * recorded_room_hours * 0.45`
- `stored_gb = recorded_gb * (retention_days / 30)`

Transcription:

- `estimated_transcription_minutes = unique_turn_minutes + overlap_replay_minutes + boundary_context_minutes + retry_minutes`
- `expected_cloudflare_minutes = estimated_transcription_minutes * cloudflare_fallback_share`
- `expected_deepinfra_minutes = estimated_transcription_minutes - expected_cloudflare_minutes`
- `expected_transcription_provider_cost = expected_deepinfra_minutes * deepinfra_asr_per_minute + expected_cloudflare_minutes * cloudflare_asr_per_minute`
- `transcription_provider_cost = deepinfra_billed_minutes * deepinfra_asr_per_minute + cloudflare_billed_minutes * cloudflare_asr_per_minute`
- `transcription = transcription_provider_cost + transcription_dispatch_cost`

The forecast starts from `estimated_transcription_minutes`, then settles against
the two provider-reported billed-minute totals. It never substitutes
`recorded_room_hours * participants * 60`. For ordinary SFU recordings,
authenticated track ownership supplies speaker identity at no ASR-minute cost;
only true overlap, bounded context, and retries raise billed audio above room
duration.

Costs for the selected Cloudflare SFU direct + custom recorder topology:

- `sfu_billable_gb = max(0, live_egress_gb + recorder_egress_gb - sfu_free_gb)`
- `sfu_cost = sfu_billable_gb * sfu_per_gb`
- `live_only_sfu_cost = max(0, live_egress_gb - sfu_free_gb) * sfu_per_gb`
- `incremental_recorder_sfu_cost = sfu_cost - live_only_sfu_cost`
- `r2_cost = stored_gb * r2_per_gb_month`
- `do_transfer_overage = capture_transfer_overage + render_transfer_overage`
- `recorder_usage = capture_compute + render_compute + incremental_recorder_sfu_cost + r2_cost + r2_operations + do_transfer_overage`
- `total = fixed_platform + live_only_sfu_cost + recorder_usage + transcription + other_metered_usage`

Capture and render have zero idle nodes. Their provider objects and maximum
counts are infrastructure, while node-seconds, media transfer, R2, and
transcription are separately funded usage. The fixed platform ceiling is not an
all-in billing ceiling.

Costs for the future self-hosted SFU on DigitalOcean:

- `node_outbound_gib = (live_egress_gb + recorder_egress_gb) / 1.073` (GB to GiB)
- `transfer_overage = max(0, node_outbound_gib - sfu_transfer_included_gib) * transfer_overage_per_gib`
- `recorder_usage_with_sfu_tap = render_compute + r2_cost + r2_operations + render_transfer_overage`
- `total = fixed_platform + redundant_sfu_compute + transfer_overage + recorder_usage_with_sfu_tap + transcription + other_metered_usage`

The future formula assumes selective capture runs inside the redundant SFU
compute and uploads the encoded packet tap directly to R2. It therefore removes
the separate capture-node compute and transfer lines. The final composite still
comes from TOR1, so its upload remains in `render_transfer_overage` and never in
the SFU-node outbound volume.

### Planning levers and presentation

- Biggest recorder levers: selective simulcast subscription, capture packing,
  GPU render factor, output bitrate, retention, and reservation occupancy.
- Biggest transcription levers: actual overlap, turn-boundary context, retry
  rate, provider fallback share, and accidental full-track multiplication.
- Avoid: Cloudflare Stream minute-based storage for always-on recordings.
- Presentation preference: show the compiled all-in monthly total first, then
  the component breakdown underneath.

## References

- Cloudflare SFU pricing: https://developers.cloudflare.com/realtime/sfu/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare Whisper large-v3-turbo pricing: https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
- DeepInfra Whisper large-v3-turbo pricing: https://deepinfra.com/openai/whisper-large-v3-turbo
- DeepInfra standard-inference privacy: https://docs.deepinfra.com/account/data-privacy
- DeepInfra rate limits: https://docs.deepinfra.com/account/rate-limits
- DigitalOcean bandwidth billing: https://docs.digitalocean.com/platform/billing/bandwidth/
- DigitalOcean Droplet pricing: https://www.digitalocean.com/pricing/droplets
- DigitalOcean detailed GPU pricing: https://docs.digitalocean.com/products/droplets/details/pricing/
- DigitalOcean GPU transfer allowances: https://docs.digitalocean.com/products/droplets/details/features/
- Grafana Cloud pricing and allowances: https://grafana.com/pricing/
