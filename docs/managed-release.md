# Managed backend releases

The **Release** workflow (`.github/workflows/ci.yml`) is the operator entry point
for managed API and Sync deployments, including recorder input reloads. Never
build in CI and then deploy locally with SSM, `release:recorder deploy`, or a
non-dry-run `deploy-managed-release.mjs`. A green build is not a deployment.

## Deploy

Run the required gates first. Use the approved full source SHA and the last
healthy manifest's workflow run ID. Select a configured GitHub environment:

```sh
gh workflow run ci.yml --repo Q9Labs/chalk --ref master -f target_sha="$SOURCE_SHA" -f stable_manifest_run_id="$STABLE_RUN_ID" -f release_managed=true -f deploy_managed=true -f managed_environment="$ENVIRONMENT" -f deploy_web=false
```

Watch the returned run through completion. The managed job must succeed, not be
skipped. Inspect its summary and `managed-deployment-*` proof artifact: host
health must pass, rollback must be false, and the dispatcher must be verified.
Legacy staging reports `not-configured` unless its dispatcher parameter is set.
Run the environment's real-call proof after deployment; controller readiness
alone does not prove a call, recording, or export.

To redeploy the current images without rebuilding, use the current manifest's
`source_revision` and its own run ID as the baseline. The planner retains image
digests and component identities but creates a fresh envelope, avoiding the
host's immutable-release duplicate guard. Do not reuse a prior request ID.

## Environment configuration

Each environment needs `CHALK_MANAGED_AWS_REGION`, `CHALK_MANAGED_DEPLOY_ROLE_ARN`,
`CHALK_MANAGED_INSTANCE_ID`, `CHALK_MANAGED_LOG_GROUP_NAME`,
`CHALK_MANAGED_PARAMETER_PREFIX`, and `CHALK_MANAGED_SSM_DOCUMENT_NAME` variables.
The role's OIDC trust must name that exact GitHub environment. Names use at most
32 lowercase letters or digits, separated by single hyphens and starting with a letter. The default
remains `staging`; choosing a name does not provision its infrastructure.

Non-staging environments require their own recorder configuration at
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

The job logs the SSM command ID before waiting. Use that ID in the environment's
deployment log group; GitHub's SSM error text can be truncated. The summary only
reports success after host health and dispatcher verification both pass. The
host poll cancels after 30 minutes; the one-hour job allows dispatcher plans.
If a build succeeds but deployment fails, fix the cause and redispatch with the
healthy manifest baseline. Do not bypass CI to turn a failed release green.
For read-only diagnosis, `deploy-managed-release.mjs --dry-run` validates inputs
and reads dispatcher configuration/state without sending a host command.
