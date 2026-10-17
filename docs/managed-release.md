# Managed releases

GitHub owns the release loop. **Nightly cut** builds a full release from a pinned
`master` commit. **Promote newest held nightly** ships the selected backend
manifest bytes and its prebuilt production web archive. Neither promotion nor
rollback plans or builds images or web assets.

## Enablement prerequisites

Do not enable deployment until the following work is complete:

1. Merge the environment support and reusable real-call proof lanes. The proof
   interface is `environment`, `proofs: smoke transcript`, and output `result`.
2. Qualify host replay of an existing immutable release ID with identical bytes.
   The current controller rejects previously deployed IDs. That prevents exact
   rollback; keep `CHALK_IMMUTABLE_REPLAY_READY` unset until this is fixed and
   qualified. The guard blocks both nightly deployment and promotion.
3. Provision isolated runtime resources and the `nightly` GitHub environment.
   Provision the reviewed read-only `scripts/releases/observe-document.json`
   under an environment-specific SSM document name; pin its numeric version.
   The workflow checks its content before invocation. Never grant the observer
   access to a general shell document.
4. Publish a non-secret, qualified runtime artifact as `qualified-runtime.json`.
   Configure its producing run ID, artifact ID, and file SHA256. It contains
   `runtime` and `versions` with the shapes in the release-set schema. Each target
   requires capture/render release IDs, source revisions, build/content hashes,
   image IDs, bootstrap authorities and qualification hashes; the dispatcher
   needs its ZIP hash, source revision, handler/runtime, corpus hash, versioned
   bucket/key, and non-secret config hash. The dispatcher config hash excludes
   `CHALK_RELEASE_ID` and `CHALK_CONFIG_DIGEST`; the observer verifies the full
   prefixed provider digest and the selected API release binding separately. It contains no environment files,
   credentials, private call data or tokens.
5. Seed the previous production release set using a full, approved Release run
   with `build_release_set`, `deploy_managed`, and `deploy_web` enabled and
   `orchestrated=false`. It runs the same proof and records production only after
   identity checks pass. Promotion refuses to mutate without an available rollback
   set that still matches production. Do not fabricate a successful deployment.

This change does **not** build or publish worker snapshots or dispatcher ZIPs.
Those use the existing qualified artifact builder. Retained members are accepted
only if their build inputs did not change. Before deploying any backend or web,
Release checks target runtime pins and Lambda code/config against the frozen set.
If a different member needs activation, stop and use the owning runtime release
lane; there is no mutable-latest or promotion-time rebuild fallback. A rollback
also refuses mismatched runtime members rather than silently restoring half a set.

## Daily nightly

`.github/workflows/nightly.yml` runs at 01:17 UTC daily. It holds one environment
lock through deploy, proof, identity observation, and any rollback. It pins
`origin/master`, requires a successful Gate run, verifies ancestry, and compares
against the last actual nightly activation. A successful activation today or an
unchanged source means no cut. A failed attempt without activation does not move
the baseline. Automatic retries of the same failed SHA are suppressed.

Use **Run workflow** for a retry after fixing the cause. A retry can repeat a
failed activation/proof, but cannot cut a second new SHA after today's activation.
The dispatch defaults to dry-run; disable that option to deploy. Dry-run reads
GitHub and prints the decision without creating deployment records or building.

Release builds `web-nightly` and `web-production` from the same full commit.
Nightly uses explicit first-level UI, API and Sync hostnames; Sync is never
inferred by replacing an API hostname prefix. Each archive includes public config,
a config fingerprint, the prebuilt Pages Worker and its Functions API binding.
The target-specific production archive is deliberately different; its endpoint
integration is proved after promotion, not claimed to have run on nightly.

A deployment is **held** only when the immediate smoke and transcript proofs
pass and the served backend images, manifest, worker pins, Lambda code/config,
and web marker still match after the proof. Identity is also checked before the
proof. The `nightly` deployment payload stores exact artifact IDs/hashes and proof
run references; its latest status is authoritative. A failed proof or failed
promotion revokes the candidate. A newer failed/pending cut does not hide an older
held candidate. There is no soak timer, runtime-proof workflow, or nightly-held
environment. Eligibility expires after 30 days; missing/expired artifacts are
ineligible even when their source SHA is known.

## Promote and rollback

Use **Promote newest held nightly** (`promote.yml`). It has no SHA/run selector.
The dry-run default picks and verifies the same artifacts without mutation.

The selection job paginates all deployments and status histories, chooses by
activation time (not a later status update), checks Gate and `master` ancestry,
and verifies the set, backend and both web archives. It skips unavailable
candidates with an explicit reason. It prints the frozen selection and previous
production IDs/hashes **before** the protected production approval job.
After approval, it verifies that production still serves the rollback set and
rechecks the held status. Release then receives explicit immutable reuse inputs.

Promotion failure, including web, proof, or identity failure, redeploys the prior
production set through the same Release workflow. Rollback runs its own smoke,
transcript and identity checks. A failed promotion stays failed after a healthy
rollback; a failed rollback is an incident. Cancellation may stop cleanup jobs;
inspect the current served set before retrying. Environment locks use
`cancel-in-progress: false` and must not be bypassed by local release commands.

