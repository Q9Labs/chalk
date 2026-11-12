# Production transcription release

This runbook keeps the rules for releasing transcript-first transcription to production. It holds no account identifiers, secret values, provider payloads or operational evidence. Keep those in the protected release workspace.

## Constraints

- The dispatcher is a Node.js arm64 Lambda with no VPC attachment, NAT gateway, database access or reusable object-storage permission. It reads credentials only from exact SSM SecureString ARNs, calls the control API over public authenticated HTTPS, and receives only job-scoped presigned R2 authorities. Its module is `infrastructure/opentofu/modules/aws-transcription-dispatcher`.
- The provider is direct DeepInfra with an adapter contract version. Set `deepinfra_enabled = true` and `cloudflare_enabled = false`. Do not substitute Cloudflare, a VPC/NAT design or a rendered MP4 path to get around a blocker.
- The provider corpus digest is mandatory when DeepInfra is enabled. It must be the digest of the retained, passing qualification corpus for this adapter and model. A short request or a made-up digest does not qualify. Optional execution-identity and model-version pins stay absent until the provider returns a stable value to assert. They are not qualification evidence.
- The release owner confirms outside this repo that the provider account is active, funded as intended and has automatic top-ups disabled.
- Transcript-first capture bundles live under `tenants/<tenant>/recordings/<recording>/capture/`, outside the 24-hour temporary prefix, so no broad R2 lifecycle change is needed. The API keeps the source authority and cleanup fencing valid for the recording source and Export window (30 days, capped in `artifactpolicy`). Transcript retention is unchanged.
- A legacy immutable Episode snapshot with `recording.retention_seconds = 0` resolves to the same capture-anchored 30 days. The API does not rewrite Tenant, Space or Episode policy, and an explicit positive snapshot value stays authoritative. Watch or Download requests never renew the window.
- The transcription source window bounds audio preparation. It is capped by the recording window and may end earlier without changing Export availability.

## Release path

Use [Nightly and Promote](managed-release.md). Never publish a ZIP, deploy it by hand or apply OpenTofu directly, because those paths skip the build binding, proof and rollback guards. Promote copies the exact verified ZIP bytes and never rebuilds them. Rollback selects the prior recorded ZIP and image pins. Each environment keeps its own module inputs, SSM references, audience, roles, queues and alarms.

## Disable and recovery

`CHALK_TRANSCRIPTION_ENABLED=false` stops new transcription jobs. It does not prove that queued jobs have drained. To recover:

1. Disable scheduler delivery and new job admission.
2. Use the API-owned fenced claim and reconcile path to drain or terminally resolve every transcription, finalization and cleanup job.
3. Confirm both dispatcher dead-letter queues are empty before you change any recorder or API component.

Keep the API migration forward-only. Do not restore an older recorder image while new transcript jobs remain active.

A missing corpus qualification, private secret comparison, invoke-role policy or required endpoint is a release blocker.
