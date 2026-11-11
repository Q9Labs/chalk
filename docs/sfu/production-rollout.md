# Production rollout to the own SFU

This runbook takes production from `cf_sfu` to `chalk_sfu`. It holds names and commands only. Tenant IDs, Space IDs, node addresses and variable values stay in private operator notes, never in Git. Nothing here runs until the lead names the green sha.

Every step has its undo written first. Do not start a step before its undo is ready, and do not start the next step before the one before it is clean.

## Targets

| Step                  | Target       |
| --------------------- | ------------ |
| Promote dispatched    | about 21:15Z |
| 60-minute window done | about 22:30Z |
| Real Space moves      | about 23:00Z |

## Spaces

Three Q9-owned Spaces of the production proof Tenant carry every proof. No two Episodes ever share a Space.

| Space (name)                        | Used for                                                           | Policies                                  |
| ----------------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| `sfu-canary-…` (existing)           | Promote's manual proof, then the kill-switch drill                 | manual Recording, on-demand Transcription |
| `m7-evidence-20261110`              | M7 evidence (20 joins, 10 fault trials)                            | manual Recording, on-demand Transcription |
| `promote-proof-chalk-sfu-automatic` | Promote's `call-artifacts`, then M10's production `call-artifacts` | automatic Recording and Transcription     |

IDs live in `~/.chalk-rollout/proof-spaces.env` (private) and `~/sfu-ops/prod/proof-space.env` (the evidence lane reads it). All three are in the private `CHALK_SFU_ALLOWED_SPACES` source. **Undo per Space:** `POST /v1/tenants/<proof tenant>/spaces/<space>/archive` with the proof Tenant key.

## Order

1. One production deploy (Promote) carries the allowlist and the capture flags.
2. One 60-minute window on the proof Spaces only: the watch, the timed kill-switch drill, M7 and M10 `call-artifacts`.
3. When the window is green, move real Spaces, then `CHALK_NEW_SPACE_MEDIA_PLANE`.

## How a changed value reaches the running API

The private API environment is the SecureString `/chalk/production/managed-episode/api.env` (region `ap-southeast-1`, Advanced tier, key `alias/aws/ssm`). The deploy controller re-fetches it at every deploy and writes `/run/chalk/env/api.env`, which `chalk-api.container` loads with `EnvironmentFile=`. The API reads that file only when it starts. A change therefore reaches the running API in one of two ways:

- **A deploy.** The next Promote or Release re-fetches every input. A Release dispatch on master with `deploy_managed=true` and no application change is classified runtime-only and re-fetches without building images. Not run for a config change.
- **A host edit and restart**, without a deploy (below). The next deploy overwrites the host file from SSM, so SSM and the host must hold the same value.

Never print `api.env`. Change one line and print only a count. Run these snippets with `bash`.

Set, change or delete one line in SSM (`NAME` and `VALUE` are the variable and its new value; run with `DELETE=1` and no `VALUE` to remove the line; the old line is saved privately):

```sh
set -euo pipefail
p=/chalk/production/managed-episode/api.env
aws() { command aws --profile q9labs --region ap-southeast-1 "$@"; }
mkdir -p ~/.chalk-rollout /tmp/chalk-rollout-sfu && chmod 700 ~/.chalk-rollout /tmp/chalk-rollout-sfu
work=/tmp/chalk-rollout-sfu/api.env
aws ssm get-parameter --name $p --with-decryption --query Parameter.Value --output text > $work
[ "$(wc -l < $work)" -gt 50 ] || { echo "read failed"; exit 1; }
# Keep the old line. The file is empty when the variable is absent, so the undo can tell "absent" from "empty".
( umask 077; grep "^$NAME=" $work > ~/.chalk-rollout/$NAME.before || true )
python3 - "$NAME" "${VALUE-}" "${DELETE-}" <<'EOF'
import re, sys, pathlib
name, value, delete = sys.argv[1:]
f = pathlib.Path("/tmp/chalk-rollout-sfu/api.env")
t = f.read_text()[:-1]  # `--output text` adds one newline the value does not have
if delete:
    f.write_text(re.sub(rf"^{name}=.*\n?", "", t, flags=re.M))
else:
    new, n = re.subn(rf"^{name}=.*$", lambda _: f"{name}={value}", t, flags=re.M)
    f.write_text(new if n else t.rstrip("\n") + f"\n{name}={value}\n")
EOF
aws ssm put-parameter --name $p --type SecureString --tier Advanced --overwrite --value file://$work --query Version
rm -f $work
```

