# Capture capacity large-10 — BLOCKED before paid load

## Retry outcome (2026-10-25)

The single authorized retry did not pass its free publisher preflight. Instabox inventory and SSH were healthy. A first-pair diagnostic on a prepared 4-vCPU/8-GB guest created one Space/Episode and two participants, then timed out after 120 seconds waiting for live camera/voice sources. Both clients reported `connection.media_recovery_exhausted`, reconnecting, healthy sync and closed peer/ICE connections. The second pair never started. No Recording or paid worker was created, and no 12-slot attempt occurred.

This reproduces failure **before** testing whether a guest can hold five pairs. It is not evidence of guest saturation or a Capture-node capacity limit. Nightly's local/remote track requests returned upstream HTTP 200 with no missing tracks; both remote responses required immediate renegotiation. The captured excerpt does not establish why media failed. The later403/410 responses followed Episode end and are not taken as its cause. An Instabox 502 outage does not explain this retry: inventory, SSH and evidence collection succeeded. A separate underlying media connectivity/negotiation issue remains unresolved. Per the lead's stop rule, there was no paid run and no further preflight.

Five free guests were prepared to spread 20 publishers over five guests (two pairs per guest), but only the diagnostic first guest ran before this gate failed. Other guests' capacity therefore remains unproved. This does not claim that the original502 incident and this retry have the same root cause.

## Ten-slot measurement and finalization

| Node | Intended Recordings / cameras | Peak / mean CPU over allocated cores | Peak RSS / host steal | Result |
|---|---|---|---|---|
| s-2vcpu-2gb |10 /20;0 created |Not measured |Not measured |BLOCKED at free publisher preflight |

| Intended Recording | Final state | Capture succeeded | v2 complete | Render finished | Playable |
|---|---|---|---|---|---|
|1|Not created|N/A|N/A|N/A|N/A|
|2|Not created|N/A|N/A|N/A|N/A|
|3|Not created|N/A|N/A|N/A|N/A|
|4|Not created|N/A|N/A|N/A|N/A|
|5|Not created|N/A|N/A|N/A|N/A|
|6|Not created|N/A|N/A|N/A|N/A|
|7|Not created|N/A|N/A|N/A|N/A|
|8|Not created|N/A|N/A|N/A|N/A|
|9|Not created|N/A|N/A|N/A|N/A|
|10|Not created|N/A|N/A|N/A|N/A|

**Finalization 0/10 intended; 0 Recordings actually created.** Per-camera drops/frozen frames, layer resolution/fps, CPU limitation reasons, bundle holes and NIC drops/errors for the ten-slot window are unavailable, not zero. No end-to-end Capture→v2→Render→playable output is claimed.

## Source, Cut hold and build

Fetched before resuming. Isolated source checkout: `6c4a9edbb015c45bd424647e5067c74863f12a2f`, including the requested admission-close behaviour. Built Capture and boot-probe on free Linux Instabox using Go 1.26.10; no binary installed on a paid node.

The release lead's manual Cut nightly run 40166515872 began 05:42:41Z. At the urgent hold message the free generator had completed and no DO droplet existed; this was reported immediately, including the remaining idle guests. An explicit release-hold file prevented subsequent preflight, paid setup and nightly mutations. No workflow dispatch, cancel or rerun occurred. No task API/service restart, SSM write or runtime flag edit occurred. The existing failed deployment guard was not touched.

The lead subsequently instructed **skip the post-Cut rebuild**, perform one read-only network/history diagnostic, delete the last guest and finish BLOCKED. The waiting finalizer was stopped before it performed any post-Cut SSM read or build. No post-Cut build is claimed. The local release hold remains; its watcher is stopped.

## Harness fixes and proof

The original single operations judge returned FIX. Its seven findings were addressed in the retry scripts; **no second judge round** was run, as directed. Details: `capture-capacity-large10-evidence/retry1/fix-proof-map.md`.

- Budget-derived paid finish and stop-new-load deadlines reserve 20 minutes for finalization and $0.06 for cleanup; guardian and task worker lifetime enforce the bounded lifetime. Ledger entries begin before provider creation, retain minimum charges, and reconcile timed-out creates by unique ownership tag.
- Runner starts independent owner-loss guardian; stop/SSH exceptions cannot skip independent cleanup actions. Isolated DO deletion proceeds even if shared-host revocation is blocked by Cut. Deferred revocation is explicit cleanup failure, not a false clean result. Cleanup errors exit nonzero and do not mark completion.
- Remote mutation uses nonblocking deployment lock plus expiry before and under lock, controller/readiness revalidation and a last expiry check; pending SSM commands are cancelled on timeout/signals.
- Generator stops during admission/readiness, before each Recording start and after guard responses. Launcher never clears a stop after a failure. Bundle proof requires complete v2 sequence and measured-span coverage; hole/gap metadata is reported separately from sequence completeness.

