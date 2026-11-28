# Incident response

When production breaks, restore service first and fix properly afterwards. Addresses, IDs, credentials and customer names stay in private operator notes, never here. Times marked "measured" come from rehearsals on nightly; "not measured" means nobody has timed it yet.

## Decide in two minutes

Roll back when the last deploy is the likely cause and the previous release can run on today's data. Fix forward when the cause is outside the release, or a migration already ran (migrations only move forward, and the previous release must still read the new schema: that is why database removals keep the previous release runnable).

1. Did a deploy, config change or flag change happen in the last hour? If not, look first (below) before you touch anything.
2. Can one switch below stop the damage without a deploy? A kill switch or a Space setting takes seconds. Use it before a rollback.
3. Is the fix one small commit that is already on master with a green push Gate? Use the hotfix path.
4. Otherwise restore the previous release with the restore action for the part that broke.

The Oncall agent may roll production back to the previous release without asking when the evidence shows a production release caused the incident and the restore command below exists. It then checks that service is restored and tells the owner what it rolled back, why, and how to roll forward. The proper fix still goes through a pull request.

## Where to look first

[Observability](../observability.md) has the full guide. In order:

1. The uptime monitor's message says which check failed. The join probe fails at a named stage: create Episode, admit participant, or Sync handshake.
2. A user's problem report prints `Last failed request: <journey id> (HTTP <status>)`. Search the API log for that journey ID to get the route, status and error code.
3. For one Episode, search both the API log and the Sync trace for its ID.
4. Check what shipped last: the newest runs of `Release`, `Cut nightly`, `Promote` and `Hotfix`. If a cut was slow, `python3 scripts/releases/cut_timing.py <run-id>` shows where it spent its time: each job's wait for a runner and its work, and the chain of jobs that set the end time.

## Restore one deployable

| Part                | Restore action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Time                                          | Does not restore                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| API and Sync        | Run `python3 scripts/releases/hotfix.py rollback-command` with `GH_TOKEN` set. It reads the retained production releases and prints one `gh workflow run ci.yml` line that restores the release before the running one. Run that line once. Promote and Hotfix run the same job for you when the real-call smoke fails.                                                                                                                                                                                                           | 617 s measured on nightly, 12 Nov 2026        | Migrations. Data written by the new release stays.               |
| Web                 | Get the previous Pages deployment ID with `python3 scripts/releases/web.py previous` (needs `PAGES_PROJECT`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the operator notes), then add `--pages-id <id>` to the command above. The one `Release` run restores web and backend together.                                                                                                                                                                                                                               | 11 s for the Pages step, measured 12 Nov 2026 | Vendor assets are immutable and stay.                            |
| SFU nodes           | The `Release` run above also brings each node to the SFU source of the restored release, before the API, and does not wait for calls to drain. A node only moves to a source it does not already include, so a node that is newer than the restored release stays, and the older API places on it by the protocol's compatibility rule. To roll a node back on its own, run `infrastructure/sfu/deploy production <address> --force` from a checkout of the earlier commit ([upgrade order](../../infrastructure/sfu/README.md)). | not measured                                  | Episodes already bound to a node keep it.                        |
| Recorder fleet pins | The same `Release` rollback restores the previous recorder archive pins and dispatcher ZIP.                                                                                                                                                                                                                                                                                                                                                                                                                                       | included above                                | Workers running the new pins drain through the normal lifecycle. |
| Cloudflare workers  | `wrangler rollback <version id>` for that Worker. Write down the version ID before every deploy.                                                                                                                                                                                                                                                                                                                                                                                                                                  | 9 s measured on nightly, 12 Nov 2026          | Secrets and KV values changed since.                             |
| npm `latest`        | `python3 scripts/releases/npm_dist_tags.py restore` with the retained tags, or `npm dist-tag add <package>@<previous> latest`.                                                                                                                                                                                                                                                                                                                                                                                                    | not measured                                  | Published versions stay. npm never unpublishes them for you.     |
| Mobile              | Halt the staged rollout in the store console and submit the previous build. There is no over-the-air update.                                                                                                                                                                                                                                                                                                                                                                                                                      | store review time                             | Installed builds. A fix needs a new build.                       |

A rollback that cannot find its baseline fails closed and prints the manual inputs. Use those inputs; do not rebuild.