## Release entry point

`ci.yml` supports `workflow_dispatch` and `workflow_call`. `managed_environment`
defaults to `nightly`; selecting it does not create resources. Existing backend
build-only use remains supported. Set `build_release_set=true` for a full cut.
`deploy_web` now uploads only the archive for the explicit managed target; it
never builds or stages a production bundle against another backend.

`stable_manifest_run_id` is **only a component build baseline**. It does not pick
promotion bytes. Unchanged images retain their component source/release identities;
a runtime-only new cut still gets a valid manifest and release set.

Exact reuse requires `release_managed=false`, `build_release_set=false`, and all
of `manifest_run_id`, `manifest_artifact_id`, `manifest_sha256`, `reuse_release_id`,
`release_set_artifact_id`, and `release_set_sha256`. Partial or mixed build/reuse
inputs fail. The manifest checksum is checked again before AWS credentials.
Fresh hosts never receive `--adopt-existing-release` automatically. The optional
`adopt_existing_release` input is only for deliberate legacy-host adoption.

Direct Release runs use the same environment lock as the parent loops. Reusable
calls set `orchestrated=true`: the caller owns that lock through proof/rollback,
so a child never reacquires its parent's lock. Keep that internal flag off for
manual Release dispatches. The backend job retains its bounded host lock.

## Operator configuration (names only)

Create GitHub environments `nightly` and `production`; retain protected production
approvals and existing image-signing environments. No `nightly-held` is needed.

Repository variables:

- `CHALK_IMMUTABLE_REPLAY_READY`
- `CHALK_QUALIFIED_RUNTIME_RUN_ID`
- `CHALK_QUALIFIED_RUNTIME_ARTIFACT_ID`
- `CHALK_QUALIFIED_RUNTIME_SHA256`

Per-environment variables:

- `CHALK_MANAGED_AWS_REGION`
- `CHALK_MANAGED_DEPLOY_ROLE_ARN`
- `CHALK_MANAGED_INSTANCE_ID`
- `CHALK_MANAGED_LOG_GROUP_NAME`
- `CHALK_MANAGED_PARAMETER_PREFIX`
- `CHALK_MANAGED_SSM_DOCUMENT_NAME`
- `CHALK_MANAGED_RECORDER_CONFIG_PARAMETER` (optional scoped override)
- `CHALK_MANAGED_SECRET_EXCLUSIONS` (only approved missing inputs)
- `CHALK_RELEASE_OBSERVER_DOCUMENT_NAME`
- `CHALK_RELEASE_OBSERVER_DOCUMENT_VERSION`
- `CLOUDFLARE_ACCOUNT_ID`
- `CHALK_PAGES_PROJECT`

Per-environment secret: `CLOUDFLARE_API_TOKEN`. The reusable proof workflow owns
its additional environment variable/secret contract; use its runbook. Do not
inherit production runtime credentials into nightly. AWS uses environment-scoped
OIDC, not long-lived access keys. Deploy roles need the existing managed-host and
dispatcher permissions, plus parameter/Lambda reads and the exact observer
document/instance invocation. GitHub needs contents/actions read, deployments
write, and deploy/proof jobs need id-token write.

Nightly uses SSM prefix `/chalk/nightly/managed-episode` and deploy document
`chalk-nightly-managed-episode-release`. Create/verify Pages target and domain
bindings before enabling; no resource is provisioned by these workflows.

Request 365-day retention for manifests, sets and web artifacts. Confirm the
organization permits it; the selector checks actual artifact expiry. Keep active
and rollback registry digests and qualified runtime artifacts. If the organization
cannot retain enough history, add a versioned private archive before treating it
as durable; this change does not silently rebuild an expired member.

## Offline verification

Run the focused Linux check:

```sh
scripts/gates/remote.sh -- bash scripts/releases/check.sh
```

It tests first/no-change/new-commit decisions, the
UTC daily limit, explicit retry, newest-held ordering, failed/revoked/stale
records, exact-byte corruption, public config fingerprints, safe extraction,
authorization stripping on artifact redirects, both web builds, and dry-run
archive upload commands. It runs actionlint with the declared proof contract in
an isolated temporary fixture when the proof lane has not landed.

No test dispatches Release, provisions a runtime, calls a real environment, or
performs a real Pages upload. Live host replay, full-stack proof and rollback
remain enablement prerequisites, not results of offline validation.

## Names intentionally left

There is no environment-valued `staging` in the owned workflows. The old local
`scripts/deploy/deploy-web-release.mjs` still names the legacy staging Pages
project and `--skip-staging`; no workflow calls it. Retiring that project/domain
or removing its local tool requires a consumer/undo review. Historical reports
and temporary `.staging-*` archive paths are not environment configuration.
Backend/recorder naming cleanup belongs to the environment lane. `gate.yml` and
`scripts/prod-proof/**` are unchanged.