The local commit hook reported `lefthook` unavailable; no full repository gate or CI qualification is claimed. Only the targeted proofs below ran.

Cheap proof results: **9/9 Linux safety tests, 3/3 injected integration cases, 2/2 generator stop cases passed.** The Linux lock test actually held a busy lock and showed no queued mutation. Owner-loss/deadline tests ran the actual independent watchdog process with injected cleanup markers. Integration checks extract actual provision/delete/finalizer functions and inject failures. These are not live cloud owner-loss/finalization proofs. The paid harness was never exercised, so no live operating qualification is asserted.

## Spend ledger

| Item | Actual incremental USD |
|---|---:|
| Capture DO allocation |0.00000|
| Render DO allocation |0.00000|
| Other DO resources |0.00000|
| Free Instabox |0.00000|
| **Round total** |**0.00000**|
| Hard cap / remaining |0.25000 /0.25000|
| Prior task estimate |1.52812|
| **New task estimate** |**1.52812**|

No paid next step was taken. Finalization was not sacrificed to meet the cap: no Recording was started. The paid window was cut entirely because the mandatory free gate failed, not to conceal cost. Prior task spend remains a conservative estimate, not a new invoice reconciliation.

## Recommendation

| Recordings | Peak CPU | Mean CPU | Peak RSS MiB | Capture-only allocated slot-month |
|---:|---:|---:|---:|---:|
|4|30.47%|15.60%|164.51|$4.50|
|6|41.96%|22.13%|199.58|$3.00|
|8|54.92%|29.34%|216.06|$2.25|
|10|Not measured|Not measured|Not measured|$1.80 hypothetical|

Prior rows are single 120-second windows, not repeated qualification; earlier large-node host steal was 11.93–21.36%. Earlier Capture/transcription success is **not** proof of Render/playable finalization (the old export-none shortcut was insufficient). Raw v2 gap/coverage metadata existed in those rows; see the earlier rerun report for detail.

Keep **SLOTS_PER_NODE=6** as the capacity recommendation:18.04 percentage points below the 60% peak ceiling versus only 5.08 at8, with room for noise/steal. The roughly6-points-per-Recording trend projects10 near 67%, not a measurement. This absent ten row **does not change six** and supplies no new frame-quality or finalization evidence. Live DO size API receipt (`retry1/size-price.json`, 06:03:22Z) confirms the Capture node price basis is $18/month; costs exclude Render, storage, transfer and unused capacity. Six costs 33.3% more per allocated slot than eight for that headroom.

For positive integer N=MAX_NODES, once six slots are qualified and permitted, recommend **CHALK_RECORDING_ADMISSION_CAP=min(20,6×N)** (N=1 → 6, N=2 → 12, N=3 → 18, N≥4 → 20). This satisfies cap≤MAX_NODES×SLOTS_PER_NODE and the independent 1..20 cap range. Current runtime validation still separately requires slots 1; until that policy is changed, retain slots 1 and cap≤min(20,N). No deployment config was changed.

## Cleanup evidence and limits

Retry read-only DB proof: 1/1 Space archived, 1/1 Episode ended, 0 Recordings (`retry1/cleanup-db.sql.log`). Browser finalizers passed; raw guest evidence is complete for the failed pair. DO inventory shows no task droplet/firewall/key/tag (`retry1/do-final-absence.json`); no fleet registration ever ran. No runtime flag was applied, no host mTLS copy or task SSH key created. DB forward is terminated after the read.

All **5/5 retry guests are absent** in final provider inventory at 06:07:33Z (`retry1/guest-final-absence.json`); the last deletion succeeded. Local generator, guard, finalizer, watcher, SSH and forward processes are stopped. No flag was applied in this retry; the earlier direct flag-absence proof predates Cut, so it is not presented as proof of current post-Cut state. The lead barred further nightly access, so no fresh runtime read was made after the final instruction. Raw Space/Episode identifiers, browser evidence and SSM logs remain local and must not be committed. Sanitized source/proof/report handoff only goes to the public repository.

## Resume condition

This authorized retry is exhausted. A new attempt needs a diagnosed/fixed publisher-media connection failure and a new authorized preflight; do not automatically resume paid load after Cut. No second harness judge is requested. This report is operational evidence, not a product code change or deployed slot recommendation.

Picked up from **Capture capacity rerun on binary bundles**, the delegated 2026-10-24 capacity rerun thread. First-attempt report retained privately in the evidence directory.


## Read-only network and media diagnosis

