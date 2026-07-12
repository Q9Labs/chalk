# Chalk Track-aware Transcription Spec

Status: Ratified companion to the infrastructure readiness spec.

Parent: `scratchpad/chalk-infrastructure-readiness-spec-2026-07-11.md`. Its
settled decisions, canonical terms, and anti-slop rules bind this document.

Owner: Hasan Shoaib

## Purpose and scope

This spec defines how a committed recording becomes a normalized, speaker-
attributed transcript: the attribution model, the provider port and its two
qualified providers, the scale-to-zero dispatcher, the quality and privacy
gates, and the failure and lifecycle behavior. The capture and render stages
that produce its inputs — the speaker-turn manifest, the recording state
machines, and the PostgreSQL artifact-job contract — are specified in
`scratchpad/chalk-recorder-pipeline-spec-2026-07-12.md`.

## Speaker attribution

The launch transcript uses authenticated SFU track ownership as its speaker
authority. This is track-aware attribution, not acoustic diarization: the
system already knows which authorized participant published each isolated
audio track. The normalized transcript maps provider timing through the
speaker-turn manifest and adds the authorization-time display-name snapshot
locally. DeepInfra and Cloudflare receive only opaque job/chunk IDs and audio;
they receive no display name, tenant identifier, email address, room title, or
customer-supplied object URL.

One physical microphone or mixed input published as one SFU track remains one
speaker device in the transcript. Chalk does not claim it can distinguish
multiple humans behind that track. A future acoustic
`PyannoteDiarizationAdapter` may be qualified for imported mixed recordings or
shared-microphone recovery, but it is not in the launch path and cannot replace
authenticated track identity when that identity exists.

Screen-share or system audio retains its authenticated track class and is
labeled as shared audio, not silently assigned to the participant's microphone
identity. A participant track without provable ownership remains an explicit
unknown track and cannot borrow the current active-speaker label.

## Provider port

Transcription sits behind a provider-neutral `TranscriptionProvider` port:

| Role     | Provider and model                             | Runtime policy                                                                |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Primary  | DeepInfra `openai/whisper-large-v3-turbo`      | Default service tier; exact release-approved model version; standard API only |
| Fallback | Cloudflare `@cf/openai/whisper-large-v3-turbo` | Release-qualified model contract; activated only after the circuit breaker    |

## Scale-to-zero dispatcher

The environment-scoped transcription dispatcher is scale-to-zero AWS Lambda,
not an application-node process or a dedicated always-on node. It claims a
fenced PostgreSQL job through the recorder control API, fetches only the
attempt's bounded private R2 chunks through short-lived job authority, invokes
the configured adapter synchronously, validates the response, normalizes it,
and uploads the result through a conditional job-scoped URL. It receives no
PlanetScale credential, recorder provider token, bucket-wide R2 credential, or
infrastructure mutation authority. Its signed, digest-addressed release
artifact and environment configuration are part of the same Chalk release.

After the database transaction commits a transcript job, the control API sends
an asynchronous Lambda wake-up hint. A one-minute EventBridge reconciliation
schedule wakes pending work if that hint is lost. Neither trigger owns job
state: duplicate or missing invocations are safe because only the control API's
compare-and-set lease grants work. One invocation claims a bounded batch, stops
claiming before its timeout reserve, and lets leases expire for anything it did
not conditionally commit. Chunk duration and provider timeouts must leave at
least 60 seconds for response validation, result upload, and lease completion
inside the configured Lambda timeout.

## Primary-provider enablement gates

DeepInfra is the default because its listed 2026-07-12 price for Whisper
large-v3-turbo is $0.00020 per audio minute, versus Cloudflare's listed
$0.00051. Production enablement is nevertheless gated on all of the following:

- vendor DPA, subprocessor, processing-location, request-logging, deletion, and
  incident terms are accepted for recorded meeting audio;
- an environment-isolated token, spending limit, rotation procedure, revocation
  drill, and least-privilege egress policy are in place;
- the exact DeepInfra model version is pinned, execution identity is observable,
  and its segment/word timing, languages, file bounds, error taxonomy, and
  normalized output pass the conformance corpus;
- quota and load proof cover the launch burst below an internal concurrency cap
  of 50, leaving headroom under DeepInfra's documented 200 concurrent requests
  per model; and
- measured quality and total billed audio remain inside the ratified quality
  and cost gates.

## Conformance corpus and quality thresholds

