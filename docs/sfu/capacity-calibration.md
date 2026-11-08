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
a model fitted to the runs below. No run has yet held a node at its new budget for hours.

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

## Decision

Keep demand over available CPU at about 65% or below at the worst steal seen (52%).
That gives 3 classes on 1 vCPU (32% / 48% = 66%) and 5 on 2 vCPU (62%). The 4 classes
that stalled on 1 vCPU would sit at 88%. Production's guard of 40% closes admission
before steal reaches the range where 5 classes would reach 75%; staging keeps 25% so
the guard is easy to exercise there. The guard stops new Episodes only, so running
calls ride out a burst on the headroom above.

## Not proved

- No soak has run at 22,000 on staging or at 36,000 on production. The 3 and 5 class figures come from the model above.
- Production was measured for 25 minutes, so its steal tails over hours are unknown. The staging tails came after the first hour.
- The 06:47Z event is unexplained by steal.
- Reservations stay at the M2 costs. The 2 vCPU figure holds for the class shape above, not for other mixes.

## Next soak

Run `TestLiveSmokeClasses` for 5 hours on staging at 3 classes (budget 22,000), covering the :00 and :30 marks, and require no microphone stall over 500 ms. Run the same on production at 5 classes (budget 36,000) for at least 3 hours with the 40% guard. Record 10 s steal and own CPU for both. If staging passes, the model holds for 1 vCPU and the production run confirms the 2 vCPU figure.
