> **Plan, not authority.** This is one of our plans. It may be stale or wrong, and code, contracts and checks win wherever they disagree. Verify any claim here against code before relying on it.

# SFU packet budget calibration

Why the SFU nodes admit as many Episodes as they do. The values (packet budget and steal limit per node
size) live in `features/media/sfu/internal/config/node.json`; read them there, not here.

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


## 2026-11-25 re-calibration for recorded classes

The bench re-measured capacity with the recorder capture shape included: three participants, one
screen share, and one capture session pulling every microphone, camera and screen. One such class
reserves 9,330 packets/s (7,170 unrecorded plus 2,160 of capture pulls). Forwarding cost is not
linear in class count: fixed node overhead dominates at low counts (1 class reads 22% of a vCPU on a
2 vCPU node) while the marginal class at high count costs less, so the sizing model is applied to
measured per-level totals, not a per-vCPU rate. The steal-hardened admission lines measured on three
sizes (and reproduced within 1-2% across independent benches): `s-2vcpu-2gb` admits 4 recorded
classes at 37,320 (30% own CPU, 62% utilization-of-available at 52% steal), `s-4vcpu-8gb` 9 at
83,970 (exactly the 65% target), `s-8vcpu-16gb` 19 at 177,270 - the last capped by measurement, not
the model, because the bench never proved 20 clean. Note what the old budget meant in practice:
36,000 never admitted a fourth recorded class (4 x 9,330 = 37,320), so an all-recorded node carried
3, not the assumed 4; raising the small-node budget to 37,320 makes admission consistent with the
window controller's hard-coded SlotsPerNode of 4. Clean-bench ceilings without steal run far higher -
8 proven on 2 vCPUs, 16 proven on the premium AMD variant of the same shape, 13 proven on 4 vCPUs,
19 on 8 - but those counts sit at 78-138% utilization-of-available in a worst-case burst, squarely
in the stall zone this document sizes against. The clearest demonstration came from the bench
itself: a 2 vCPU node holding 12 classes at 62-66% own CPU stalled inside a 10-second host steal
burst of 7-18%, exactly when utilization-of-available crossed the 75% onset. Evidence and analysis: the 2026-11-25 droplet-size
frontier bench report; the capture worker's own decode/encode CPU is outside the SFU measurement.

## Not proved

- The five-hour, three-class staging soak has one pass and one fail. The failing run stalled in its first minute, when steal spiked to 54% and own CPU reached 59%. A start-up ramp or the spike could explain it, so the staging capacity comes from the model, not from a passing soak.
- Production is proved only for five classes over three hours at about 33,700 packets/s, below the 36,000 budget. Sustained traffic at the budget is unproved.
- That soak kept steal and own CPU as separate aggregates, never paired. Without pairs nobody can say whether five classes stayed under 75% inside the bursts.
- The per-SKU bench ran each shape for 10 to 15 minutes, off the Pakistan and Dubai evening peak. It did not measure capture cost.

## Soak acceptance

The production canary runs three hours at five classes on the production node. It must record paired 10 s steal and own-CPU samples, which costs nothing extra, and re-read the deployed guard setting at its start, because a redeploy could change it.

The staging proof runs `TestLiveSmokeClasses` for 5 hours at 3 classes (budget 22,000), covers the :00 and :30 marks and allows no microphone stall over 500 ms. The test fails a run that breaks the stall rule, reports another budget, or lacks the marks or the node's 10 s capture. The [SFU README](../../features/media/sfu/README.md#tests) has the command.

Capacity tests on the production node use short-lived bench droplets: at most USD 1, deleted by ID.
