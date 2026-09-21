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

## Non-secret inputs

Build the ZIP only from a clean, committed integrated source tree:

```sh
scripts/transcription-dispatcher/validate-contract.sh
scripts/transcription-dispatcher/build-release.sh <unique-release-id>
scripts/transcription-dispatcher/verify-artifact.sh <immutable-zip>
```

The build emits a ZIP digest, SBOM, provenance, and release manifest. Upload
the exact ZIP to the existing versioned private artifact bucket, then record
the concrete object version and SHA-256. A dirty-local-proof artifact is useful
only for local investigation and is never promotable.

Give the OpenTofu module the release ID, release-manifest digest, digest of the
non-secret runtime configuration, immutable S3 key/object version/ZIP digest,
alarm destinations, log and queue KMS key ARNs, and the two exact SSM parameter
ARNs for the API workload secret and DeepInfra token, plus the retained corpus
digest. Use the module output
`control_api_invoke_policy_json` as the complete identity policy on the
existing managed API runtime role. Do not create or guess an API role in this
module.

The dispatcher and API must use the same non-secret audience:

| API environment                                | Dispatcher input                                      |
| ---------------------------------------------- | ----------------------------------------------------- |
| `CHALK_TRANSCRIPTION_CONTROL_AUDIENCE`         | `control_api_audience` / `CONTROL_API_AUDIENCE`       |
| `CHALK_TRANSCRIPTION_WORKLOAD_AUTH_SECRET`     | value resolved from `api_workload_auth_parameter_arn` |
| `CHALK_TRANSCRIPTION_DISPATCHER_FUNCTION_NAME` | module `function_name`                                |

The API runtime validator accepts `CHALK_TRANSCRIPTION_ENABLED=true` only when
the shared workload secret is at least 32 bytes, the audience is bounded, and
the dispatcher function name is a valid Lambda name. API configuration and the
Lambda's SSM value must be compared privately before activation; never put the
secret in a plan, manifest, command argument, or log.

## Controlled activation

1. Integrate the transcript-first API release while its production capability
   remains disabled. It must create source/chunk jobs from committed recording
   tracks, not from a rendered MP4.
2. Provision the dispatcher, its failure queues, alarms, and reconciliation
   schedule with `scheduler_state = "DISABLED"`. Confirm the immutable artifact
   identity, Node.js 22/arm64 configuration, restricted SSM policy, output
   invoke policy, and both DLQs from the redacted plan.
3. Attach the exact output invoke policy to the existing API runtime role.
   Confirm that role can invoke only the dispatcher function. This is separate
   from the dispatcher-to-API HMAC authentication.
4. Create or verify the two exact SSM SecureStrings for this DeepInfra-only selection privately, configure the
   API values above, and compare the two workload-secret values out of band.
   Do not write provider tokens or API secrets as Lambda environment values.
5. Before the final cutover, record the selected release's passing corpus digest,
   privacy/commercial configuration evidence, provider-account state check,
   configured alarm destinations, and the bounded configuration
   (`max_audio_seconds <= 900`, bounded timeout, retries, batch, and
   concurrency). This records the approved provider selection; it does not
   introduce a new approval step. The scheduler is the durable reconcile,
   finalization, and cleanup path; direct API wakes are only hints.
6. In the coordinated production activation, deploy the API configuration with
   `CHALK_TRANSCRIPTION_ENABLED=true` and apply the same reviewed module input
   with `scheduler_state = "ENABLED"`. Preserve the one-minute scheduler, both
   DLQs, and all alarms.
7. Verify the API capability/readiness state, one authenticated wake, fenced
   claim/complete flow, finalization, source/result cleanup, provider cost
   units recorded as USD, scheduler delivery, empty DLQs, and alarm wiring.
   Use a transcript-first recording; do not use an MP4-only path as proof.

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
Cloudflare, OpenRouter, a VPC/NAT design, optional provider pins, or a rendered
MP4 path to bypass it.