Nobody restarts or stops the production node by hand during the day. The deploy path and the rollback path above are the only ways: they drain the services in order and leave a deploy record, while a hand restart cuts live calls and leaves no record. An alert pages Oncall when the node is stopped, started or rebooted, and when the API starts without a deploy record.

## Hotfix path

Run the `Hotfix` workflow from master with the commit SHA of a fix that is already on master. It refuses a SHA that is not on master, has no green push Gate, or does not contain the release now running. Then it:

1. builds on the release now running and validates the release,
2. deploys API, Sync and web, with that release kept as the rollback baseline,
3. runs the real-call smoke on the Chalk SFU,
4. rolls back by itself if the smoke fails, and stays red until someone confirms service.

It skips the nightly record, latency and long-call proofs, the scorecard and npm publish. Measured on nightly on 12 Nov 2026: 22.3 minutes from dispatch to live with the build reused (backend deploy 660 s, web 124 s, real-call smoke 457 s), and about 30 minutes with a fresh 8.3 minute build and validate. A forced smoke failure restored service 10.5 minutes after the rollback started. Nightly no longer has a host, so `Hotfix` runs on production only; `Hotfix rehearsal` (`.github/workflows/hotfix-rehearsal.yml`) rehearses the host side on a host made for the run: it delivers the newest held nightly cut, then the hotfix, then a fresh envelope of the cut as the rollback does, through the real controller. It also uploads the hotfix web to the nightly Pages project and restores the deployment that was live, as the Pages rollback does. After the hotfix leg and again after the rollback leg, the host serves the Nightly API address through the Nightly tunnel, and a real call runs through it (the camera-share proof on Chalk SFU, with a Tenant seeded on the host's own container database). It does not run the recorder smoke: the per-cut lanes cover the recorder path, and the full real-call smoke runs on production after every hotfix, where a failed smoke starts the rollback. After the incident, the next nightly cut carries the fix through the normal path, and the postmortem below closes the gap that let it through.

## Kill switches and media plane settings

| Switch                                                                      | Effect                                                                           | How fast                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| `media-settings new-episodes --state off --operator <name> --reason <text>` | New Episodes are refused. Live Episodes stay on their SFU nodes. Audit row kept. | Next new Episode, no deploy and no restart. |

The first row is an emergency stop for new Episodes, not the normal failover: a live call keeps its binding, and a new Episode that no Chalk SFU node can take is refused with a retryable `503 media.unavailable`. `--state on` turns it back on. `CHALK_SFU_NEW_EPISODES=off` in the API environment is a deploy-time floor under it: while it says off, the switch is off whatever the database says.

Commands, rules and the rollback caveats are in the [SFU README](../../infrastructure/sfu/README.md#which-plane-a-new-episode-gets) and the [rollout notes](../archive/sfu-production-rollout.md#undo). To end a live call on the wrong plane, end its Episode through the API.

### Turn off screen annotation

`CHALK_SCREEN_ANNOTATION_ENABLED` is the startup default for both API and Sync: off in production, on in local development, staging, nightly and Orbs. For a rollback without a restart, use the application's direct database connection with the operator role:

```sql
insert into screen_annotation_settings (singleton, enabled) values (true, false)
on conflict (singleton) do update set enabled = excluded.enabled;
```

API `/readyz` shows `capabilities.screen_annotation: disabled` on the next request. Sync checks the override once a second per node. In a healthy call, allow about two seconds for Sync to withdraw the ink and controls. It rejects annotation commands with `not_active`, which older SDKs already understand. Helper attachments close with `screen_annotation_disabled`. The main Sync socket, screen share and saved recordings stay in place.

Use the same statement with `true` to turn annotation back on, or `delete from screen_annotation_settings where singleton;` to use the startup default again. A client that connected while annotation was off must reconnect to negotiate it. Clients already using annotation before the flip get the current layer back without reconnecting.

### Turn on presenting in production

Presenting is off in production by default. Turn it on only after the renderer is deployed and the production API role can invoke it. Write its runtime inputs before the Promote that ships matching API, Sync and renderer code; that deploy is the first time the host reads them. Keep account identifiers, the production instance ID, parameter prefix, role names and concrete S3 version IDs in the private operator notes; do not paste them into Git.

One-time bootstrap:

1. Let a Nightly managed-release build publish the `renderer` member of `<release>.media.json`. Promote copies exact bytes later; never rebuild a renderer ZIP by hand.
2. Copy that exact versioned ZIP into the production releases bucket under the same key. In a private operator workspace:

   ```sh
   SRC_BUCKET=<nightly artifact bucket>
   PROD_BUCKET=chalk-production-releases-<account-id>-ap-southeast-1
   SRC_KEY=<exact key from the media member; it may name an older carried-forward release>
   DEST_KEY=document-renderer/<api-release-id>/<zip-sha256>.zip
   SRC_VERSION=<version id from the media member>

   COPY_RESULT=$(aws s3api copy-object \
     --bucket "$PROD_BUCKET" --key "$DEST_KEY" \
     --copy-source "$SRC_BUCKET/$SRC_KEY?versionId=$SRC_VERSION")
   DEST_VERSION=$(jq -r '.VersionId' <<<"$COPY_RESULT")
   [[ "$DEST_VERSION" != null && -n "$DEST_VERSION" ]]
   ```

   Verify the copied object's SHA-256 is the media member digest before continuing.

3. Resolve the production API host's IAM role name without printing secrets:

   ```sh
   PROFILE_ARN=$(aws ec2 describe-instances --instance-ids <production instance id> \
     --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' --output text)
   PROFILE_NAME=${PROFILE_ARN##*/}
   API_ROLE_NAME=$(aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" \
     --query 'InstanceProfile.Roles[0].RoleName' --output text)
   ```

4. Write a mode-0600 private inputs file. Values not marked private are deterministic. Copy `alarm_actions` from the existing production dispatcher inputs or operator notes. `config_digest` is the SHA-256 of the exact environment JSON with `CHALK_CONFIG_DIGEST` omitted; the helper below computes it.

   ```json
   {
     "function_name": "chalk-production-document-renderer",
     "environment_name": "production",
     "release_id": "<api release id from the selected manifest>",
     "release_manifest_digest": "sha256:<sha256 of that release manifest file>",
     "config_digest": "<computed below>",
     "artifact_s3_bucket": "chalk-production-releases-<account-id>-ap-southeast-1",
     "artifact_s3_key": "<DEST_KEY>",
     "artifact_s3_object_version": "<DEST_VERSION>",
     "artifact_sha256": "<zip-sha256>",
     "artifact_sha256_base64": "<base64 of the hex digest>",
     "timeout_seconds": 300,
     "reserved_concurrency": 4,
     "memory_size": 2048,
     "ephemeral_storage_size": 1024,
     "control_api_url": "https://api.chalkmeet.com",
     "log_retention_days": 30,
     "log_kms_key_arn": null,
     "failure_queue_kms_key_arn": null,
     "async_max_event_age_seconds": 3600,
     "async_maximum_retry_attempts": 1,
     "alarm_actions": ["<production alarm action ARN, or keep the array empty only while alerting is absent>"],
     "control_api_invoker_principal": null,
     "control_api_invoke_source_arn": null,
     "control_api_invoker_role_name": "<API_ROLE_NAME>"
   }
   ```

   ```sh
   python3 - <<'PY'
   import base64, hashlib, json
   inputs_path = 'document-renderer-production.json'
   data = json.load(open(inputs_path))
   data['artifact_sha256_base64'] = base64.b64encode(bytes.fromhex(data['artifact_sha256'])).decode()
   env = {
     'CHALK_ENVIRONMENT': 'production',
     'CHALK_RELEASE_ID': data['release_id'],
     'CHALK_RELEASE_MANIFEST_DIGEST': data['release_manifest_digest'],
     'CONTROL_API_BASE_URL': data['control_api_url'],
     'LD_LIBRARY_PATH': '/var/task/lib',
   }
   data['config_digest'] = 'sha256:' + hashlib.sha256(json.dumps(env, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
   open(inputs_path, 'w').write(json.dumps(data, indent=2) + '\n')
   PY
   chmod 600 document-renderer-production.json
   ```

5. Bootstrap once. A fresh bootstrap requires a complete create-only plan; after an interruption the same command resumes the checkpoint, creates only missing resources and converges to a no-op plan. It is not the release path.

   ```sh
   AWS_PROFILE=q9labs \
   CHALK_INFRA_INPUTS=$PWD/document-renderer-production.json \
   CHALK_DOCUMENT_RENDERER_PRODUCTION_BOOTSTRAP=approved \
   pnpm infra bootstrap document-renderer production
   ```

   If an interrupted retry cannot read the half-created function's async invoke configuration, that is [issue #1706](https://github.com/Q9Labs/chalk/issues/1706). Recover manually rather than adopting anything. Before deleting, confirm all three of these, and stop if any one is not exactly as stated:
   1. The bootstrap checkpoint for the `Function` resource in the document-renderer production state (the Alchemy AWS state backend in `infrastructure/platform/config.ts`) still has status `creating`.
   2. This command returns `ResourceNotFoundException`. AccessDenied or any other error means stop:

      ```sh
      aws lambda get-function-event-invoke-config --function-name chalk-production-document-renderer
      ```

   3. The ownership tag equals the instance ID recorded in that checkpoint:

      ```sh
      aws lambda get-function --function-name chalk-production-document-renderer \
        --query 'Tags."alchemy:instance"' --output text
      ```

   If the checkpoint cannot be read, anything differs, or anything is uncertain, stop and escalate; never delete an untagged or foreign function. Only when all three hold, delete that half-created function by name and rerun the same bootstrap command:

   ```sh
   aws lambda delete-function --function-name chalk-production-document-renderer
   ```

6. Verify before touching runtime inputs:

   ```sh
   AWS_PROFILE=q9labs pnpm infra plan document-renderer production
   AWS_PROFILE=q9labs pnpm infra drift document-renderer production
   aws lambda get-function-configuration --function-name chalk-production-document-renderer \
     --query '{State:State,Update:LastUpdateStatus,CodeSha256:CodeSha256,Release:Environment.Variables.CHALK_RELEASE_ID}'
   aws iam get-role-policy --role-name "$API_ROLE_NAME" \
     --policy-name chalk-production-document-renderer-control-api-invoke \
     --query 'PolicyDocument.Statement[0].Sid' --output text
   ```

   The plan must be no-op, drift clean, the function Active/Successful, and the role policy Sid `InvokeDocumentRendererOnly`.

7. For today's production rollout, leave the GitHub environment variable `CHALK_RENDERER_RELEASE_ENABLED` unset; delete it if it was already created, and do not define a repository-wide fallback. The bootstrap above is enough: the API invokes the renderer by function name, and the renderer stays on its bootstrap version. While the variable is unset, managed release preflight, Promote rollback retention and hotfix retention skip renderer state entirely and explicitly leave the already-bootstrapped renderer live; no renderer DynamoDB permission or renderer release binding is needed for it to keep serving. Do not set the variable to `true` until [issue #1705](https://github.com/Q9Labs/chalk/issues/1705) fixes interrupted managed renderer release recovery. After that follow-up, setting it declares renderer release binding and the production deploy role must have the document-renderer state read/write, `.tflock`, versioned-ZIP copy/read and Lambda binding permissions described in `docs/managed-release.md`.

Runtime input rollout:

1. Generate the capability secret locally; do not print it in chat or CI logs. It is stored inside the existing `api.env` SecureString, not as a separate plaintext parameter:

   ```sh
   openssl rand -base64 48 > capability-secret.txt
   chmod 600 capability-secret.txt
   ```

2. Before dispatching the Promote that ships the presenting code, update the two existing SecureStrings in the environment-scoped SSM prefix used by the deployment controller (the private `CHALK_MANAGED_PARAMETER_PREFIX`, scoped `/chalk/production/...`). Add these keys to `<prefix>/api.env`:

   ```ini
   CHALK_PRESENTING_ENABLED=true
   CHALK_PRESENTING_CAPABILITY_SECRET=<48 random bytes, base64 encoded>
   CHALK_PRESENTING_RENDERER_FUNCTION_NAME=chalk-production-document-renderer
   ```

   Ensure `CHALK_RECORDING_KMS_REGION` and the existing R2 keys are present; the preflight requires them when presenting is on. Add `CHALK_PRESENTING_ENABLED=true` to `<prefix>/sync.env` when that same Promote ships the Sync presenting code. For an API-only intermediate rollout leave the Sync value `false`; Sync `true` with API `false` is invalid and is rejected. Preserve each parameter as a SecureString and preserve its KMS key when overwriting; fetch the current `KeyId` with `aws ssm describe-parameters` and pass it as `--key-id`.

3. Run the normal `Promote newest held nightly` workflow for the exact held release that ships the presenting code. The deployment controller fetches these SecureStrings as part of that new release's deploy, so the first boot of the release already has the intended API and Sync values. Never use a same-release deploy as a flag reload: an already-active release reports success before fetching changed SecureStrings, so a later flag change takes effect only with the next managed release.
4. Verify `/readyz` reports `capabilities.presenting: "enabled"` after that Promote, then present one real small PDF in a production Space and confirm pages render and follower page state survives a reload. Check the renderer log group for invocation errors and the API log for `presenting.config_incomplete` (there must be none). Do not treat `deploy-managed-release.mjs --dry-run` as evidence for this step: it exits before the host SSM input step, so it can check local preflight inputs but does not prove the changed SecureStrings reached or were applied on the host.

Undo:

1. Use the database kill switch in [Turn off presenting](#turn-off-presenting) first; it takes effect without a restart or input reload and leaves the renderer idle.
2. A later SSM flag change, including setting `CHALK_PRESENTING_ENABLED=false` or removing the presenting keys, takes effect only with the next managed release. Write the desired values before that release; do not expect the current active release to reload them in place.
3. The container-image renderer (the `-image` function) is selected by `CHALK_PRESENTING_RENDERER_FUNCTION_NAME`. If it misbehaves, write `chalk-production-document-renderer` back into that value and ship it with the next managed release: the ZIP function stays deployed and unchanged until the image path has shipped once, so this needs no AWS change. See [rolling back from the image to the ZIP renderer](../../infrastructure/document-renderer/README.md#rolling-back-from-the-image-to-the-zip-renderer).
4. Renderer code has no rollback while `CHALK_RENDERER_RELEASE_ENABLED` is unset. Managed rollback leaves the renderer untouched, so the renderer keeps its bootstrap version. Step 1 is the undo for presenting, and rolling renderer code back needs the follow-up in [issue #1705](https://github.com/Q9Labs/chalk/issues/1705). Do not edit Lambda code, IAM or Alchemy state by hand.

### Turn off presenting

`CHALK_PRESENTING_ENABLED` is the startup default: off in production, on in local development, staging, nightly and Orbs. For a rollback without a restart, use the application's direct database connection with the operator role:

```sql
insert into presenting_settings (singleton, enabled) values (true, false)
on conflict (singleton) do update set enabled = excluded.enabled;
```

The API decides whether it can serve presenting (the flag is on and its configuration is complete) and publishes that answer to `presenting_api_capability` at startup. Sync offers presenting only while that row says servable and the override above allows it, so a Present control never appears for an API that would answer `presenting.disabled`. The Sync default only applies until an API release that publishes has started.

API `/readyz` shows `capabilities.presenting: disabled` on the next request. Participant presenting routes then reject new reads and writes with `presenting.disabled`; live calls, chat attachments and screen shares stay in place. Renderer control claims are rejected while the switch is off. Leases already issued may drain only through their completion, failure, heartbeat, page-ready and zoom-completion callbacks; their object writes remain unpublished if their lease has expired. No new Document can be created while the switch is off.

Use the same statement with `true` to turn presenting back on, or `delete from presenting_settings where singleton;` to use the startup default again.

## Never stop the production node

Stopping the production node ends every live call and every recording on it. Deploys, hotfixes and rollbacks run through SSM and the deployment controller on the running node, so no release step ever stops or reboots the instance. EC2 stop protection (`DisableApiStop`) therefore blocks only a manual stop, and a real deploy runs as before. It does not block a reboot, a shutdown started on the node (`shutdown`, `poweroff`) or a stop that AWS starts for a scheduled event. It does block termination through the console, CLI or API.

The protection is a setting on the instance, not a file in Git. The instance ID is in the private operator notes. Run these with the operator AWS profile:

```sh
aws ec2 describe-instance-attribute --instance-id <production instance id> --attribute disableApiStop
aws ec2 modify-instance-attribute --instance-id <production instance id> --disable-api-stop
```

A stop call now fails with `OperationNotPermitted`. To stop the node on purpose, do it outside an incident and tell the owner first. Undo the protection with `aws ec2 modify-instance-attribute --instance-id <production instance id> --no-disable-api-stop`, stop the node, then turn the protection on again after it starts. An agent that holds the same credentials can still remove the protection, but only with that explicit second call.

## Postmortem

Write five lines within two working days, and ship the last line.

1. What users saw, and from when to when.
2. What changed, and how we found out.
3. Why the checks did not stop it.
4. What restored service, and how long each step took.
5. The check, test or alert that now fails when this happens again: link the change.
