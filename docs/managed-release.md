# Managed release

Three workflows ship the managed backend and web: `Release` (`.github/workflows/ci.yml`), `Cut nightly` (`.github/workflows/nightly.yml`) and `Promote newest held nightly` (`.github/workflows/promote.yml`). The workflows hold the exact steps and inputs. This page keeps the reasons and the rules you must not break.

## Principles

- Production never builds. Nightly builds and proves a release once. Promote ships those exact bytes: image digests, web archive, recorder archives and the dispatcher ZIP. A rebuild would ship something nobody proved.
- Nightly is isolated. It has its own AWS role, state, Pages project, bucket and recorder config. No nightly credential may touch production, and nightly config never points at production state.
- Rollback comes from durable evidence, not from Actions artifacts. Before host mutation, a production deploy stores the exact manifest bytes and their SHA256 in a `production-release` GitHub deployment payload. Only a complete, healthy deploy marks it successful. Rollback verifies the hash, builds a fresh envelope from the previous source, and restores the web through Pages' native rollback.
- Nothing is invented. A missing proof, an unreadable baseline or an expired artifact fails closed with a message that names what to do. No code path fabricates a proof result.
- Nightly never rolls back by itself. A failed nightly deploy or call stays unheld, and an operator fixes it forward.
- A direct `Release` dispatch defaults to `nightly`. Production must be chosen explicitly.

## Nightly cut

`Cut nightly` runs hourly and at most once per six hours. The six-hour gap starts when an attempt is reserved, not when it ends. A cut ships the newest master commit whose push Gate passed. A manual dispatch always attempts a cut, but still requires the Gate of the pinned SHA to pass. Both workflows refuse a non-master ref.

A cut becomes held only when the own-SFU (`chalk_sfu`) real-call proof and the web-call proof both pass on the freshly deployed nightly. The staging latency run is not part of the cut: `.github/workflows/staging-sfu-latency.yml` measures the newest held nightly when a cut finishes (about 50 minutes later, for 60 cycles of about 45 seconds; also daily and on dispatch) and records a verdict bound to that SHA, and Promote refuses a SHA with no passing verdict (`own_sfu_proof_result=latency-missing`), so Promote waits for that run. The measurement runs the cut's own `features/scorecard/staging-latency.mjs`, so a fix to it reaches a cut only through a new cut; the verdict is recorded only while staging still runs that cut. Each nightly write records a durable marker under the nightly lock and invalidates older held releases, so retrying an old record job cannot revive it.

If the saved build baseline has expired, the cut rebuilds the saved set of enabled components. A baseline too old to say which components were enabled fails closed instead of turning recording off. Fix it with a new explicit `Release` baseline.

`enable_recorder_control=false` gives a backend-only nightly bring-up. Set `CHALK_RECORDING_ENABLED=false` and `CHALK_TRANSCRIPTION_ENABLED=false` in nightly's runtime config first, because the input does not rewrite SSM values. Production ignores the input and keeps recorder control from its baseline.

Recorder archives are content-addressed (`recorder/<role>/<sha256>.tar.gz`) and built on the runner without DigitalOcean credentials. A recorder host gets a short-lived download URL from the controller, so no AWS credentials live on a host. Snapshot v2 holds no hostname or CA: cloud-init installs the environment's own. The sidecar `<release_id>.media.json` binds snapshots, archives, hashes and the dispatcher ZIP identity to the release.

## Promote

Dispatch from master with `expected_sha`, the held revision you approve. Selection fails if the newest held release is not that SHA, and there is no fallback to an older one. The parent holds `chalk-environment-production` through approval, deploy, call and rollback, so a pending approval blocks other production releases.

Promote blocks, naming the SHA and nightly run, when:

- the own-SFU proof for that exact SHA did not pass or is missing;
- a `gate: true` budget in `perf/budgets.json` is breached, or its evidence is missing. The budgets come from the scored SHA, not the newer workflow checkout.

`scorecard_override` accepts a written reason for those two checks only. It cannot bypass SHA, artifact, Gate or rollback-source validation. The run summary and release record keep the reason and actor.

### Automatic promotion

`.github/workflows/auto-promote.yml` dispatches Promote with no person involved, behind the repository variable `CHALK_AUTO_PROMOTE`. It ships off, and an off run skips every job. Turn it on with `gh variable set CHALK_AUTO_PROMOTE --body true` and off with `gh variable delete CHALK_AUTO_PROMOTE`. A Promote already running is not stopped by the switch; it finishes, or rolls back by itself when the production call fails.

It starts after each successful Staging SFU latency run, because that verdict is the last input Promote waits for. It runs the same selection as Promote (`release.py auto_promote`) and dispatches only when the newest held nightly passes every check and production does not already run it. It never applies a `scorecard_override`. Each SHA is tried once; Promote's run name carries the SHA, so a rolled-back SHA is not tried again by the next latency run. Retrying it is a person's decision: dispatch Promote by hand. The Auto-promote run follows Promote to its end and is red when production was rolled back.

