# Managed Release

`Release` is the backend and web entry point. It has no push trigger.
Manual `managed_environment` defaults to **nightly**, never production.
Choose `production` explicitly for an operator production release.

For backend-only nightly bring-up, set `enable_recorder_control=false`. Release
omits recorder control, media builds and dispatcher binding, even if the build
baseline enabled them. Set `CHALK_RECORDING_ENABLED=false` and
`CHALK_TRANSCRIPTION_ENABLED=false` in nightly's API runtime configuration first;
this input does not rewrite SSM values. This mode is not a held nightly. Cut still
enables recording and requires `smoke transcript` plus the web-call proof.
Promote rejects held records without immutable media. Release also rejects any
production manifest without recorder control
before writing the deployment envelope or acquiring deployment credentials.
Production preserves recorder control from its baseline even when the input is
false. Legacy direct production releases need no media sidecar; Promote still
requires one for a selected nightly.

## Nightly cut

`Cut nightly` checks master's current tip hourly, at 17 minutes past the hour.
Automatic cuts require a successful push Gate for that exact tip, new commits
since the last completed cut, and at least 6 hours since the last cut attempt.
Each check reads the current tip and requires its workflow revision to match.
A queued older scheduled workflow waits for the next check. A stale manual
request queues a fresh manual run on master, retaining its deliberate override.
Neither path cuts an older Gate commit.
A tip skipped during the cooldown is retried without another push.
The 6-hour interval starts at reservation, not at completion. Completed cuts
supply the timestamp only when no reservation exists from older workflows.
Failures do not advance the baseline. The shared nightly lock retains queued
checks, including manual dispatches, instead of replacing the pending request.
An expired or unavailable build baseline triggers a full build of the saved enabled
component set instead of forwarding dead artifact IDs. Passed cut records preserve
recorder enablement for this fallback. A pre-upgrade baseline without readable bytes
or saved component metadata fails closed rather than silently disabling recording;
a new explicit Release baseline is required.
A manual dispatch always attempts a cut, including an unchanged source.
Manual cuts still require the latest master Gate run/attempt for the pinned SHA to pass.
A direct Release dispatch that builds fresh artifacts has the same rule: its first
job fails unless the latest push, schedule or manual Gate run on master for
`target_sha` passed. A Release that scheduled nightly starts checks only push
Gate runs, the same rule its plan used. Pull request Gate runs do not count. Only a run that builds
nothing new skips it: reuse (`manifest_run_id`) deploys artifacts that an earlier
run built. A `pages_rollback_id` alone does not skip it, because the fresh builds
still run.

The path-filtered Release contracts PR workflow runs the pre-deploy checks without
cloud credentials. Release's planning job uses the same `check-contracts.sh --plan`
entry point for source, controller and managed-deployment checks. The full check
also covers retained releases, media, recorder validation, dispatcher tests and
configuration, and workflow lint. It collects all failures before exiting.
`qualify-image.py --validate --root <image-root>` verifies manifest/file bytes
without executing a worker; it does not claim signed boot qualification.

Release builds capture and render archives on the Ubuntu 24.04 runner. The base
snapshots stay unchanged. Capture carries static Go; render includes pinned Node,
the compositor and its native modules. New nodes run no build preparation.
Archives are conditional uploads to `recorder/<role>/<sha256>.tar.gz` in the
existing media artifact bucket. The controller uses its host role to issue a
short-lived GET; no AWS credentials go on a recorder. Cloud-init verifies the
archive, stages a release directory and switches `current` before the unchanged
bootstrap verifies installed files and obtains identity.

The backend artifact includes `<release_id>.media.json`: base snapshot IDs,
archive keys and SHA256, installed-manifest digests, recorder release IDs,
source/input hashes and the versioned dispatcher ZIP identity. Promote retains
this sidecar unchanged, copies and verifies exact archives into the production
bucket, and selects that bucket through runtime pins. It never rebuilds payloads.
`retain_runtime` reads existing production pins only for the first promotion's
legacy rollback source; it does not create or modify a snapshot. Base rebuilds
remain separate infrastructure operations.