The deterministic staging corpus covers the launch languages, accents, short
turns, long monologues, silence, background noise, reconnects, crosstalk, and
the qualified room shapes. DeepInfra may become primary only when every adapter
conforms to the same normalized schema, non-overlap speaker-time attribution
error is at most 2 percent, every labeled overlap interval is retained and
flagged, and its word-error rate is no more than two absolute percentage points
worse than Cloudflare's result in any ratified language/noise bucket. A failed
bucket makes Cloudflare active until a new model/version passes; it is not
hidden by an aggregate average.

## Privacy boundary

DeepInfra documents that standard inference inputs and outputs are normally
memory-only, but reserves limited request-content logging for debugging or
security. Chalk therefore uses only direct standard request/response inference;
the DeepInfra bulk API and provider webhooks are prohibited at launch. If the
privacy gate is not accepted, DeepInfra cannot be enabled in that environment
and Cloudflare becomes the active provider without changing the transcript
contract.

## Retry, fallback, and single-result commit

There is no request racing or dual-success billing. The dispatcher retries
DeepInfra only for classified retryable failures with bounded exponential
backoff and jitter, then opens a circuit and submits that fenced chunk to
Cloudflare. A conditional commit accepts exactly one provider result per chunk;
late or duplicate results cannot overwrite it. Every normalized cue records
meeting-relative start/end, opaque participant and track epoch, locally joined
display-name snapshot, text, language, overlap state, provider, model, pinned
DeepInfra version or release-qualified Cloudflare contract version, attempt,
and available quality metadata. Provider/model/version-contract and billed
audio are observable per attempt.

## Model-version pinning and drift

Cloudflare exposes the model slug but no ASR model-version pin in its published
contract. The release therefore records that slug, the adapter/schema version,
the last passing corpus digest, and the provider response identity when
available. A daily no-content canary and changelog watcher disable fallback on
schema or quality drift. DeepInfra's documented automatic deprecation forwarding
is also treated as a model change: an unobservable or mismatched execution
identity fails the primary gate instead of accepting the replacement silently.

## Chunk lifecycle

Temporary transcription chunks stay private in R2. Raw provider responses
exist only in Lambda memory until normalization and are never stored as objects
or logs. Chunks are deleted within one hour after the normalized transcript is
committed; a 24-hour lifecycle rule removes orphans. Provider failure never
invalidates a committed recording. Transcription retries or falls back
independently and eventually reaches a visible terminal transcript outcome.

## Launch readiness dependencies

Before staging can pass or production can be planned, in addition to
the recorder gates in the recorder spec:

- normalized transcript document bytes move to R2; the current
  `transcriptions.text` column cannot remain the production content authority;
- the provider-neutral transcription port, DeepInfra primary adapter,
  Cloudflare fallback adapter, scale-to-zero Lambda dispatcher, exact model
  version, fenced single-result commit, and provider/model/version audit facts
  exist;
- DeepInfra's privacy/commercial gate, environment token isolation, spending
  alerts, quota/concurrency proof, conformance corpus, quality thresholds, and
  fallback circuit breaker pass before it becomes the production default;
- workers use job-scoped upload authority and never hold reusable R2 object
  credentials;
- recording and transcript delete endpoints revoke access, tombstone metadata,
  delete R2 bytes and provider copies, and verify completion within 24 hours;
- retry, dead-letter, reconciliation, duplicate/late-response rejection, and
  forced Cloudflare fallback pass without provider racing or webhooks;
- retention, erasure, orphan cleanup, and restore-tombstone behavior pass;
- a full composite-recording-to-transcript staging canary reaches terminal
  state on the selected production capture and render providers and classes,
  then the same corpus passes with DeepInfra disabled and Cloudflare active.

This spec is done when every item above has recorded evidence in the
execution ledger, and work stops there. Deliberately out of scope at
launch: acoustic diarization (the future `PyannoteDiarizationAdapter`), the
DeepInfra bulk API, provider webhooks, and any claim to distinguish
multiple humans behind one published track. The one-track-one-speaker-device
attribution boundary is accepted as good enough for launch.

## References

- Cloudflare Workers AI Whisper large-v3-turbo contract and pricing:
  https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
- DeepInfra Whisper large-v3-turbo contract and pricing:
  https://deepinfra.com/openai/whisper-large-v3-turbo
- DeepInfra OpenAI-compatible audio transcription API:
  https://docs.deepinfra.com/api-reference/audio/openai-audio-transcriptions
- DeepInfra standard-inference privacy and logging behavior:
  https://docs.deepinfra.com/account/data-privacy
- DeepInfra default concurrency and 429 behavior:
  https://docs.deepinfra.com/account/rate-limits
- DeepInfra model version and deprecation behavior:
  https://docs.deepinfra.com/models
- Pyannote acoustic speaker-diarization toolkit, future mixed-audio adapter:
  https://github.com/pyannote/pyannote-audio
