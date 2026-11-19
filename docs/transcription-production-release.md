# Production transcription release

This runbook keeps the rules for releasing transcript-first transcription to production. It holds no account identifiers, secret values, provider payloads or operational evidence. Keep those in the protected release workspace.

## Constraints

- The dispatcher is a Node.js arm64 Lambda with no VPC attachment, NAT gateway, database access or reusable object-storage permission. It reads credentials only from exact SSM SecureString ARNs, calls the control API over public authenticated HTTPS, and receives only job-scoped presigned R2 authorities. Its [Alchemy stack](../infrastructure/transcription-dispatcher/README.md) is `infrastructure/transcription-dispatcher/alchemy.run.ts`, pinned at `2.0.0-beta.87`.
- The provider is direct DeepInfra with an adapter contract version. Set `deepinfra_enabled = true` and `cloudflare_enabled = false`. Do not substitute Cloudflare, a VPC/NAT design or a rendered MP4 path to get around a blocker.
- The provider corpus digest is mandatory when DeepInfra is enabled. It must be the digest of the retained, passing qualification corpus for this adapter and model. A short request or a made-up digest does not qualify. Optional execution-identity and model-version pins stay absent until the provider returns a stable value to assert. They are not qualification evidence.
- The release owner confirms outside this repo that the provider account is active, funded as intended and has automatic top-ups disabled.
- Transcript-first capture bundles live under `tenants/<tenant>/recordings/<recording>/capture/`, outside the 24-hour R2 lifecycle prefixes (`transcription/chunks/` and `transcription/orphans/`, component `r2-transcription-lifecycle`), so no broad R2 lifecycle change is needed. The API keeps the source authority and cleanup fencing valid for the recording source and Export window (30 days, capped in `artifactpolicy`). Transcript retention is unchanged.
- A legacy immutable Episode snapshot with `recording.retention_seconds = 0` resolves to the same capture-anchored 30 days. The API does not rewrite Tenant, Space or Episode policy, and an explicit positive snapshot value stays authoritative. Watch or Download requests never renew the window.
- The transcription source window bounds audio preparation. It is capped by the recording window and may end earlier without changing Export availability.

## Release path

Use [Nightly and Promote](managed-release.md). Never publish a ZIP, deploy it by hand or bypass the guarded Alchemy driver, because those paths skip the build binding, proof and rollback guards. Promote copies the exact verified ZIP bytes and never rebuilds them. Rollback selects the prior recorded ZIP and image pins. Each environment keeps its own redacted Alchemy stack inputs, SSM references, audience, roles, queues and alarms. The driver checks a complete in-memory plan, applies that same object, verifies the exact ZIP hash and requires a second all-no-op plan. An environment with no Alchemy state fails before deployment.

## Disable and recovery

`CHALK_TRANSCRIPTION_ENABLED=false` stops new transcription jobs. It does not prove that queued jobs have drained. To recover:

1. Disable scheduler delivery and new job admission.
2. Use the API-owned fenced claim and reconcile path to drain or terminally resolve every transcription, finalization and cleanup job.
3. Confirm both dispatcher dead-letter queues are empty before you change any recorder or API component.

Keep the API migration forward-only. Do not restore an older recorder image while new transcript jobs remain active.

A missing corpus qualification, private secret comparison, invoke-role policy or required endpoint is a release blocker.

## Cut production over to Alchemy

