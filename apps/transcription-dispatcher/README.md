# Transcription dispatcher

The private Node 22 Lambda package for scale-to-zero transcription. It claims fenced jobs through the recorder control API, reads only job-scoped R2 URLs, calls OpenRouter for speech, and conditionally writes one normalized `transcript.v1` JSON document. Provider responses, audio, display names, URLs, object keys and tokens are never logged or persisted.

The package fails closed unless the environment supplies the OpenRouter and workload credentials, provider bounds, and an accepted privacy gate. See [runtime configuration](src/config.ts).

Check it with `pnpm --dir apps/transcription-dispatcher run check-types` and `run test`. The tests use injected fetch, control and provider boundaries, so they prove no live provider qualification, quota, DPA or production credentials. Release scripts are in `scripts/transcription-dispatcher/README.md`.

## Boundaries

- **Secrets.** The handler loads the control credential ARN (`CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN`) and the OpenRouter ARN (`OPENROUTER_TOKEN_PARAMETER_ARN`) from SSM with decryption, into process memory only. No token is accepted from a production Lambda environment variable.
- **Control API.** The routes are in the package's `src/control-api.ts` (`/internal/v1/transcription/{jobs,finalize,cleanup}/...`). The API verifies the selected result object itself before its compare-and-set completion, and completion carries a checksum, never a URL or object key. A retry after a successful conditional PUT reuses the existing object by resubmitting its checksum. It does not claim provider billing: `billed_audio_seconds` is omitted unless a provider exposes an authoritative fact.
- **Release replacement.** Every call is signed with `CHALK_RELEASE_ID`. After a deploy the API answers an older release `409 workload.release_superseded`, and a claim that gets it is a drain: the queue logs `<queue>_release_superseded`, claims nothing and the invocation ends without an error, a retry or a dead-letter message. Only that code is a drain; any other 409 stays late fenced work and any 401 stays a failure.
- **Source.** The downloaded source must be exactly `recording-transcription-source.v1`, and the selected chunk must match the claim's allocation, version, ETag, checksum, size, offsets, participant generation, track identity, name snapshot and overlap fact. Only committed 16 kHz mono FLAC microphone tracks get speaker attribution; there is no diarization and no mixed-audio fallback. Leases and signed URLs are capped by the persisted source hard deadline.
- **Finalization.** Final transcript composition is a separate fenced queue. The EventBridge payload `{"source":"eventbridge.scheduler","kind":"transcription-reconcile"}` splits one bounded claim budget across transcription, finalization and cleanup, so a steady transcription backlog cannot starve retention cleanup. The finalizer verifies every chunk document, sorts deterministically, summarizes mixed provider facts as `mixed`, and completes with the final checksum. If a prior invocation already uploaded the final object, it resubmits the same completion; a `409` is late fenced work. Invalid chunk schema is terminal and bounded download failures retry.
- **Cleanup.** It uses only a short-lived DELETE authority, treats an absent object as success, and the API HEAD-verifies absence itself. No object key or reusable storage credential is accepted.
- **Provider circuit.** Fixed and Auto jobs share a circuit within each invocation. After `TRANSCRIPTION_CIRCUIT_FAILURE_THRESHOLD` failures, work that encounters the open circuit retries through the queue without calling another provider.

## Language routing

Claims carry `transcript_language` (older assignments default to Auto).
All claims use OpenRouter's `microsoft/mai-transcribe-2`; there is no fallback.
Fixed claims send a `language` hint for [codes documented by Microsoft](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe#supported-languages).
Other codes still use MAI without a hint; those languages are not guaranteed.

MAI receives only retained speech: silence below -45 dB lasting at least one
second is removed, 150 ms of context is kept, and each WAV request sends at
most 60 seconds. The dispatcher restores source timings before normalizing cues.
A silent source completes with zero cost. Missing word timings for nonempty
speech or missing OpenRouter `usage.cost` fail response validation. For Auto
and fixed Urdu, the adapter sends only Devanagari tokens to GPT-4.1 Mini for
Urdu-script transliteration and includes that request's cost. Both calls request
`provider.zdr=true` and `data_collection=deny`. If strict ZDR is required, the
OpenRouter key's privacy settings must exclude Safety Retention.

The release requires the OpenRouter secret binding. See the
[production release runbook](../../docs/transcription-production-release.md#release-path)
for setup and rollback.
