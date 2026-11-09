# SFU packet budget calibration

This is the reviewed calibration that [M6](milestones.md) requires before the node
budgets leave the initial 16,000 and 32,000. It sets what `deploy/deploy` renders as
`SFU_PACKET_BUDGET` and `SFU_GUARD_MAX_STEAL_PERCENT`.

| Node                           | `SFU_PACKET_BUDGET` | Three-person classes admitted | Steal guard for new Episodes |
| ------------------------------ | ------------------- | ----------------------------- | ---------------------------- |
| Production `s-2vcpu-2gb` ($18) | 36,000              | 5 (35,850 reserved)           | 40%                          |
| Staging `s-1vcpu-1gb` ($6)     | 22,000              | 3 (21,510 reserved)           | 25%                          |

A class is three Participants with two cameras each, which reserves 7,170 packets/s
([design](design.md#workload-and-packet-rate-math)). The 22,000 and 36,000 figures are
a model fitted to the runs below. The production soak proves five-class media
stability below 36,000 packets/s, not sustained traffic at that budget. The staging
three-class soak remains unproved.

## What limits a shared vCPU

Our own CPU use is steady, about 11% of one vCPU per class on both sizes. The host's
steal is what varies, and it arrives in bursts. Media stalls when our steady demand
approaches what is left after the steal, so the budget has to keep demand low enough
for the worst burst, not the average.

**Evidence, 1 vCPU staging node, 4 classes, 5 hours** (budget then 45,000; 02:31Z to
07:30Z, 2026-11-08, node sampled every 10 s):

- Own CPU stayed at 42% (p99 45%). Steal averaged 10%, but its 10 s p90 was 22%, p99 39% and maximum 52%.
- Heap and goroutines were flat, so no leak.
- The run failed its stall rule: 114 microphone stalls over 500 ms, 24 screen-share stalls, 237 camera stalls. Nearly all fell in two events, 06:00Z (cameras, up to 8.5 s) and 06:47Z (24 microphones at once, 3.3 s), plus smaller clusters at 03:00Z, 05:00Z and 05:30Z.
- The stalls sat on :00 and :30 marks, where steal reached 45 to 52% for 10 to 20 s while own CPU stayed near 40%. At 05:00Z the scheduler p99 was 168 ms.
- Stalls began when demand over available CPU, `own / (1 - steal)`, passed about 75% (42% / 55% at steal 45%). A 06:25Z burst of 52% steal with own CPU at 34% (71%) stalled nothing.
- The 06:47Z event does not fit: its 10 s steal was 16 to 19%. A sub-10 s burst or another cause is possible, and 10 s samples cannot tell.
- A 1 hour soak at the same 4 classes the evening before passed. A 1 hour run misses these tails.

**Evidence, 2 vCPU production node, 2 to 10 classes, 25 minutes** (admission guard at 50%, 3 minutes per step):

- Own CPU grew about 5% of the node per class: 26% at 4 classes, 30% at 5, 41% at 8, 46% at 9, 50% at 10.
- Steal over 10 s peaked at 31%; media was clean to 9 classes, and 10 classes stalled 8 videos for up to 23 s.
- At 5 classes demand over available CPU is 30% / 48% = 62% at steal 52%, and 50% at the 40% guard. Staging stalled at 75% and above. Production ran clean at 9 classes, where 46% own CPU over the 23% peak steal is 60%.

**Evidence, 2 vCPU production node, 5 classes, 3.0 hours** (soak C, 2026-11-08):

- All five classes (15 participants) had zero camera, screen or audio stalls and zero freezes.
- Node `eth0` averaged 33,696 packets/s, with p99 35,108: below the 36,000 packets/s budget, not at it.
- Host steal averaged 3.4%, with p99 36% and maximum 68%. Generator pauses are excluded; see the [M6 sizing evidence](milestones.md#m6--reproducible-sgp1-staging-and-production-nodes).

## Per-SKU bench (M11 package 6)

Run on 2026-11-09 on short-lived `sgp1` bench Droplets of each size, deployed at the budget in the table above, each driven by its own `s-4vcpu-8gb` generator in the same region ([raw summaries](per-sku-bench-2026-11-09.json), driver `features/media/sfu/scripts/bench/capacity`). The bench guard closes admission at 25% steal on both sizes, not production's 40%. Each shape ran at its steady state for 15 minutes (classes) or 10 minutes (the others), and the first 2 minutes are left out. Own CPU excludes steal and is a share of the whole node, so 38% on 2 vCPU is 0.76 of a vCPU. Packets are `eth0` counters on the node. No run had a microphone or screen stall, packet loss, a pacer drop, a receive-buffer error or an admission refusal. The only camera stalls were the 6-person runs' paused cameras below.

| Shape                                 | Node              | Reserved         | In pps | Out pps | Own CPU mean (p95) | Steal mean (p99) | RSS max | Repair sent |
| ------------------------------------- | ----------------- | ---------------- | ------ | ------- | ------------------ | ---------------- | ------- | ----------- |
| 3-person class, 2 cameras each        | 2 vCPU, 5 classes | 35,850 of 36,000 | 13,249 | 20,459  | 27.7% (29.5%)      | 10.5% (30.1%)    | 120 MiB | 1,225       |
| 3-person class, 2 cameras each        | 1 vCPU, 3 classes | 21,510 of 22,000 | 7,934  | 12,260  | 31.8% (33.5%)      | 6.4% (23.3%)     | 85 MiB  | 962         |
| 6-person, 2 cameras each              | 2 vCPU            | 11,520 of 36,000 | 5,425  | 5,942   | 15.1% (16.7%)      | 5.9% (25.7%)     | 77 MiB  | 220         |
| 6-person, 2 cameras each              | 1 vCPU            | 11,520 of 22,000 | 5,361  | 5,874   | 23.8% (27.0%)      | 3.6% (16.4%)     | 73 MiB  | 201         |
| 10-person, 1 camera each, small tiles | 2 vCPU            | 35,800 of 36,000 | 5,147  | 16,699  | 21.0% (23.2%)      | 10.1% (32.0%)    | 85 MiB  | 759         |
| 10-person, 1 camera each, small tiles | 1 vCPU            | 22,000 of 22,000 | 5,181  | 16,778  | 35.0% (37.6%)      | 6.8% (24.0%)     | 84 MiB  | 691         |

- Class runs: every subscriber received the top camera layer, with node-reported traffic of 33,556 packets/s (2 vCPU) and 20,060 (1 vCPU) against the reservation, and a pacer queue of 0 ms at the median and p95, with a 50 ms sample in the p99 of each run. On 1 vCPU, 3 classes cost 31.8% of the vCPU, which matches the model's 11% a class. On 2 vCPU, 5 classes cost 0.55 of a vCPU.
- 6-person runs: this shape reaches the 11,520 per-Episode ceiling. The allocator forwarded every camera at the low layer and paused 20 of the 60 camera subscriptions for congestion for the whole run, so cameras the viewers asked for at the top layer were not delivered; audio and the screen share were clean. The same happened on both sizes, so it is the ceiling, not the node.
- 10-person runs (the rare call, one camera each, every viewer asking for the low layer but one featured Participant's): all 90 camera subscriptions were forwarded (10 at the top layer, 80 at the low layer) and none was paused. The call reserves nearly the whole node, 35,800 of 36,000 on 2 vCPU and all 22,000 on 1 vCPU, so no other Episode is admitted while it runs. It used 20,400 packets/s on both sizes. On 1 vCPU it cost 35% of the vCPU, as much as 3 classes.
- Generators were not the limit: their worst timer lateness was 80.9 ms (primary classes run) and under 10 ms in the other runs, with no missed tick.

## Decision

The sizing model targets demand over available CPU at about 65% or below using
52% steal. This is a model assumption, not an upper bound: soak C's maximum is 68%.
The model gives 3 classes on 1 vCPU (32% / 48% = 66%) and 5 on 2 vCPU (62%). The 4 classes
that stalled on 1 vCPU would sit at 88%. Production's guard of 40% closes admission
before steal reaches the range where 5 classes would reach 75%; staging keeps 25% so
the guard is easy to exercise there. The guard stops new Episodes only, so running
calls ride out a burst on the headroom above.

## Not proved

- The five-hour, three-class staging soak at budget 22,000 remains unproved. Its capacity figure comes from the model above.
- Production's five-class, three-hour result is proved only at the measured traffic below 36,000 packets/s. Capacity above 15 participants, toward the 36,000 packet budget, remains unproved.
- The soak C summary does not establish the requested 40% production guard setting or paired 10 s steal and own-CPU samples.
- The 06:47Z event is unexplained by steal.
- The per-SKU bench ran each shape for 10 to 15 minutes, off the Pakistan and Dubai evening peak, with one shape at a time on each node. Capture cost was not measured (see the M10 capture reports), and the 16- and 20-person Episodes belong to the capacity run on the production-size node.
- Reservations stay at the M2 costs. The 2 vCPU figure holds for the class shape above, not for other mixes.

## Soak acceptance

Soak C meets the production duration (at least 3 hours), class count (5) and
no-microphone-stall-over-500-ms criteria. Production acceptance is partial: the
40% guard setting and paired 10 s steal and own-CPU samples still need evidence.
The run does not prove sustained throughput at 36,000 packets/s or staging capacity.

The SFU lead owns the production canary on the production node under the existing
bench/canary rules. Its guard-setting and paired CPU/steal evidence must meet the
independent [M12 package 4 entry condition](milestones.md#package-4-entry-condition)
before cutover, not M12's post-cutover checks. Production serves no `chalk_sfu` users yet.

For the separate staging proof, run `TestLiveSmokeClasses` for 5 hours at 3 classes (budget 22,000),
covering the :00 and :30 marks, and require no microphone stall over 500 ms.
Record 10 s steal and own CPU. If M11 needs capacity above 15 participants toward
36,000 packets/s, measure it on the shared production node under the bench rules:
short-lived bench droplets, at most USD 1, delete by ID.