Promote's production proof runs on `chalk_sfu` through the two Spaces `promote-proof-chalk-sfu` and `promote-proof-chalk-sfu-automatic`. The `own-sfu-spaces` job moves them to `chalk_sfu` while the old release still runs. If the API refuses, an operator adds both Spaces to `CHALK_SFU_ALLOWED_SPACES`. Live Spaces keep their plane.

## Recovery

A failed production deploy or call runs `Release` again with the verified previous manifest, a fresh request ID and the saved Pages deployment ID. If recovery evidence is missing, skipped, cancelled or failed, the run stays red with `RECOVERY NOT RUN — manual recovery required` and the exact manual inputs in the summary. A verified recovery still leaves the promotion red.

When the legacy production baseline has no retained manifest, a manual production release creates the durable baseline.

## Iterate on the deployed staging build

A cut only confirms. To debug a failure, deploy master to nightly alone, then run single proofs against it. The Gate of `target_sha` must have passed, and the run queues behind a running cut.

```sh
gh workflow run ci.yml -R Q9Labs/chalk --ref master -f target_sha=<master sha> -f release_managed=true -f deploy_managed=true -f deploy_web=true -f managed_environment=nightly -f enable_recorder_control=true
```

`.github/workflows/real-call-proof.yml` runs only proof code already on master, so a fix to a proof merges first. Until then, run `pnpm prod:proof <name>` from the branch. Dispatch it with `-f environment=nightly -f media_plane=chalk_sfu -f proofs=<name>`. Runs share the staging SFU lease and wait up to 30 minutes. A busy lease fails as `staging-sfu-lease-timeout`. `latency_samples` only shortens the latency run, so its p95 is not the gate value.

## Private release state

The repository is public, so its logs, artifacts and Deployment payloads are readable by anyone. Release manifests and media pins name the AWS account, registry and bucket, so they are stored as ciphertext: the release workflows seal them with `scripts/releases/seal.py` and the repository secret `CHALK_RELEASE_SEAL_KEY` (`./.github/actions/upload-sealed` and `download-sealed` for artifacts, `manifest_sealed` and `media_sealed` in the `production-release` and `media-current` payloads). The payload keeps the plaintext sha256, which readers check after opening the file. Records from before sealing hold `*_base64` and are still read. Step summaries print no resource names or ids. Rotating the key means re-sealing the latest `production-release` and `media-current` records, because Promote's rollback reads them.

## Environment setup

- Each GitHub environment needs the `CHALK_MANAGED_*` settings the workflows read. Names that identify infrastructure (the deploy role ARN, the instance id, the registry, the media bucket) are environment or repository secrets, never variables, because the repository is public and a variable prints in the step log. The deploy role's OIDC trust must name that exact environment. Creating the name does not provision infrastructure.
- Each environment has its own recorder config at `/chalk/<environment>/release/recorder.json`. Never copy secret exclusions from another host.
- The deploy role needs the SSM document permissions and the dispatcher module permissions (state read and write, `.tflock`, versioned ZIP read and copy, Lambda binding). It never creates roles, policies or scheduler updates. See [dispatcher binding](recording-transcription.md#dispatcher-binding-during-managed-releases).
- Changes under `infrastructure/nightly/transcription/` are rejected by the media path. A root-input change needs a separately reviewed infrastructure migration.
- If a deploy fails after the host is ready, `deployment_phase=dispatcher-failed` shows the host is fine and only the dispatcher binding failed. Read the partial proof, then retry. The SSM command ID in the job log finds the full error in the environment's deployment log group. Do not bypass CI to turn a failed release green. `deploy-managed-release.mjs --dry-run` diagnoses without touching a host.
- First Promote after a media upgrade replaces production's recorder pins and dispatcher ZIP with the nightly-tested ones and keeps the previous pins for rollback. Existing workers drain through the normal fleet lifecycle.

## Immutable web vendor assets

Vendor files live in the R2 buckets `chalk-vendor-assets` and `chalk-vendor-assets-nightly` with no lifecycle deletion, and uploads never replace or delete an object, so an old web build always finds its files ([runtime assets](../apps/web/docs/runtime-assets.md)). `apps/web/scripts/prepare-vendor-store.ts` uploads the vendor trees and checks the routes before Pages publication. A failed upload or probe stops the release. Keep the independent vendor Worker and its binding through rollback.

CI's Cloudflare token only has Pages permission, so CI sets `CLOUDFLARE_VENDOR_WORKER_VERIFY_ONLY=true`. It checks the existing Worker routes and fails closed if the Worker is absent. A token that can deploy Workers lets CI deploy the Worker; then remove the setting.
