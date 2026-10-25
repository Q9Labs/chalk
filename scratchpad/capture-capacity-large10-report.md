# Capture capacity large-10 — BLOCKED before paid load

## Outcome and blocker

The bounded free guest preflight did not pass: it timed out after 120 seconds waiting for two live camera/voice publishers. Collection then lost SSH, and the Instabox inventory/deletion-by-name endpoints returned HTTP 502. Only the first pair on each guest reached Space/Episode creation; no Recording was started. The cause is not established as generator CPU saturation or a Capture-node limit. There is no ten-slot capacity result. No 12-slot attempt occurred.

The fresh Sol xhigh operations review independently returned **FIX** for the staged paid harness, including unenforced owner-loss/budget deadlines, incomplete cleanup on exceptions, creation-intent reconciliation and delayed SSM mutations. No paid run was launched. The staged `run.py` is deliberately disabled, with findings in `capture-capacity-large10-evidence/judge-r1.md`. These are retained as failure evidence, not approved runnable tooling. Since the harness could not enforce the $0.25 ceiling safely, the next paid step was not attempted.

## Worker source and build

Fetched origin before any work. Built current-master **1802a2fc5cb60d67556602f2dc14fa03b6b9e33f** (#511 included) on a free Instabox guest, after explicitly selecting required Go 1.26.10 (snapshot Go 1.26.9 with GOTOOLCHAIN=local rejected the first build). The initial builder became ready after 209 seconds. All four guests were eventually prepared within the ten-minute allocation bound.

Capture binary SHA256: `7cdff34d3546974d017d8e5749e59845ca85fc1f4810cad73437e446bb7f8a90`.
Boot-probe SHA256: `f99428d32d995ebc96babdb4cbb11bc2a0c373cb3ee59fd08fa765b9b8e1b73a`.
The downloaded archive was extracted locally and both hashes matched. Evidence: `source.json`, `build.log`, `build-toolchain.log`, `worker.tar.gz` under the evidence directory. **No binary was installed on a DO node.** The isolated build checkout, not the dirty root checkout, supplied the source. The judge covered local scripts, not this binary build or CI.

## Ten-slot row and finalization

| Node | Recordings/cameras | Peak / mean CPU over allocated cores | Peak RSS / host steal | Result |
|---|---|---|---|---|
| s-2vcpu-2gb | 10 / 20 intended; 0 created | Not measured | Not measured | BLOCKED: free publisher preflight failed |

| Intended Recording | Final state | Capture | Complete v2 bundles | Render | Playable |
|---|---|---|---|---|---|
| 1 | Not created | N/A | N/A | N/A | N/A |
| 2 | Not created | N/A | N/A | N/A | N/A |
| 3 | Not created | N/A | N/A | N/A | N/A |
| 4 | Not created | N/A | N/A | N/A | N/A |
| 5 | Not created | N/A | N/A | N/A | N/A |
| 6 | Not created | N/A | N/A | N/A | N/A |
| 7 | Not created | N/A | N/A | N/A | N/A |
| 8 | Not created | N/A | N/A | N/A | N/A |
| 9 | Not created | N/A | N/A | N/A | N/A |
| 10 | Not created | N/A | N/A | N/A | N/A |

Finalization: **0/10 intended**, denominator **0 actually created**. No dropped/frozen frames, per-camera layers/fps, CPU-limitation reasons, coverage holes, NIC drops/errors or end-to-end output can be measured for a window that never ran. None is reported as zero.

## Nightly safety

No production SSM, host, API or workflow was accessed. No workflow was dispatched, cancelled or rerun. No SSM parameter write, runtime flag edit, shared-service stop/restart, fleet publication, deployment-guard change or DO create occurred. Normal nightly API mutations were limited to free guest preflight Spaces/Episodes/participant admission and their cleanup.

Read-only SSM checks observed the deployment controller idle, readyz=200, API start time 2026-10-25T01:29:25.100566084Z and no loaded v2 flag. Capture remained MAX_NODES=1/SLOTS_PER_NODE=1/size c-2; Render MAX_NODES=1/size c-8. The API had no explicit admission cap. Final cleanup guard evidence is `cleanup-final-guard.json`; config receipts are in `nightly-config-receipt.json`. The prior round's failed transient deployment guard was left untouched.

## Spend ledger

| Item | This round USD |
|---|---:|
| DigitalOcean Capture | 0.00 |
| DigitalOcean Render | 0.00 |
| Other DO resources | 0.00 |
| Four free Instabox guests | 0.00 |
| **Total actual incremental DO spend** | **0.00** |

Hard cap **$0.25**, fully unspent. New task total remains the prior **$1.52812 conservative estimate**; that historical amount is not invoice-verified. No finalization was traded away to save money: no Recordings existed. What was cut: the paid ten-slot window and its Render/playability experiment, because generator qualification failed and the paid harness review did not clear safety/budget blockers.

The live DO sizes API quotes s-2vcpu-2gb at $18/month ($0.02679/hour), and c-8 Render at $168/month ($0.25/hour). Raw public pricing response: `do-sizes.json`. No Render charge is missing from this round: no export or Recording was created. The earlier harness accepted `export.status=none`; this is not Render/playability proof. The staged replacement added explicit export requests, Render-ready checks, metadata and short media decode checks, but was never executed and remains unapproved.

## Recommendation (provisional; no ten-slot evidence)

Earlier rows are from `capture-capacity-v2-rerun-report.md` and its accepted-results evidence, not repeated measurements:

| Slots | Peak CPU | Mean CPU | Peak RSS MiB | $/allocated slot-month at $18/node-month |
|---:|---:|---:|---:|---:|
| 4 | 30.47% | 15.60% | 164.51 | 4.50 |
| 6 | 41.96% | 22.13% | 199.58 | 3.00 |
| 8 | 54.92% | 29.34% | 216.06 | 2.25 |
| 10 | Unmeasured | Unmeasured | Unmeasured | 1.80 hypothetical |

Recommend **SLOTS_PER_NODE=6** for eventual s-2vcpu-2gb qualification. Six leaves 18.04 percentage points below the experiment's 60% peak threshold; eight leaves only 5.08. Prior large windows saw peak host steal of 11.93–21.36%, so one 120-second eight-slot pass is insufficient noise/steal margin. Six is a conservative operational choice, not a proven all-workload bound. Eight remains the largest observed passing count. Ten must not be recommended from extrapolation.

For a positive integer **N=MAX_NODES**, recommend explicit **CHALK_RECORDING_ADMISSION_CAP=min(20, 6×N)** once six-slot configuration is qualified and accepted by runtime validation (N=1 → 6; N=2 → 12; N=3 → 18; N≥4 → 20). This satisfies cap ≤ MAX_NODES×SLOTS_PER_NODE and the current validator's separate 1..20 cap range. Cost excludes Render, storage, transfer and idle/partial utilization; six costs 33.3% more per allocated slot than eight in exchange for headroom.

**Not deployable unchanged today:** current-master `infrastructure/managed-episode/scripts/validate-runtime` still requires SLOTS_PER_NODE=1 separately, alongside the new cap invariant. Until that qualification/policy constraint is changed, preserve one slot and set cap ≤ min(20,N). No configuration was changed by this task.

## Cleanup proof and evidence limits

- DB directly confirms **4/4 preflight Spaces archived, 4/4 Episodes ended, zero Recordings**. Summary: `task-app-clean-summary.json`; raw ID-bearing read: `task-spaces.sql.log` (private, not committed).
- No task DO droplet, firewall, SSH key or tag exists: `do-final-absence.json`. No fleet row was created because no bootstrap, registration or worker operation ran.
- Instabox deletion: see `guest-final-absence.json` and `guest-id-deletion.json`. Name-based deletion first failed with HTTP 502; deletion by known owned ID was accepted. Only task-owned guests were targeted. Final state is summarized in `cleanup.json`.
- The task DB SSM forward is **Terminated**, directly checked in session history: `ssm-forward-cleanup.json`. All read-only SSM commands completed. No local generator, guard pump, SSH session, forward or build launcher remains; final process proof is in `cleanup.json`.
- No runtime flag was applied, so none needed removal. A final direct read proved no flag in the runtime file, container configuration or API process environment, with unchanged API start time: `final-flag-proof.json`. No task-generated local SSH key existed. The temporary detached build checkout was removed after the report handoff was persisted.

The failed publisher preflight and lost collection do **not** establish zero frozen/dropped frames, zero CPU limitation, a guest-capacity pass, or complete raw guest evidence. Those reads were unavailable during the provider outage. The resource/Recording cleanup state was recovered independently through nightly DB, DO inventory, Instabox inventory and SSM session history. Raw evidence may contain Space IDs and is retained locally only.

## Resume condition

A future paid attempt needs (1) a passing, free guest publisher/layer/CPU preflight and (2) hardening of the staged paid harness with a fresh scoped SHIP judgment, including budget-derived deadlines, intent reconciliation, race-safe remote mutation expiry and exception/owner-loss cleanup. Rebuild current master and freshly check Release/Cut/controller state before any mutation. The $0.25 ceiling and ten-only limit remain unchanged. No automatic load resume or workflow action is scheduled.

Picked up from **Capture capacity rerun on binary bundles** (`thread:delegated-task:command%3Amcp%3A3233368c-50ae-4f67-9c92-aae8b8c98c74%3Adelegate-task%3Acapture-capacity-v2-rerun-r2-2026-10-24`).
