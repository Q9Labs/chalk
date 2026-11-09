# SFU packet budget calibration

This is the reviewed calibration that [M6](milestones.md) requires before the node
budgets leave the initial 16,000 and 32,000. It sets what `deploy/deploy` renders as
`SFU_PACKET_BUDGET` and `SFU_GUARD_MAX_STEAL_PERCENT`.

| Node                           | `SFU_PACKET_BUDGET` | Three-person classes admitted | Steal guard for new Episodes |
| ------------------------------ | ------------------- | ----------------------------- | ---------------------------- |
| Production `s-2vcpu-2gb` ($18) | 36,000              | 5 (35,850 reserved)           | 40%                          |
| Staging `s-1vcpu-1gb` ($6)     | 22,000              | 3 (21,510 reserved)           | 25%                          |

## Deployed values

`deploy/deploy` picks the budget from the node's vCPU count (22,000 on 1, 36,000 on 2, an error on any other size) and the steal guard from the environment (40% in production, 25% elsewhere). It writes them into the node's `sfu.env`, so a redeploy cannot drift from this table. On 9 November 2026 the staging and production nodes were read, read-only over the operator SSH key, and both matched:

| Node       | vCPUs | `SFU_PACKET_BUDGET` | `SFU_GUARD_MAX_STEAL_PERCENT` | `GOMEMLIMIT` | Container `--memory` |
| ---------- | ----- | ------------------- | ----------------------------- | ------------ | -------------------- |
| Production | 2     | 36,000              | 40                            | 768 MiB      | 1400m                |
| Staging    | 1     | 22,000              | 25                            | 384 MiB      | 700m                 |

To check again, read the same four keys from `~/.config/chalk-sfu/sfu.env` of the `chalk-sfu` user on the node (`SFU_PACKET_BUDGET`, `SFU_GUARD_MAX_STEAL_PERCENT`, `GOMEMLIMIT`, `SFU_UDP_RECEIVE_BUFFER`). The code default of 16,000 in `internal/config` applies only when the variable is unset, which no deployed node does.

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
- The soak C summary does not hold paired 10 s steal and own-CPU samples. Its 40% guard setting is now confirmed from the node (see Deployed values).
- The 06:47Z event is unexplained by steal.
- Reservations stay at the M2 costs. The 2 vCPU figure holds for the class shape above, not for other mixes.

## Soak acceptance

Soak C meets the production duration (at least 3 hours), class count (5) and
no-microphone-stall-over-500-ms criteria. Production acceptance is partial: paired 10 s steal and own-CPU samples still need evidence.
The run does not prove sustained throughput at 36,000 packets/s or staging capacity.

**What the canary still needs.** The 40% guard setting no longer needs a run: the node's environment shows it, and the canary only reads it again at the start as a one-line check, because a redeploy could change it. Paired 10 s steal and own-CPU samples are genuinely needed. The whole sizing model is the ratio `own / (1 - steal)` against the 75% level where staging stalled, and soak C kept only separate aggregates (own CPU never paired with steal, steal p99 36%, maximum 68%), so nobody can say whether five classes stayed under 75% in the bursts. Only paired samples answer that, and the canary already runs three hours at five classes, so it costs nothing extra to record them.

The SFU lead owns the production canary on the production node under the existing
bench/canary rules. Its guard-setting and paired CPU/steal evidence must meet the
independent [M12 package 4 entry condition](milestones.md#package-4-entry-condition)
before cutover, not M12's post-cutover checks. Production serves no `chalk_sfu` users yet.

For the separate staging proof, run `TestLiveSmokeClasses` for 5 hours at 3 classes (budget 22,000),
covering the :00 and :30 marks, and require no microphone stall over 500 ms.
Record 10 s steal and own CPU. The test fails a run that breaks the stall rule, reports another budget
or lacks the marks or the node's 10 s capture, and writes the numbers to a JSON result file; the
[SFU README](../../features/media/sfu/README.md#tests) has the command. If M11 needs capacity above 15 participants toward
36,000 packets/s, measure it on the shared production node under the bench rules:
short-lived bench droplets, at most USD 1, delete by ID.