**Most likely cause category: unknown.** A blanket Instabox UDP/egress failure is not supported by the successful probe; no checked Chalk media source change explains the regression. Destination-specific SFU egress, transient provider/session behaviour and harness signalling/guard latency remain possibilities, not diagnoses. This check was on the last retained guest, not the already-deleted failing-pair guest, and STUN 3478 is not SFU 141.101.90.0:1473. It cannot conclusively separate those possibilities.

### Guest UDP/TCP and changed egress

At06:06:10Z, `stun.cloudflare.com` resolved to 162.159.207.0. A UDP STUN binding request returned success type 0x0101, valid cookie and matching transaction ID, with XOR-MAPPED-ADDRESS **18.236.77.160:36171** in 0.005s. HTTPS egress discovery returned the same IP. TCP 3478 timed out after 4.003s; no mapped address returned. No TCP control success or generic TCP policy conclusion is claimed. Receipt: `retry1/stun-check.json`; reproducible free probe: `retry1/stun-check.py`.

Today: eth0 private 172.16.0.2/30, gateway 172.16.0.1; IPv6 `2600:1f14:34cf:7b61:7c94::117/128`; DNS 1.1.1.1 and 8.8.8.8; kernel 6.18.54-instabox. Yesterday's saved passing connectivity snapshot at 16:30Z had local private 172.16.0.2, public srflx **35.93.162.163**, IPv6 `2600:1f14:34cf:7b26:ae70::15e`, and connected UDP candidate pairs to **the same SFU 141.101.90.0:1473**. Thus public egress/IPv6 allocation changed while the private subnet shape and SFU address match. Yesterday's route/DNS/kernel and 17:43 guest egress were not captured; no unchanged-network assertion is made. Evidence: `retry1/yesterday-network-summary.json`, derived from the earlier `r5/fast-guard-connectivity.json`.

### Exact ICE evidence and missing history

Both publishers have these exact saved lines (the raw ID-bearing `connectivity.json` stays private):

```json
"code": "connection.media_recovery_exhausted",
"message": "Connection interrupted. Reconnecting in the background."
"connection": "closed",
"ice": "closed",
"gathering": "complete",
"a=candidate:513273236 1 udp 2130706431 141.101.90.0 1473 typ host generation 0",
"a=candidate:513273236 2 udp 2130706431 141.101.90.0 1473 typ host generation 0"
"stats": []
```

These are final snapshots, **not ICE state history**. No earlier checking/failed/disconnected transition, local candidate list, selected pair, `icecandidateerror`, DTLS state or DTLS error was preserved. Only remote UDP host candidates are observed; no remote srflx/relay candidate appears. Local host/srflx/relay gathering and whether any relay ever existed **cannot be reconstructed**. The last recorded error is the application media-recovery code above, not a transport-specific ICE/DTLS reason. Do not read empty post-close stats as proof that no candidates were ever gathered.

### Nightly source and relevant history

The preflight API logs at 05:39Z identify nightly as `managed-episode-20261025T012058Z-1dec57e4-9309793c`, source **1dec57e48a806f15cc70f14948be34b20bba5170** (same running API observed before 05:38). This is **not** the 6c4a9edbb worker/harness source or the in-progress Cut's eventual deployment. Yesterday's passing 17:43 window used API image digest `d062b070c107cf964deccc4898a939c9299dc7d241297ca97f01139d7e8df6c8`; the saved identity maps it to **ef3ae755f2af29f64acd719d5b27edc2b4509138**, release `managed-episode-20261024T110234Z-ef3ae755-68cbcc54`. Later 8b2a929b deployment must not be substituted for that passing window.

There are 18 commits in ef3ae755f..1dec57e4 overall. `git log` and `git diff --stat` over client media/connection, API Cloudflare SFU adapter, providerbridge, SFU signalling, media-plane providers, checked config and managed deployment paths are **empty**. Client media/connection also has no diff between yesterday's 46bfd6ef harness source and today's 6c4a9edbb source. Receipts: `retry1/media-path-git-log.txt`, `retry1/media-path-diff-stat.txt`, `retry1/runtime-commit-range.txt`. This is scoped path evidence, not proof that every other change is irrelevant.

The checked SDK creates `iceServers: [{ urls: bootstrap.stunServer }]`; API SFU adapter supplies `stun:stun.cloudflare.com:3478`. There is **no TURN server configured in this path**, so a relay fallback is not expected from that code on either day. Source history shows no media/ICE/TURN/SFU configuration-code change in those paths. Runtime secret/provider-side configuration differences were not captured and were not queried under the no-nightly-touch instruction.

No paid run, Recording or nightly interaction was started for these diagnostics. Only the free guest network probe and local saved-evidence/git reads ran; the guest was then deleted.
