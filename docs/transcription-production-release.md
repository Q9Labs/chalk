# Production transcription release

This runbook prepares transcript-first transcription for production without
changing production state. It is intentionally free of account identifiers,
secret values, provider request payloads, and operational evidence. Store
those inputs and redacted evidence in the protected release workspace.

## Release contract

The dispatcher is a dedicated Node.js 22 arm64 Lambda. It reads provider and
control credentials only from exact SSM SecureString ARNs, calls the control
API over public authenticated HTTPS, and receives only job-scoped presigned R2
authorities. It has no VPC attachment, NAT gateway, database access, reusable
object-storage permission, or Cloudflare fallback.

New transcript-first capture bundles are retained under
`tenants/<tenant>/recordings/<recording>/capture/`, outside the 24-hour
temporary prefix. No broad R2 lifecycle change is required for this move. The
API must keep the source authority and cleanup fencing valid for the intended
30-day recording source/Export window, including the existing key-revocation
boundary. Transcript retention remains independently unchanged.

For a legacy immutable Episode snapshot with `recording.retention_seconds = 0`,
the API resolves the deferred recording window to the same capture-anchored
30 days. It does not rewrite the Tenant, Space, or Episode policy; an explicit
positive snapshot value remains authoritative. Repeated Watch or Download
requests never renew this window.

The separately frozen transcription source window bounds audio preparation and
transcription; it is capped by the recording source/Export window and may end
earlier without changing Export availability.

The selected provider is direct DeepInfra native multipart transcription with
`openai/whisper-large-v3-turbo` and adapter contract
`deepinfra-native-whisper-turbo.v1`. Set `deepinfra_enabled = true` and
`cloudflare_enabled = false`. Optional DeepInfra execution-identity and model-
version pins are absent until the native provider actually returns a stable
identity or version that can be asserted. They are not qualification evidence.

The provider corpus digest is mandatory when DeepInfra is enabled. It must be
the digest of the retained, passing qualification corpus for this adapter and
model. A short native request or a manufactured digest cannot satisfy this
requirement. The release owner must also confirm the provider account remains
active, has the intended funding state, and has automatic top-ups disabled;
those account details do not belong in this repository.

## Release path

Use [Nightly and Promote](managed-release.md), not a manual ZIP build/upload or
OpenTofu apply. The pipeline tests and verifies each changed dispatcher build,
records its SHA256 and versioned S3 identity with the backend release, and deploys
it after the target API is healthy. First install creates the dispatcher from
the nightly module and enables reconciliation. Promote copies the exact verified
ZIP bytes to the production artifact bucket with a new object version, never a
rebuild. Rollback selects the prior recorded ZIP and image pins.

Each environment retains its own module inputs, SSM credential references,
workload audience, roles, queues and alarms. The release requires the existing
approved passing corpus digest; it does not manufacture qualification evidence.

## Disable and recovery boundary

Setting `CHALK_TRANSCRIPTION_ENABLED=false` prevents new transcription jobs but
does not prove that already queued transcript-first jobs have drained. If a
recovery is required, first disable scheduler delivery and new job admission,
then use the API-owned fenced claim/reconcile path to drain or terminally
resolve every existing transcription, finalization, and cleanup job. Confirm
both dispatcher DLQs are empty before changing any recorder or API component.
Keep the compatible API migration forward-only and do not restore an older
recorder image while new transcript jobs remain active.

Any missing corpus qualification, private secret comparison, invoke-role policy,
or required endpoint/configuration is a release blocker. Do not substitute
Cloudflare, a VPC/NAT design, optional provider pins, or a rendered
MP4 path to bypass it.
