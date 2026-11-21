> **Plan, not authority.** This is one of our plans. It may be stale or wrong, and code, contracts and checks win wherever they disagree. Verify any claim here against code before relying on it.

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

## Replacing the running release

The dispatcher is one Lambda function that a release updates in place (code and `CHALK_RELEASE_ID` together, no alias or published version). Its wake-ups come from the API and the one-minute scheduler. The API and the dispatcher do not switch to a release at the same instant, and an invocation that started before the update keeps its old release until it ends. Every call carries the release in its signed headers.

A correctly signed call from another release is a routine outcome, not a fault. The API answers it `409 workload.release_superseded` and logs one Info line, `workload.release_superseded`, with no Warn or Error. The release is still part of the signature, so a call that names another release without a valid signature stays `401 workload.unauthorized` (Warn). The dispatcher treats the 409 on a claim as a drain: that queue logs `<queue>_release_superseded`, claims nothing and the invocation returns normally, so there is no Lambda error, asynchronous retry or dead-letter message. Work an old invocation had already leased is refused the same way when it reports back, so its lease expires and the new release claims the chunk again. The next scheduler tick reconciles anything a stopped wake-up would have started.

A `workload.unauthorized` log means a bad signature, environment, role, audience or replayed nonce, and it needs a look.

## Disable and recovery

`CHALK_TRANSCRIPTION_ENABLED=false` stops new transcription jobs. It does not prove that queued jobs have drained. To recover:

1. Disable scheduler delivery and new job admission.
2. Use the API-owned fenced claim and reconcile path to drain or terminally resolve every transcription, finalization and cleanup job.
3. Confirm both dispatcher dead-letter queues are empty before you change any recorder or API component.

Keep the API migration forward-only. Do not restore an older recorder image while new transcript jobs remain active.

A missing corpus qualification, private secret comparison, invoke-role policy or required endpoint is a release blocker.

## Production ownership

Alchemy owns the production dispatcher. Its records and inputs sit in the existing `alchemy-state` table under `transcription-dispatcher/production`, and every release goes through the guarded driver. The former OpenTofu state holds no record of these resources: its previous versions stay in the state bucket, which is versioned. Never run `tofu destroy`, `alchemy destroy` or `alchemy nuke` against production.

To check the stage, expect only `noop` from `pnpm infra plan transcription-dispatcher production` and a clean `pnpm infra drift transcription-dispatcher production`, both with `AWS_PROFILE=q9labs`. A create, replacement or deletion is a stop: do not apply to repair it.

## Roll back

For a release rollback, select the prior recorded manifest through the normal
[managed release rollback](managed-release.md) path. It selects the previous
versioned ZIP and verifies its digest without rebuilding or changing ownership.

For an infrastructure-ownership rollback, stop all Alchemy writers and save the current Alchemy state privately. Restore the previous version of the former OpenTofu state object from the versioned state bucket, then forget only this stage's Alchemy records:

```sh
AWS_PROFILE=q9labs pnpm --dir infrastructure exec alchemy state delete transcription-dispatcher/production --config transcription-dispatcher/alchemy.run.ts --recursive
```

`state delete` forgets production records and outputs, not AWS resources. Restore the dispatcher module, production caller, release scripts and seed tooling from the commit before the cutover, and set the registry row to `provisioner: "opentofu", seeded: false`. Initialize OpenTofu against the original backend and inspect its plan with the restored state. Later Alchemy releases may have changed the live ZIP, so do not assume that plan is a no-op or apply it without review. Never run both owners.
