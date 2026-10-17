# Managed Release

`Release` is the backend and web entry point. It has no push trigger.
Manual `managed_environment` defaults to **nightly**, never production.
Choose `production` explicitly for an operator production release.

## Nightly cut

`Cut nightly` runs daily at 02:17 UTC on master.
Scheduled cuts require new commits since the last completed cut and at most
one cut attempt per UTC day, reserved before builds. Failures do not advance the baseline.
A manual dispatch always attempts a cut, including an unchanged source.
Both paths require the latest master Gate run/attempt for the pinned SHA to pass.

Before builds, the existing component planner checks worker dependencies.
Renderer workspace inputs and transcription Lambda build inputs must not change.
Unsupported changes fail with the manual recorder/Lambda release paths.
This first rollout does not build or activate new external workers or Lambda code.
The existing deployment-time dispatcher binding still runs.

Release builds changed backend images and two target-specific web archives.
After nightly deployment, the real-call workflow runs `smoke transcript`.
A passed call and the controller's checked applied release ID create a held
`nightly` deployment record. It contains the source SHA, run/artifact IDs,
SHA256 hashes, applied identity and proof result. Artifact retention is 365 days.
Every nightly backend or web write first records a durable current-write marker
under the nightly lock and invalidates older held identities. Manual web-only
releases count too. Recording or selecting held proof requires that newest marker
to match the run and applied identity; retrying an older record job cannot revive it.
Completed-cut history remains.
Failed nightly deployments/calls stay unheld; nightly never auto-rolls back.

## Promote

Dispatch `Promote newest held nightly` from master with no inputs.
It selects the newest successful, proof-passed nightly, breaking timestamp ties
by deployment ID. There is no age cutoff and no fallback to an older choice.
The exact selection, all three artifacts, ancestry, latest Gate and rollback
manifest are checked before approval. Missing/expired/corrupt files fail clearly.
The exact status, payload and previous production source are rechecked after approval.

The parent holds `chalk-environment-production` across approval, deploy, call
and rollback. **Pending approval holds this lock**, blocking other production
Releases. Children use a separate run lock; the backend keeps its deploy lock.

Production receives the selected image digests and prebuilt production web.
There is no image/web rebuild or staging web upload during promotion.
The source manifest hash is verified before the existing manifest generator
creates a fresh envelope: a new top-level release ID, unchanged image digests
and component source identities, including migration requirements. A fresh request ID includes this release ID.
The deployment result and job summary record source and applied identities.
The controller's verified identity plus the call are the served-identity evidence.
No additional observer service or host exact-replay support is required.

## Recovery

Before mutation, promotion finds the latest successful production backend
deploy's retained manifest and checked deployment result in its Release run.
This also works for the existing production release; no proof record is seeded.
It saves the production Pages project's canonical deployment ID before upload.
The saved backend references and Pages ID are retained in a rollback artifact.

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
