# Production rollout to the own SFU

This runbook takes real production Spaces from `cf_sfu` to `chalk_sfu`. It holds names and commands only. Tenant IDs, Space IDs, node addresses and variable values stay in private operator notes, never in Git.

Every step has its undo written first. Do not start a step until its undo is ready, and do not start the next step until the watch of the one before it is clean.

## Order

1. A green cut: a held nightly whose own-SFU proof passed.
2. Prepare: proof Spaces, allowlist, operator checks (below).
3. Promote with `expected_sha`.
4. Watch for 60 minutes.
5. Kill-switch drill, timed.
6. M7 evidence: 20 joins and 10 fault trials.
7. Move production Spaces, non-recording first, then Spaces with Recording or Transcription once `call-artifacts` has passed on staging (M10).
8. Watch again with the alerts live.

## Prepare (before the first Promote)

Production runs a release before the per-Space setting, so `media-settings` does not exist there yet. The only way to put a proof Space on `chalk_sfu` before the deploy is the public API on an allowlisted Space. The running API reads `CHALK_SFU_ALLOWED_SPACES` from `/run/chalk/env/api.env`, which the deploy controller writes from the private API environment at each deploy, so the allowlist reaches the running API only through a deploy or a host edit followed by an API restart.

1. Pin the manual proof Space to one that is already on `chalk_sfu` and already allowlisted: set the `production` environment variable `CHALK_PROOF_SPACE_ID_CHALK_SFU` to its ID. No allowlist change is needed for it.

   ```sh
   gh variable set CHALK_PROOF_SPACE_ID_CHALK_SFU --env production --body <space id>
   ```

2. Create the automatic proof Space (Recording and Transcription automatic). The run fails at the PATCH and names the Space; that is expected.

   ```sh
   gh workflow run real-call-proof.yml --ref master -f environment=production -f proofs=own-sfu-spaces -f media_plane=chalk_sfu
   ```

3. Read the new Space ID from the Tenant's Space list (slug `promote-proof-chalk-sfu-automatic`). Add it to `CHALK_SFU_ALLOWED_SPACES` in the private API environment, then make the running API read it. Use a deploy that re-fetches the API inputs when one exists; otherwise edit `/run/chalk/env/api.env` on the host and restart `chalk-api.service`, and keep the private value and the host value equal so the next deploy keeps it.
4. Confirm the production API settings by name only: `CHALK_SFU_NODES` set, `CHALK_SFU_NEW_EPISODES` not `off`, `CHALK_DEFAULT_MEDIA_PLANE` not changed by this rollout. Print no values.
5. Run step 2 again. Both proof Spaces must report `chalk_sfu`.
6. Check the SFU alerts are live (see Watch).

**Undo.** Revert the PR that last changed Promote. Put each proof Space back with `media-settings set --tenant <tenant> --space <space> --plane cf_sfu`. Remove the added ID from `CHALK_SFU_ALLOWED_SPACES` in the private environment and on the host, and delete the pinned variable with `gh variable delete CHALK_PROOF_SPACE_ID_CHALK_SFU --env production`.

## Promote

```sh
gh workflow run promote.yml --ref master -f expected_sha=<held release sha>
```

Promote selects, waits for production approval, checks the proof Spaces (`own-sfu-spaces`), deploys, runs the throwaway two-guest proof on `chalk_sfu` (`leave-own-sfu camera-share call-artifacts`), scores the Leave result, and rolls back by itself when the proof or scorecard fails. A failure before `release` deploys nothing.

**Undo.** Promote rolls back on a failed proof. To roll back after a pass, dispatch Promote's rollback path as `docs/managed-release.md` describes, or promote the previous held release with its `expected_sha`. Pinned live calls finish on the plane they started on.

## Watch (60 minutes)

Read these every five minutes, from the [SFU runbook](../../infrastructure/observability/production-alerts/sfu-runbook.md):

| Read                                                            | Roll back when                                                                                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chalk_sfu` join failures (`join_failed`, `media_start_failed`) | any join failure on `chalk_sfu` that repeats twice, or one that blocks a real class                                                                       |
| Node health and `sfu-readiness` reasons                         | node down (4 of 5 unhealthy minute samples, or DigitalOcean ping fails 2 minutes), `packet_budget` at 90% or more, any `admission_*` reason for 5 minutes |
| Host CPU, memory, disk                                          | CPU or memory above 85%, or disk above 80%, for 5 minutes                                                                                                 |
| `chalk_sfu.overflow` events                                     | any in the last 2 minutes while the node is healthy                                                                                                       |
| Recording and Transcription                                     | a Recording failed for 15 minutes or stuck stopping for 2 minutes                                                                                         |
| Proof Spaces                                                    | a `leave-own-sfu` or `camera-share` re-run fails                                                                                                          |

Roll back with the kill switch: first the Space setting for the affected Space, then `CHALK_SFU_NEW_EPISODES=off` with an API reload if more than one Space is affected. New Episodes go to Cloudflare; live calls finish where they are.

## Kill-switch drill (timed)

Run it on a proof Space with a real two-guest call, following [Send one Space back to Cloudflare, and return it](../../infrastructure/sfu/README.md#send-one-space-back-to-cloudflare-and-return-it). Record, in seconds: the operator command, the first new join grant that reports `cloudflare_sfu`, and the return to `chalk_sfu`. The drill passes when the first new Episode after the flip reports `cloudflare_sfu` and the return reports `chalk_sfu`.

**Undo.** The return command, `media-settings set --plane chalk_sfu` on the same Space.

## M7 evidence

On a machine with the fault commands set (no values here):

```sh
export CHALK_CANARY_FAULT_DOWN='<command that blocks UDP to the media address>'
export CHALK_CANARY_FAULT_UP='<command that restores it>'
CHALK_CANARY_SPACE_ID=<allowlisted proof Space> CHALK_PROOF_MEDIA_PLANE=chalk_sfu pnpm prod:canary --joins 20 --faults 10
```

The report must show `meetsM7Minimum`, every join within 10 s, and every fault recovered within 15 s.

**Undo.** `FAULT_UP` runs after each trial; if a run stops early, run it by hand and check the block is gone.

## Moving production Spaces

Order: Spaces with Recording disabled first, then Spaces with Recording or Transcription, only after `call-artifacts` has passed on staging. Recording and Transcription both use the capture plane, so a Space with Transcription automatic belongs to the second group even when Recording is disabled.

Per Space (the candidate list with IDs lives in private operator notes):

```sh
media-settings get --tenant <tenant> --space <space>
media-settings set --tenant <tenant> --space <space> --plane chalk_sfu
```

Move a few Spaces, then watch for 30 minutes before the next group. Each Space must be on `CHALK_SFU_ALLOWED_SPACES` (the AND), so add each moved Space to it first.

**Undo per Space.** `media-settings set --tenant <tenant> --space <space> --plane cf_sfu`. Use `cf_sfu`, not `inherit`, because the Tenant default may be `chalk_sfu`. Only new Episodes move; end a live Episode to move that call.

## Not proven

- `leave-own-sfu` has not run against a real SDK session.
- The running API's allowlist reload path is read from the controller, not run.
- Capture on `chalk_sfu` (M10) is not proven in production.
