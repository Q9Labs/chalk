# Transcription dispatcher

This is the private Node 22 Lambda package for scale-to-zero transcription. It
claims fenced jobs through the recorder control API, reads only job-scoped R2
URLs, invokes one provider at a time, and conditionally writes one normalized
`transcript.v1` JSON document.

The package fails closed unless the environment explicitly supplies provider
policy bounds, the privacy gate, the qualified Cloudflare slug/adapter contract
and corpus digest, and (when enabled) a pinned DeepInfra execution identity and
model version. DeepInfra is omitted entirely when `DEEPINFRA_ENABLED=false`.
Provider responses, audio, display names, URLs, object keys, and tokens are
never logged or persisted by this package.

## Runtime boundary

The exported Lambda handler creates the pinned SSM client during cold start.
Tests and local harnesses can call `buildHandlerFromSsm` with an injected AWS
SSM client. The three parameter ARNs are passed explicitly through:

- `DEEPINFRA_TOKEN_PARAMETER_ARN` (only when DeepInfra is enabled)
- `CLOUDFLARE_AI_TOKEN_PARAMETER_ARN`
- `CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN`

The loader requests exactly those ARNs with decryption and returns values only
in process memory. The SSM role is the Lambda execution role; no token is
accepted from a production Lambda environment variable.

The control API boundary assumed by this package is:

- `POST /internal/v1/transcription/jobs/claim` with `{batch_size}` and
  job-scoped audio plus speaker-turn-manifest GET authorities (URL, expiry,
  content type, size, checksum), the chunk's opaque source identity/track
  epoch/class, and never inline manifest bytes;
- `POST /internal/v1/transcription/jobs/heartbeat` with fenced snake_case
  fields including `job_id`;
- `POST /internal/v1/transcription/jobs/retry` with fenced snake_case fields
  including `job_id` and bounded `error_code`;
- `POST /internal/v1/transcription/jobs/complete` with fenced snake_case fields,
  including `job_id`, result
  checksum/size/content type, provider/model/version facts, observed identity,
  provider request identity when available, local measured audio milliseconds,
  provider-observed duration milliseconds, language, and bounded quality
  metadata. It does not claim provider billing: `billed_audio_seconds` is
  omitted unless a provider exposes an authoritative billing fact.

The API independently verifies the selected result object before its
compare-and-set completion. Completion does not send a URL or object key.

Final transcript composition is a separate fenced queue. The EventBridge
payload `{\"source\":\"eventbridge.scheduler\",\"kind\":\"transcription-reconcile\"}`
allocates one bounded claim budget across transcription, finalization, and
cleanup when those control methods are available. Finalizer claims use
`/internal/v1/transcription/finalize/claim`; each assignment contains result
GET authorities with exact size/checksum metadata and one conditional final
document PUT authority. The worker verifies every chunk document, retains
overlapping source-track cues, sorts deterministically, summarizes
heterogeneous provider facts as `mixed`, and calls
`/internal/v1/transcription/finalize/complete` with the final checksum, size,
content type, provider/model/version summary, and sorted language set. A
`409` or conditional PUT duplicate is treated as late fenced work. Invalid
chunk schema/bounds are terminal; bounded download failures use
`/internal/v1/transcription/finalize/retry`.

Explicit cleanup events use `source: "cleanup"`; the minute reconciliation
event also reserves part of its bounded claim budget for cleanup so a steady
transcription backlog cannot starve retention work. Cleanup claims use fenced
transcription-object cleanup assignments through
`/internal/v1/transcription/cleanup/claim`, issue only the short-lived DELETE
authority, treat an absent object as success, and call cleanup completion so
the API independently HEAD-verifies absence. Cleanup completion/retry bodies
contain only fenced snake_case job fields; no object key or reusable storage
credential is accepted.

## Local verification

From the repository root or this directory:

```sh
pnpm --dir apps/transcription-dispatcher run check-types
pnpm --dir apps/transcription-dispatcher run test
```

The tests are deterministic and use injected fetch/control/provider boundaries;
they do not claim live provider qualification, quota proof, DPA acceptance, or
production credentials.