Apply the same line to the running API without a deploy, on the production host (SSM Run Command on `CHALK_MANAGED_INSTANCE_ID`):

```sh
f=/run/chalk/env/api.env
cp -p $f /run/chalk/env/api.env.before-change
# change, append or delete the one line, the same way as in SSM
runuser -u chalk -- env XDG_RUNTIME_DIR=/run/user/$(id -u chalk) systemctl --user restart chalk-api.service
```

Then read `/healthz` and `/readyz` and check that a new join grant still works. The restart interrupts API requests for a few seconds (join grants, Space calls); live media and Sync are separate services and stay up. Do it in a quiet minute.

**Undo.** Put the old line back in both places. In SSM, run the script again: with the saved line's text after `NAME=` as `VALUE`, or with `DELETE=1` when `~/.chalk-rollout/<NAME>.before` is empty (the variable was absent). On the host, copy `/run/chalk/env/api.env.before-change` back over `api.env` and run the same restart. SSM keeps every version (`get-parameter-history`).

## 1. One deploy carries everything

### State on 2026-11-10 (names and counts only)

| Setting                                                                                        | Production                                                                  | Staging (`nightly`) |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------- |
| `CHALK_SFU_ENABLED`                                                                            | `true`                                                                      | `true`              |
| `CHALK_RECORDING_ENABLED`                                                                      | `true`                                                                      | `true`              |
| `CHALK_TRANSCRIPTION_ENABLED`                                                                  | `true`                                                                      | `true`              |
| `CHALK_SFU_CAPTURE_ENABLED`                                                                    | absent (default off)                                                        | `true`              |
| `CHALK_SFU_NEW_EPISODES`                                                                       | absent (new Episodes allowed)                                               | not read            |
| `CHALK_DEFAULT_MEDIA_PLANE`                                                                    | `cf_sfu`                                                                    | not read            |
| `CHALK_SFU_NODES`                                                                              | 1 entry                                                                     | 1 or more           |
| Provider bridge (`CHALK_PROVIDER_BRIDGE_*`) and fleet issuer (`CHALK_RECORDER_FLEET_ISSUER_*`) | present                                                                     | present             |
| `CHALK_SFU_ALLOWED_SPACES`                                                                     | 3 entries: the three proof Spaces (SSM version 31; version 29 held 1 entry) | not read            |

Production already records and transcribes on Cloudflare, so its recorder fleet exists. Only `CHALK_SFU_CAPTURE_ENABLED` is new. Check these again before Promote with names and counts only.

### The capture flag depends on M10 on staging

Add `CHALK_SFU_CAPTURE_ENABLED=true` to the private environment **only if** M10's staging `call-artifacts` (run 42876791977) passed with the same flag set as the table shows for staging (Recording, Transcription, capture on, provider bridge present). If it did not pass, leave the flag out, dispatch Promote with `capture_proofs=false` so the production proof does not demand a Recording, and add the flag in a second deploy.

```sh
NAME=CHALK_SFU_CAPTURE_ENABLED VALUE=true  # then the SSM script above
```

### Before dispatch (about T-10 minutes)

1. Confirm no real class is live (`/readyz` sessions and allocations, the Sync presence of real Spaces).
2. Pin the manual proof Space: `gh variable set CHALK_PROOF_SPACE_ID_CHALK_SFU --env production --body <sfu-canary id>`. The automatic proof Space is found by its slug.
3. **Apply the allowlist to the running API** with the host edit and restart above (the SSM value is already set). This is not optional: Promote's first job, `own-sfu-spaces`, runs before the deploy on the release still in production, and that release lets the public API move a Space to `chalk_sfu` only when the running API already lists it. The deploy's own re-fetch comes after that check and does not help it. The job moves `promote-proof-chalk-sfu-automatic` to `chalk_sfu` and finds the pinned canary Space already there.
4. Check the SFU alerts are live (see the watch).

### Dispatch

```sh
gh workflow run promote.yml --ref master -f expected_sha=<green sha>
# if the capture flag is not in this deploy:
gh workflow run promote.yml --ref master -f expected_sha=<green sha> -f capture_proofs=false
```

Promote selects, waits for production approval, runs `own-sfu-spaces`, deploys, runs `leave-own-sfu camera-share call-artifacts` on `chalk_sfu` (without `call-artifacts` when `capture_proofs=false`), scores Leave, and rolls back by itself when the proof fails.

### After the deploy is live