Before either fleet pin changes, deployment reads both snapshots from DigitalOcean
using each environment's existing fleet token. Each snapshot must be available in
its role's configured region and fit its configured fleet size's disk.

Snapshot v2 contains no environment hostname or CA. Fleet cloud-init installs the
target environment's public bootstrap CA and hostname before signed bootstrap.
Production and nightly keep their own certificates, private keys, tags and state.
After nightly deploy, two isolated cold-boot diagnostics verify signed identity;
workers cannot take live work during those diagnostics. A failed diagnostic fails
the cut. Production Promote records the previous media members before mutation,
including the legacy first-promotion baseline, and rollback restores those pins.

Release builds changed backend images and two target-specific web archives.
After nightly deployment, the real-call workflow runs `smoke transcript`.
A passed call and the controller's checked applied release ID create a held
`nightly` deployment record. It contains the source SHA, run/artifact IDs,
SHA256 hashes, applied identity and proof result. Actions artifacts are retained for 90 days (the public-repository maximum).
Every nightly backend or web write first records a durable current-write marker
under the nightly lock and invalidates older held identities. Manual web-only
releases count too. Recording or selecting held proof requires that newest marker
to match the run and applied identity; retrying an older record job cannot revive it.
Completed-cut history remains.
Failed nightly deployments/calls stay unheld; nightly never auto-rolls back.

## Promote

Dispatch `Promote newest held nightly` from master with no inputs.
It selects the newest successful, proof-passed nightly, breaking timestamp ties
by deployment ID. Deployment lookups filter environment and task, stop at the
first decisive record, and fetch statuses only for matching candidates. Nightly
records use only their dedicated tasks; no legacy nightly records exist.
There is no age cutoff and no fallback to an older choice.
The exact selection, all three artifacts, ancestry, latest Gate and rollback
manifest are checked before approval. Missing/expired/corrupt files fail clearly; an expired web archive says "cut a new nightly".
Both Nightly and Promote refuse non-master dispatches in their first step.
The exact status, payload and previous production source are rechecked after approval.

The parent holds `chalk-environment-production` across approval, deploy, call
and rollback. **Pending approval holds this lock**, blocking other production
Releases. Children use a separate run lock; the backend keeps its deploy lock.

Production receives the selected image digests and prebuilt production web.
There is no image/web rebuild or staging web upload during promotion.
The source manifest hash is verified before the existing manifest generator
creates a fresh envelope: a new top-level release ID, unchanged image digests
and component source identities, including migration requirements and exact
`runtime_artifacts`. SSM downloads `archive/$SSM_SourceRevision.tar.gz` from the
manifest source revision. It verifies the old controller hash before execution;
the controller verifies scripts and contracts from that same source archive.
The workflow checkout never supplies replacement runtime hashes. A fresh request ID includes this release ID.
The deployment result and job summary record source and applied identities.
The controller's verified identity plus the call are the served-identity evidence.
No additional observer service or host exact-replay support is required.

## Recovery

Before host mutation, every production deployment stores exact manifest bytes
(base64) and their SHA256 in a `production-release` GitHub deployment payload.
Only a complete, healthy deployment marks that record successful. Selection uses
the newest healthy record, and rollback verifies its hash and source identity
before generating a fresh envelope. Neither manifest download nor rollback needs
retained Actions artifacts or even the old Actions run.

The first selection can adopt the existing production Release only after checking
its successful deploy result and exact retained manifest. It copies those bytes
into the same durable deployment payload during approved recheck, under the
production lock and before host mutation. Nightly planning only reads this evidence. If those legacy files
are already missing, perform a manual production release to establish the durable
baseline; selection fails closed. No proof result is invented.
GitHub documents `payload` as JSON deployment data with no smaller payload limit
listed in its [REST deployment reference](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment).
Deploy manifests already fit the SSM document's 48,000-character base64 bound.
A rejected payload fails before host mutation; no bucket or new storage service is added.
It saves the production Pages project's canonical deployment ID before upload.
The saved backend references and Pages ID also appear in a 90-day rollback artifact;
that artifact is a convenience copy, not the backend rollback source of truth.

