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
7. Move real production Spaces once `call-artifacts` (Recording and Transcript) has passed on staging (M10), Recording-disabled ones first. Until then only the proof and canary Spaces are on `chalk_sfu`.
8. Watch again with the alerts live.

## How a changed allowlist reaches the running API

`CHALK_SFU_ALLOWED_SPACES` lives in the SecureString `/chalk/production/managed-episode/api.env` (region `ap-southeast-1`, Advanced tier, key `alias/aws/ssm`). The deploy controller reads it again at every deploy (`fetch_deployment_inputs`) and writes it to `/run/chalk/env/api.env`, which `chalk-api.container` loads with `EnvironmentFile=`. The API reads the file only when it starts. So a changed value reaches the running API in one of two ways:

- **A deploy.** The next Promote or Release re-fetches every input. A Release dispatch on master with `deploy_managed=true` and no application change is classified runtime-only and re-fetches without building images; this path has not been run for a config change.
- **A host edit and restart**, without a deploy (below). The next deploy overwrites the file from SSM, so SSM and the host must hold the same value.

Never print `api.env`: change one line and print only an entry count.

Change the allowlist in SSM (edit one line, keep the old line privately):

```sh
set -euo pipefail
p=/chalk/production/managed-episode/api.env; k="--profile q9labs --region ap-southeast-1"
tmp=$(umask 077; mktemp); trap 'rm -f "$tmp" "$tmp.bak"' EXIT
aws $k ssm get-parameter --name $p --with-decryption --query Parameter.Value --output text > "$tmp"
mkdir -p ~/.chalk-rollout && chmod 700 ~/.chalk-rollout
( umask 077; sed -n 's/^CHALK_SFU_ALLOWED_SPACES=//p' "$tmp" > ~/.chalk-rollout/allowlist.before )
new="$(cat ~/.chalk-rollout/allowlist.before),<space id>"
sed -i.bak "s|^CHALK_SFU_ALLOWED_SPACES=.*|CHALK_SFU_ALLOWED_SPACES=$new|" "$tmp"
aws $k ssm put-parameter --name $p --type SecureString --tier Advanced --overwrite --value "file://$tmp" --query Version
```

Apply it to the running API without a deploy, on the production host (SSM Run Command on `CHALK_MANAGED_INSTANCE_ID`): save the file, change the same one line, restart.

```sh
f=/run/chalk/env/api.env
cp -p $f /run/chalk/env/api.env.before-allowlist
sed -i "s|^CHALK_SFU_ALLOWED_SPACES=.*|CHALK_SFU_ALLOWED_SPACES=<same new value as SSM>|" $f
runuser -u chalk -- env XDG_RUNTIME_DIR=/run/user/$(id -u chalk) systemctl --user restart chalk-api.service
```

Then check `/healthz` on the API and that a new join grant still works. The restart interrupts API requests for a few seconds (join grants, Space calls); live media and Sync are separate services and stay up. Do it in a quiet minute.

**Undo.** Put the old line back in both places. In SSM, run the first script again with `new` set to the saved `~/.chalk-rollout/allowlist.before` value. On the host, restore `/run/chalk/env/api.env.before-allowlist` over `api.env` and run the same restart command. SSM keeps every version (`get-parameter-history`).

## Production settings checked 2026-11-10 (names and counts only)

`CHALK_SFU_ENABLED=true`. `CHALK_SFU_NODES` has one entry. `CHALK_SFU_ALLOWED_SPACES` has one entry, the existing `sfu-canary-…` Space. `CHALK_SFU_NEW_EPISODES` is absent, so new Episodes may bind the own SFU. `CHALK_DEFAULT_MEDIA_PLANE=cf_sfu`. Check these again the same way before Promote.

## Prepare (before the first Promote)

Production runs a release before the per-Space setting, so `media-settings` does not exist there yet. The only way to put a proof Space on `chalk_sfu` before the deploy is the public API on an allowlisted Space. Promote's own deploy comes after that check, so its re-fetch does not help the check: the running API must already hold the allowlist.

1. Pin the manual proof Space to the existing `sfu-canary-…` Space, which is already on `chalk_sfu` and allowlisted:

   ```sh
   gh variable set CHALK_PROOF_SPACE_ID_CHALK_SFU --env production --body <space id>
   ```

2. Create the automatic proof Space (Recording and Transcription automatic). The run fails at the PATCH and names the Space; that is expected.

   ```sh
   gh workflow run real-call-proof.yml --ref master -f environment=production -f proofs=own-sfu-spaces -f media_plane=chalk_sfu
   ```

3. Read its ID from the Tenant's Space list (slug `promote-proof-chalk-sfu-automatic`). Add it to the allowlist in SSM and on the running API as in the section above.
4. Run step 2 again. Both proof Spaces must report `chalk_sfu`.
5. Check the SFU alerts are live (see Watch).

**Undo.** Revert the PR that last changed Promote. Put the automatic proof Space back with `media-settings set --tenant <tenant> --space <space> --plane cf_sfu`. Restore the saved allowlist line in SSM and on the host, and run `gh variable delete CHALK_PROOF_SPACE_ID_CHALK_SFU --env production`.

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

Order: real Spaces move only after `call-artifacts` has passed on staging, Recording-disabled Spaces first. Recording and Transcription both use the capture plane, so a Space with Transcription automatic needs capture even when Recording is disabled.

Per Space (the candidate list with IDs lives in private operator notes):

```sh
media-settings get --tenant <tenant> --space <space>
media-settings set --tenant <tenant> --space <space> --plane chalk_sfu
```

Move a few Spaces, then watch for 30 minutes before the next group. Each Space must be on `CHALK_SFU_ALLOWED_SPACES` (the AND), so add each batch to it first with the SSM edit and host restart above. Spaces keep their Recording and Transcription settings: those are product decisions. Real Spaces, recording-disabled ones included, move only after `call-artifacts` (Recording and Transcript) passes on staging. Until then only the proof and canary Spaces are on `chalk_sfu`.

**Undo per Space.** `media-settings set --tenant <tenant> --space <space> --plane cf_sfu`. Use `cf_sfu`, not `inherit`, because the Tenant default may be `chalk_sfu`. Only new Episodes move; end a live Episode to move that call.

## Not proven

- `leave-own-sfu` has not run against a real SDK session.
- The allowlist path is read from the controller and the quadlet, not run: the SSM edit, the host edit and restart, and the runtime-only Release re-fetch.
- Capture on `chalk_sfu` (M10) is not proven in production.