1. Read the API `/healthz` and `/readyz`. Read the node `sfu-readiness`.
2. Move the M7 Space to `chalk_sfu` (the canary and the automatic proof Space already are):

   ```sh
   media-settings set --tenant <proof tenant> --space <m7 space> --plane chalk_sfu
   media-settings get --tenant <proof tenant> --space <m7 space>
   ```

### What rolls back if the API does not start

With capture on and the recorder fleet missing, the API fails at startup (the API's configuration check refuses the combination). The deploy controller treats a candidate that fails its health check as failed, runs `rollback_to_stable`, fences the candidate and reports the failure; Promote's `release` job fails and its rollback job restores the Pages deployment, the media pins and the npm tags it saved. The previous API release serves again. The controller's rollback of the environment file is not proven. SSM keeps the new values, so the next deploy would carry the same fault: remove the capture flag from SSM before anything redeploys.

### Undo for the deploy

**Primary undo: return the traffic, keep the release.** It needs no redeploy of images and works the same before and after the window.

1. Put each moved Space back, one at a time: `media-settings set --tenant <tenant> --space <space> --plane cf_sfu` (not `inherit`). Only new Episodes move; end a live Episode to move that call. If more than one Space is affected, set `CHALK_SFU_NEW_EPISODES=off` first (SSM script, host edit, one restart).
2. Remove `CHALK_SFU_CAPTURE_ENABLED` and the proof Space IDs from the allowlist in SSM and on the host (`DELETE=1` for the flag, the saved line for the allowlist), with one restart.
3. Revert the Promote PR if its change is at fault.

A runtime-only Release does not undo the deploy: it re-fetches the environment but keeps the new images.

**Release rollback (not run).** Promote cannot take the previous release: `select()` in `scripts/releases/release.py` accepts only the newest held nightly. A failed Promote needs none of this: its rollback job restores the Pages deployment, media pins and npm tags, and the `result` job prints the exact manual Release inputs when that recovery did not run. After a successful Promote, dispatch the CI workflow (`.github/workflows/ci.yml`) from master with the identity of the release before it:

```sh
# Index 0 is the release Promote just shipped; index 1 is the previous one. Read only.
gh api "repos/Q9Labs/chalk/deployments?environment=production&task=production-release&per_page=5" \
  --jq '.[] | [.id, .created_at, .payload.target_sha, .payload.release_id] | @tsv'
gh api "repos/Q9Labs/chalk/deployments?environment=production&task=production-release&per_page=5" \
  --jq '.[1].payload | {target_sha, run_id, manifest_artifact_id, manifest_sha256, release_id, media_sha256}'
# Saved Pages identity and media pins from the Promote run:
gh run download <promote run id> -n promotion-rollback-1 -D /tmp/chalk-rollout-sfu/rollback
jq -r .pages_deployment_id /tmp/chalk-rollout-sfu/rollback/rollback.json
jq -c . /tmp/chalk-rollout-sfu/rollback/previous-media.json
gh workflow run ci.yml --ref master -f target_sha=<target_sha> -f release_managed=false -f deploy_managed=true \
  -f managed_environment=production -f deploy_web=true -f manifest_run_id=<run_id> \
  -f manifest_artifact_id=<manifest_artifact_id> -f manifest_sha256=<manifest_sha256> \
  -f reuse_release_id=<release_id> -f media_sha256=<media_sha256> \
  -f rollback_media='<previous-media.json>' -f pages_rollback_id=<pages_deployment_id>
```

The dispatch needs the production concurrency group (`chalk-environment-production`) free. I read these commands against the workflow inputs and the deployment payload keys; the dispatch itself has not been run, so treat it as the second choice after the primary undo. npm `latest` may need restoring from `npm_latest` in the saved rollback record.

### The node ships before any SDK that raises its offer thresholds

The node's offer cap rises from 64 KiB to 256 KiB (`SFU_MAX_REQUEST_BYTES` default 384 KiB), and the SDK scales its replacement thresholds with that cap. An SDK with the scaled thresholds lets an offer grow past 64 KiB, so against a node that still has the old cap it gets a 400 on the next offer. An older SDK keeps its 64 KiB-based thresholds and works against either node. So the node goes first, and the SDK follows:

1. Promote deploys the node (its media pins) and the API in `deploy-managed`. The web bundle builds the SDK from the same commit (`workspace:^`) and ships in `deploy-web`, which `needs: deploy-managed` in `.github/workflows/ci.yml`, so the web cut cannot go out before the node. Do not publish a web-only cut of this commit by another path.
2. Publish the SDK to npm (`.github/workflows/npm-publish.yml`) and cut the mobile builds only after Promote's proof is green, so every SDK in the field with the scaled thresholds finds a 256 KiB node.
3. A node must not roll back to a build with the 64 KiB cap while a web or SDK release with the scaled thresholds is live. The Promote rollback restores the web and the node together; a node-only rollback needs the web rollback too.
4. A node that sets `SFU_MAX_REQUEST_BYTES` itself must be at least 393216 (384 KiB), or the 256 KiB offer does not fit its request limit.

## 2. The 60-minute window

### Conditions before it starts

- `/readyz` shows sessions 0, allocations 0 and cleanupDebt 0, and no real class is live.
- The drill and M7 never share a Space or an Episode. M7 and M10 `call-artifacts` start together only after the drill ends.

### Schedule

| Minutes  | Runs                                                                         | Space                                                          |
| -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0 to 15  | Kill-switch drill, alone on the node, timed                                  | `sfu-canary-…`                                                 |
| 15 to 60 | M7 (20 joins, 10 fault trials) and M10 production `call-artifacts`, together | `m7-evidence-20261110` and `promote-proof-chalk-sfu-automatic` |
| 0 to 60  | The watch, every 5 minutes                                                   | n/a                                                            |

### The watch

Read every five minutes, from the [SFU runbook](../../infrastructure/observability/production-alerts/sfu-runbook.md):

| Read                                                            | Roll back when                                                                      | During the M7 fault window                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `chalk_sfu` join failures (`join_failed`, `media_start_failed`) | the same failure twice, or any that blocks a real class                             | joins on `m7-evidence-…` inside a fault trial are expected to stall; count only other Spaces              |
| Node health                                                     | 4 of 5 unhealthy minute samples, or DigitalOcean ping fails for 2 minutes           | the fault blocks UDP at the runner, not at the node, so a node-down alarm is real                         |
| `sfu-readiness`                                                 | `packet_budget` at 90% or more, or any `admission_*` reason for 5 minutes           | packet loss and ICE restarts on the M7 Episode are expected inside the 5 s fault plus up to 15 s recovery |
| Host CPU or memory, disk                                        | above 85%, or above 80% for disk, for 5 minutes                                     | not expected                                                                                              |
| `chalk_sfu.overflow` events                                     | any in the last 2 minutes while the node is healthy                                 | not expected                                                                                              |
| Recording and Transcription                                     | a Recording failed for 15 minutes, or stuck stopping for 2 minutes                  | the M10 Episode is the only expected Recording                                                            |
| Proof results                                                   | the drill misses a threshold, M7 misses `meetsM7Minimum`, or `call-artifacts` fails | n/a                                                                                                       |

Roll back with the kill switch: first the Space setting for the affected Space, then `CHALK_SFU_NEW_EPISODES=off` with an API reload if more than one Space is affected. New Episodes go to Cloudflare; live calls finish where they are.

### Kill-switch drill (timed)

Follow the section "Send one Space back to Cloudflare, and return it" in [the SFU README](../../infrastructure/sfu/README.md) on the canary Space with a real two-guest call. Record in seconds: the operator command, the first new join grant that reports `cloudflare_sfu`, and the return to `chalk_sfu`. It passes when the first new Episode after the flip reports `cloudflare_sfu` and the return reports `chalk_sfu`. **Undo:** `media-settings set --plane chalk_sfu` on the same Space.

### M7 evidence

```sh
export CHALK_CANARY_FAULT_DOWN='<command that blocks UDP to the media address>'
export CHALK_CANARY_FAULT_UP='<command that restores it>'
CHALK_CANARY_SPACE_ID=<m7 space> CHALK_PROOF_MEDIA_PLANE=chalk_sfu pnpm prod:canary --joins 20 --faults 10
```

It passes with `meetsM7Minimum`, every join within 10 s and every fault recovered within 15 s. **Undo:** `FAULT_UP` runs after each trial; if the run stops early, run it by hand and check the block is gone.

### M10 `call-artifacts` on production

The M10 lane runs `call-artifacts` against `promote-proof-chalk-sfu-automatic` (recording object exists, decrypts and plays, audio and video present, duration matches, transcript plausible). It needs the capture flag in this deploy. **Undo:** archive the Space's Episode output; nothing else changes.

## 3. Moving real Spaces

Start only when the window is green. Two blockers sit in front of every real Space:

1. **Transcription auto-language.** All 165 active Spaces use automatic language (`transcript_language` null), and Transcription is automatic on all but the proof Spaces. The production transcription dispatcher Lambda has no `CODESWITCH_PROVIDER` or `OPENROUTER_TOKEN_PARAMETER_ARN`, so Auto transcription has no provider (DeepInfra Whisper only, and Auto never falls back to Whisper). No Space with Transcription auto-language moves until it is wired. Wiring is a separate step, not a Promote release item: Promote ships the API reader and dispatcher ZIP, then an operator runs the checked migration (the production parameter `/chalk/production/transcription/openrouter-token` exists):

   ```sh
   python3 scripts/transcription-dispatcher/configure-mai.py --environment production --secret-parameter-arn <production openrouter-token parameter ARN>          # plan, review it
   python3 scripts/transcription-dispatcher/configure-mai.py --environment production --secret-parameter-arn <production openrouter-token parameter ARN> --apply
   ```

   The plan (checked 2026-11-10, names only) has two updates and nothing else: `module.dispatcher.aws_iam_role_policy.dispatcher` gains a read grant for that one secret, and `module.dispatcher.aws_lambda_function.dispatcher` gains `CODESWITCH_PROVIDER` and `OPENROUTER_TOKEN_PARAMETER_ARN` in its environment (`CHALK_CONFIG_DIGEST` changes with them). No creates, deletes or code changes. Run `--apply` only after Promote has shipped the reader and the dispatcher ZIP.

   **Undo:** `configure-mai.py --environment production --disable --apply` pauses Auto and keeps fixed languages.

2. **M10 passed in production** (the window's `call-artifacts`), because every real Space records or transcribes.

Order after both: Spaces with Recording disabled first, then Spaces with Recording automatic or manual. Spaces keep their Recording and Transcription settings; those are product decisions. For each batch:

```sh
# 1. add the batch to the allowlist (SSM script), apply on the host once, restart once
# 2. flip the Spaces one at a time, no reload needed
media-settings get --tenant <tenant> --space <space>
media-settings set --tenant <tenant> --space <space> --plane chalk_sfu
```

Watch 30 minutes between batches with the table above. **Undo per Space:** `media-settings set --tenant <tenant> --space <space> --plane cf_sfu` (not `inherit`, because the Tenant default may be `chalk_sfu`). Only new Episodes move; end a live Episode to move that call.

### `CHALK_NEW_SPACE_MEDIA_PLANE=chalk_sfu` (last step, optional)

Leave it unset unless Hasan decides that every new Space should start on `chalk_sfu`. It is a product decision, not part of the window.

The API refuses to start with it set to `chalk_sfu` unless three things hold: `CHALK_SFU_ENABLED=true`, `CHALK_SFU_ALLOWED_SPACES=*`, and `CHALK_SFU_CAPTURE_ENABLED=true` when either new-Space policy default is not `disabled`. So the step is one change of two lines, never the new-Space line alone:

1. Save the current allowlist line (the SSM script does it) and set `CHALK_SFU_ALLOWED_SPACES` to `*` and `CHALK_NEW_SPACE_MEDIA_PLANE` to `chalk_sfu` in SSM and on the host, then restart once. Do the host edit first and read `/healthz`; if the API does not start, restore the host backup at once.
2. Read `/healthz`, create a throwaway Space in the proof Tenant and check that it reports `chalk_sfu`.

With `*` the allowlist no longer limits anything, so these Spaces use `chalk_sfu` for new Episodes: every Space whose stored setting is `chalk_sfu` (the Spaces moved above), every Space created after the restart, and every Space that inherits a Tenant default of `chalk_sfu` (none today: 10 Tenants are `cf_sfu`, 13 are unset). `CHALK_DEFAULT_MEDIA_PLANE=cf_sfu` stays, so every other existing Space stays on Cloudflare. `*` also removes the allowlist as a safety net for `media-settings set`, so each later flip needs the same care as before.

**Undo.** Restore both lines together: the saved allowlist line and no `CHALK_NEW_SPACE_MEDIA_PLANE` line (`DELETE=1`), in SSM and on the host, with one restart. Spaces created in the meantime keep `chalk_sfu` as their stored setting; set the ones that should not have it back with `media-settings set --plane cf_sfu`.

## Not proven

- `leave-own-sfu` has not run against a real SDK session.
- The allowlist path is read from the controller and the quadlet, not run: the SSM edit (run once, version 31), the host edit and restart, and the runtime-only Release re-fetch.
- Whether the controller's rollback restores the previous environment file.
- Capture on `chalk_sfu` in production (M10) is not proven.
