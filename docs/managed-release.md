# Managed Release

`Release` is the backend and web entry point. It has no push trigger.
Manual `managed_environment` defaults to **nightly**, never production.
Choose `production` explicitly for an operator production release.

## Nightly cut

`Cut nightly` runs daily at 02:17 UTC on master.
Scheduled cuts require new commits since the last completed cut and at most
one cut attempt per UTC day, reserved before builds. Failures do not advance the baseline.
An expired or unavailable build baseline triggers a full build of the saved enabled
component set instead of forwarding dead artifact IDs. Passed cut records preserve
recorder enablement for this fallback. A pre-upgrade baseline without readable bytes
or saved component metadata fails closed rather than silently disabling recording;
a new explicit manual baseline is required. The changed-input guard still checks
the baseline source revision.
A manual dispatch always attempts a cut, including an unchanged source.
Both paths require the latest master Gate run/attempt for the pinned SHA to pass.

Before builds, the existing component planner checks worker dependencies.
Renderer workspace inputs and transcription Lambda build inputs must not change.
Unsupported changes fail with the manual recorder/Lambda release paths.
The dispatcher fingerprint includes all `infrastructure/` inputs, so these changes
also fail before a cut can mutate nightly.
This first rollout does not build or activate new external workers or Lambda code.
The existing deployment-time dispatcher binding still runs.

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

Merge real-call proof PR #255 and nightly environment PR #268 before enabling.
Configure nightly managed deployment variables and proof Tenant credentials as
listed in the lane report and the proof workflow. Give nightly its own Pages
account/project and token. Its recorder configuration must point to PR #268's
nightly dispatcher caller and nightly state (`transcription/terraform.tfstate`
in the nightly backend bucket), initially with `scheduler_state=DISABLED`.
The binding carries the state forward without changing the scheduler policy.
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