A failed production deploy/call invokes Release again with the verified previous
manifest, another fresh envelope/request ID, and the saved Pages deployment ID.
Pages' native rollback restores the old web; no old web archive is needed.
Recovery jobs and their mutation steps use `always()` semantics even on cancellation.
Recovery requires the applied ID to match the fresh recovery envelope that preserves
the previous production source, plus the canonical Pages ID to match the saved ID.
Missing, skipped, cancelled or failed recovery evidence keeps the run red with
`RECOVERY NOT RUN — manual recovery required` and exact manual Release inputs in
the summary. A verified recovery also leaves the promotion red. No nightly rollback exists.

## Manual Release and setup

`deploy_web=true` builds and uploads web without any extra build switch, including
web-only releases with `release_managed=false`. Tooling stays at the workflow
revision; an explicit source root holds the requested full SHA and must match it.
The served service-worker commit, target API health and release marker retry within
90 seconds. Production's `chalk` Pages destination comes from the existing web
release constant, passed explicitly for upload, capture and rollback; no fallback exists.
Reuse accepts exact manifest run,
artifact, source release ID and hash, plus the prebuilt target web artifact/hash.
Production keeps its existing Pages account/project, credentials and legacy
`--adopt-existing-release` behavior. New configuration is nightly-only.

Before enabling managed nightly deployment, merge the real-call proof and
nightly environment changes. Configure nightly deployment variables and proof
Tenant credentials as listed in the lane report and proof workflow. Give nightly
its own Pages account/project and token. Point its recorder configuration at
the nightly dispatcher caller and nightly state
(`transcription/terraform.tfstate` in the nightly backend bucket). The first
Release installs the dispatcher and enables its one-minute scheduler. Enable
the Cut nightly workflow only after first-cut approval.
Never point nightly configuration at production state or credentials.

## Environment configuration and deployment evidence

Each environment needs `CHALK_MANAGED_AWS_REGION`, `CHALK_MANAGED_DEPLOY_ROLE_ARN`,
`CHALK_MANAGED_INSTANCE_ID`, `CHALK_MANAGED_LOG_GROUP_NAME`,
`CHALK_MANAGED_PARAMETER_PREFIX`, and `CHALK_MANAGED_SSM_DOCUMENT_NAME` variables.
The role's OIDC trust must name that exact GitHub environment. Names use at most
32 lowercase letters or digits, separated by single hyphens and starting with a letter. The default
is owned by the Release workflow; select `nightly` explicitly for the isolated stack.
Choosing a name does not provision its infrastructure.

All environments require their own recorder configuration at
`/chalk/<environment>/release/recorder.json`. Override this with the optional
`CHALK_MANAGED_RECORDER_CONFIG_PARAMETER`, scoped to the same environment.
The configuration must match the target instance and runtime prefix.
`CHALK_MANAGED_SECRET_EXCLUSIONS` can hold approved comma-separated canonical
input IDs. A nonempty `managed_secret_exclusions` dispatch input overrides it.
Missing inputs otherwise fail closed; never copy exclusions from another host.

