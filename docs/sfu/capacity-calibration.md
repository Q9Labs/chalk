# SFU packet budget calibration

Why the SFU nodes admit as many Episodes as they do. `infrastructure/sfu/deploy` renders the values
(`SFU_PACKET_BUDGET`, `SFU_GUARD_MAX_STEAL_PERCENT`); read them there, not here.

## Decision

A shared vCPU gives steady own CPU and bursty host steal. Media stalls when our demand
approaches what steal leaves, so the budget must hold for the worst burst, not the average.
The sizing model is `own / (1 - steal)`, kept at about 65% or below with 52% steal. That is
a model assumption, not an upper bound: the production soak saw 68% steal at its maximum.

- A 1 vCPU node ($6, staging) admits 3 three-person classes. Own CPU is about 11% of a vCPU per class. Four classes there reached 88% and stalled.
- A 2 vCPU node ($18, production) admits 5 three-person classes. Own CPU grows about 5% of the node per class.
- Staging stalled once demand over available CPU passed about 75%. Production ran clean at 9 classes with the guard at 50% (60%), and stalled at 10.
- Production's steal guard (40%) closes admission before steal reaches the range where 5 classes would hit 75%. Staging keeps 25% so the guard is easy to exercise. The guard stops new Episodes only, so running calls ride out a burst on the headroom.
- A single Episode is capped at 11,520 reserved packets/s. At that ceiling the allocator pauses cameras for congestion rather than dropping audio or screen share. A 10-person call with one camera each reserves nearly a whole node, so nothing else is admitted while it runs.

Failures worth remembering:

- Stalls on the 1 vCPU node at four classes sat on the :00 and :30 marks, where steal reached 45 to 52% for 10 to 20 s. A one-hour soak misses these tails, so soaks must span those marks.
- One microphone stall event (24 microphones, 3.3 s) is not explained by steal. Samples every 10 s cannot rule out a shorter burst.

**Second node trigger.** One production node carries 5 classes of 3 guests (soak) and 2 classes of 6 guests (derived). Alert and ask the SFU lead for a second node when the evening peak passes 3 concurrent 3-guest classes or the first 6-guest class appears.

## Not proved

- The five-hour, three-class staging soak has one pass and one fail. The failing run stalled in its first minute, when steal spiked to 54% and own CPU reached 59%. A start-up ramp or the spike could explain it, so the staging capacity comes from the model, not from a passing soak.
- Production is proved only for five classes over three hours at about 33,700 packets/s, below the 36,000 budget. Sustained traffic at the budget is unproved.
- That soak kept steal and own CPU as separate aggregates, never paired. Without pairs nobody can say whether five classes stayed under 75% inside the bursts.
- The per-SKU bench ran each shape for 10 to 15 minutes, off the Pakistan and Dubai evening peak. It did not measure capture cost.

## Soak acceptance

The production canary runs three hours at five classes on the production node. It must record paired 10 s steal and own-CPU samples, which costs nothing extra, and re-read the deployed guard setting at its start, because a redeploy could change it.

The staging proof runs `TestLiveSmokeClasses` for 5 hours at 3 classes (budget 22,000), covers the :00 and :30 marks and allows no microphone stall over 500 ms. The test fails a run that breaks the stall rule, reports another budget, or lacks the marks or the node's 10 s capture. The [SFU README](../../features/media/sfu/README.md#tests) has the command.

Capacity tests on the production node use short-lived bench droplets: at most USD 1, deleted by ID.