Do this only after the [ephemeral dispatcher release proof](../infrastructure/migration/README.md#ephemeral-release-gate-for-production-cutover) passes through deploy, release, no-op re-plan and complete teardown. There is no persistent Nightly stage. Stop
concurrent infrastructure writers. Keep the pre-cutover commit and all evidence
in the protected workspace. Read and back up the original state without changing
it. Run from the repository root:

```sh
export CHALK_AWS_ACCOUNT="$(aws --profile q9labs sts get-caller-identity --query Account --output text)"
export CHALK_PRODUCTION_TOFU_STATE="$(mktemp)"
chmod 600 "$CHALK_PRODUCTION_TOFU_STATE"
aws --profile q9labs s3api get-object --bucket "chalk-production-state-${CHALK_AWS_ACCOUNT}-ap-southeast-1" --key production/transcription-dispatcher/terraform.tfstate "$CHALK_PRODUCTION_TOFU_STATE" >/dev/null
aws --profile q9labs s3api copy-object --bucket "chalk-production-state-${CHALK_AWS_ACCOUNT}-ap-southeast-1" --key "production/transcription-dispatcher/backups/$(date -u +%Y-%m-%dT%H-%M-%SZ)/terraform.tfstate" --copy-source "chalk-production-state-${CHALK_AWS_ACCOUNT}-ap-southeast-1/production/transcription-dispatcher/terraform.tfstate" >/dev/null
AWS_PROFILE=q9labs pnpm --dir infrastructure exec tsx migration/seed.ts transcription-dispatcher production "$CHALK_PRODUCTION_TOFU_STATE" --dry-run
```

Capture live facts before the seed. This command records environment variable
names, never values:

```sh
AWS_PROFILE=q9labs python3 infrastructure/migration/transcription-evidence.py --tofu-state "$CHALK_PRODUCTION_TOFU_STATE" --output "$CHALK_PRIVATE_EVIDENCE/production-before.json"
```

Seed in one command, then plan in one command:

```sh
AWS_PROFILE=q9labs CHALK_ALLOW_PRODUCTION_SEED=1 pnpm --dir infrastructure exec tsx migration/seed.ts transcription-dispatcher production "$CHALK_PRODUCTION_TOFU_STATE"
AWS_PROFILE=q9labs pnpm --dir infrastructure exec tsx releases/driver.ts plan production
```

Expect only `noop` for `Logs`, `AsyncFailure`, `SchedulerDlq`, `ExecutionRole`,
`Function`, `SchedulerRole`, `Reconcile`, `SchedulerPermission`, `Errors`,
`Throttles`, `AsyncEventsDropped`, `AsyncFailureDepth` and
`SchedulerTargetErrors`. If configured, `ControlApiPermission` is also a no-op.
A create, replacement or deletion stops the cutover. Do not apply to repair a
rejected plan. Do not open production Alchemy state before this authorized seed;
normal plans take a DynamoDB lease.

After seed and plan, require read-only drift detection and unchanged live facts:

```sh
AWS_PROFILE=q9labs pnpm --dir infrastructure exec alchemy drift --config transcription-dispatcher/alchemy.run.ts --stage production
AWS_PROFILE=q9labs python3 infrastructure/migration/transcription-evidence.py --tofu-state "$CHALK_PRODUCTION_TOFU_STATE" --output "$CHALK_PRIVATE_EVIDENCE/production-after.json" --compare "$CHALK_PRIVATE_EVIDENCE/production-before.json"
```

Never run `tofu destroy`, `alchemy destroy` or `alchemy nuke`. The original
OpenTofu objects and their dated backups remain untouched.

## Roll back

For a release rollback, select the prior recorded manifest through the normal
[managed release rollback](managed-release.md) path. It selects the previous
versioned ZIP and verifies its digest without rebuilding or changing ownership.

For an infrastructure-ownership rollback, stop all Alchemy writers. Save the
current Alchemy state privately, then forget only the affected stage's records:

```sh
AWS_PROFILE=q9labs pnpm --dir infrastructure exec alchemy state delete transcription-dispatcher/nightly --config transcription-dispatcher/alchemy.run.ts --recursive
```

For production, replace `nightly` in the **state path** with `production`; the
entrypoint path stays the same. `state delete` forgets records and outputs, not
AWS resources. Restore the dispatcher module, Nightly caller and release scripts
from the retained pre-cutover commit. Initialize against the original backend
and inspect its plan with the untouched OpenTofu state. Later Alchemy releases
may have changed the live ZIP, so do not assume that plan is a no-op or apply it
without review. Never run both owners. Do not deploy Alchemy again after deleting
its state without reseeding.