The deployment role needs the constrained SSM document/host permissions **and**
the dispatcher module's read/apply permissions: configuration read, exact state
read/write and `.tflock` management, versioned ZIP read/copy, Lambda binding and
log tagging. Full plans also refresh existing IAM, queue, schedule and alarm
state. No role/policy creation or scheduler updates belong in this binding.
See [dispatcher binding](recording-transcription.md#dispatcher-binding-during-managed-releases).

## Failure evidence

The job logs the SSM command ID before waiting. It saves host proof before
dispatcher changes; `deployment_phase=dispatcher-failed` means the host is ready
but dispatcher binding failed. Inspect that partial proof before retrying.
Use the command ID in the environment's
deployment log group; GitHub's SSM error text can be truncated. The summary only
reports success after host health and dispatcher verification both pass. The
host poll cancels after 30 minutes; the one-hour job allows dispatcher plans.
If a build succeeds but deployment fails, fix the cause and redispatch with the
healthy manifest baseline. Do not bypass CI to turn a failed release green.
For read-only diagnosis, `deploy-managed-release.mjs --dry-run` validates inputs
and reads dispatcher configuration/state without sending a host command.
Release runs this preflight before invalidating a held cut or changing fleet pins.
The media path rejects changes under `infrastructure/nightly/transcription/`
before builds or deployment mutations. Installed dispatcher updates reconstruct
their root from state, so root-input changes require a separately reviewed
infrastructure migration before updating the supported configuration checksum.

## Media build configuration

The GitHub nightly environment permits only `master`. Recorder archive builds
run on the GitHub runner without DigitalOcean credentials. Cold-boot qualification
still uses the environment-scoped provider credentials. Set
`CHALK_MEDIA_ARTIFACT_BUCKET` and the approved `CHALK_TRANSCRIPTION_CORPUS_DIGEST`.
The host role must read both `recorder/capture/*` and `recorder/render/*` object
prefixes. The deploy role must read source recorder archives and conditionally
write target recorder archives. It must read recorder envs and the public bootstrap CA, update only
its two recorder env parameters, read the selected versioned source ZIP, write
its dispatcher artifact/state prefixes, and apply its own dispatcher module.
Nightly cold-boot checks additionally require scoped host RunShellScript and
private `bootdiag/` evidence access. No nightly authority may mutate production.

The first Promote after this upgrade replaces production's capture and render
base and archive pins with the exact payloads tested on nightly, then deploys nightly's
ZIP bytes to the production dispatcher and keeps its scheduler enabled. It
retains production's previous pins and ZIP for rollback. Existing workers drain
through the normal fleet release lifecycle; no cross-environment deletion is added.

## Web asset retention and first deploy

Production and nightly web uploads run only in the Release workflow's
`deploy-web` job. Its `web-production` and `web-nightly` concurrency groups
queue publishes with `cancel-in-progress: false`, including called workflows
and Pages rollbacks. Local `release:web` dispatches Release on `master` and
waits for its exact run; it never uploads directly. The requested full SHA must
have passed the latest Gate on master. GitHub CLI authentication needs workflow
write access. Build-only archives remain independent of live retention.

The manifest stores the newest four distinct asset generations per vendor,
including the current generation. Reusing a digest does not consume a slot.
Before upload, the job re-reads the live manifest and stops if it changed since
the retention read. This guard detects stale retention; Cloudflare Pages has
no compare-and-swap, so the serialized workflow remains the single writer.

A missing live manifest cannot distinguish the first deployment from later
manifest loss. From a clean checkout of the intended merged release, with
normal GitHub workflow credentials configured, bootstrap production once:

```sh
cd /Users/macmini/code/chalk
pnpm run release:web --sha "$(git rev-parse HEAD)" --without-asset-retention
```

Every later production release:

```sh
cd /Users/macmini/code/chalk
pnpm run release:web --sha "$(git rev-parse HEAD)"
```

Nightly needs its own independent one-time bootstrap:

```sh
cd /Users/macmini/code/chalk
pnpm run release:web --target nightly --sha "$(git rev-parse HEAD)" --without-asset-retention
```

Every later nightly web release:

```sh
cd /Users/macmini/code/chalk
pnpm run release:web --target nightly --sha "$(git rev-parse HEAD)"
```

For a prebuilt Release dispatch, set `without_asset_retention=true` once, then
leave it false. This forwards `--without-asset-retention` to
`scripts/releases/web.py deploy`. Cut nightly also exposes that input for its
own one-time bootstrap; scheduled cuts always leave it false. The flag can
discard retention on any later deployment and warns that older clients may
lose lazy-loaded assets. Never persist it in routine automation. If a later
manifest is missing, investigate the loss before explicitly discarding retained
assets. Never bypass the workflow by running Wrangler against shared sites.
