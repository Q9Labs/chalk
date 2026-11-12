# Transcription dispatcher

The private Node 22 Lambda package for scale-to-zero transcription. It claims fenced jobs through the recorder control API, reads only job-scoped R2 URLs, invokes one provider at a time, and conditionally writes one normalized `transcript.v1` JSON document. Provider responses, audio, display names, URLs, object keys and tokens are never logged or persisted.

The package fails closed unless the environment supplies provider policy bounds, the privacy gate and qualification evidence for each enabled provider (the package's `src/config.ts` lists them). DeepInfra is omitted entirely when `DEEPINFRA_ENABLED=false`.

Check it with `pnpm --dir apps/transcription-dispatcher run check-types` and `run test`. The tests use injected fetch, control and provider boundaries, so they prove no live provider qualification, quota, DPA or production credentials. Release scripts are in `scripts/transcription-dispatcher/README.md`.

## Boundaries

- **Secrets.** The handler loads the control credential ARN (`CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN`) and the ARNs of enabled providers (`DEEPINFRA_TOKEN_PARAMETER_ARN`, `CLOUDFLARE_AI_TOKEN_PARAMETER_ARN`, `OPENROUTER_TOKEN_PARAMETER_ARN`) from SSM with decryption, into process memory only. No token is accepted from a production Lambda environment variable.
- **Control API.** The routes are in the package's `src/control-api.ts` (`/internal/v1/transcription/{jobs,finalize,cleanup}/...`). The API verifies the selected result object itself before its compare-and-set completion, and completion carries a checksum, never a URL or object key. A retry after a successful conditional PUT reuses the existing object by resubmitting its checksum. It does not claim provider billing: `billed_audio_seconds` is omitted unless a provider exposes an authoritative fact.
- **Source.** The downloaded source must be exactly `recording-transcription-source.v1`, and the selected chunk must match the claim's allocation, version, ETag, checksum, size, offsets, participant generation, track identity, name snapshot and overlap fact. Only committed 16 kHz mono FLAC microphone tracks get speaker attribution; there is no diarization and no mixed-audio fallback. Leases and signed URLs are capped by the persisted source hard deadline.
- **Finalization.** Final transcript composition is a separate fenced queue. The EventBridge payload `{"source":"eventbridge.scheduler","kind":"transcription-reconcile"}` splits one bounded claim budget across transcription, finalization and cleanup, so a steady transcription backlog cannot starve retention cleanup. The finalizer verifies every chunk document, sorts deterministically, summarizes mixed provider facts as `mixed`, and completes with the final checksum. If a prior invocation already uploaded the final object, it resubmits the same completion; a `409` is late fenced work. Invalid chunk schema is terminal and bounded download failures retry.
- **Cleanup.** It uses only a short-lived DELETE authority, treats an absent object as success, and the API HEAD-verifies absence itself. No object key or reusable storage credential is accepted.

## Language routing

Claims carry `transcript_language` (`auto` or a supported Whisper v3 primary code; older APIs default to auto). Fixed codes go to the qualified Whisper primary and fallback as `language`. Auto uses `CODESWITCH_PROVIDER=mai` through OpenRouter. Without the OpenRouter secret slot, Auto retries as unavailable and never falls back to Whisper.

MAI receives only retained speech: silence below -45 dB lasting at least one second is removed, 150 ms of context is kept, and at most 60 speech seconds go into each WAV request. A source-offset map restores timestamps before cue normalization. An entirely silent source completes with no cues and no paid request, and missing word timings for nonempty speech fail validation rather than inventing timestamps. Devanagari tokens alone go to GPT-4.1 Mini for Urdu-script transliteration; both requests set `provider.zdr=true` and `data_collection=deny`. If strict ZDR is required, production key privacy settings must exclude Safety Retention.

Enabling Auto needs a separate infrastructure migration, because `codeswitch_provider` and `openrouter_token_parameter_arn` are optional module inputs and ordinary media releases keep them from state. After deploying the API reader and dispatcher ZIP:

```sh
python3 scripts/transcription-dispatcher/configure-mai.py --environment production --secret-parameter-arn <environment-scoped-arn> --apply
```

To pause Auto, run it with `--disable --apply`. Fixed languages continue, and the new API reader stays deployed so MAI artifacts already produced remain readable. Never route Auto to Whisper as an undo. Omit `--apply` to review the plan; the migration permits only the named secret's read grant and the matching Lambda environment change, and rejects code changes, replacement resources and unrelated permissions. The environment is `nightly` or `production`.
