# Chalk Architecture Decision Note

Scratchpad. Decisions, not spec.

## Decision

Core infrastructure capabilities sit behind **ports-and-adapters**:

- **MediaPlane** — real-time audio/video transport, behind adapters.
- **SyncEngine** — collaborative state/API sync, behind adapters.
- **TranscriptionProvider** — post-meeting speech recognition, behind adapters.

Each has a primary adapter now and named alternatives kept viable for later.

## Current Architecture

- **Media:** Cloudflare SFU, direct, via `CloudflareMediaPlaneAdapter`.
- **Recording:** custom two-stage recorder writing to **R2**. Native selective
  capture runs in DigitalOcean SGP1 without a browser or live transcode. An
  asynchronous DigitalOcean TOR1 GPU renderer reads envelope-encrypted temporary
  bundles, produces the bounded stage composite, and deletes raw inputs within
  the specified temporary window. Not Cloudflare Stream or RealtimeKit managed
  recording. Preserve existing R2 data through the teardown.
- **Transcription:** track-aware speaker attribution from authenticated SFU audio
  tracks, with DeepInfra `openai/whisper-large-v3-turbo` as the gated primary
  and Cloudflare `@cf/openai/whisper-large-v3-turbo` as the automatic fallback.
  A scale-to-zero AWS Lambda dispatcher uses PostgreSQL-leased jobs through the
  control API, direct request/response inference, release-qualified model
  contracts,
  fenced single-result commits, and normalized R2 transcript artifacts. The
  DeepInfra version is pinned; Cloudflare's unversioned public model slug is
  protected by a release-qualified contract and drift canary. Display names and
  tenant identifiers are joined locally and never sent to either ASR provider.
  Acoustic diarization is unnecessary for normal isolated tracks.
- **Sync/API:** custom **WebSocket sync server + Postgres**. Redis may be added only as optional head-hint or volatile-presence acceleration.
- **Region:** Singapore for application control, live state, database, and live
  media capture. TOR1 is an explicit render-only processing exception for
  encrypted temporary recording inputs; it has no control-plane or durable-data
  authority. External ASR processing is enabled only after its DPA,
  subprocessors, processing location, and logging terms pass the infrastructure
  readiness gate.
- **Runtime:** independently scalable API and WebSocket sync processes sharing
  one Postgres authority, plus a scale-to-zero transcription dispatcher with no
  dedicated node.

## Adapters

| Port                  | Primary now                                              | Later option                                                   |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| MediaPlane            | `CloudflareMediaPlaneAdapter` (CF SFU direct)            | `DigitalOceanMediaPlaneAdapter` (DO Singapore self-hosted SFU) |
| SyncEngine            | custom WS sync + Postgres                                | `DurableObjectSyncAdapter`                                     |
| TranscriptionProvider | `DeepInfraTranscriptionAdapter` with Cloudflare failover | Additional qualified ASR provider                              |

Durable Objects not primary now, but must stay possible.

## Scaling Notes

- Multiple WebSocket nodes coordinate through Postgres transactions,
  notifications, and authoritative head repair. They require no shared BEAM
  process or Redis deployment for correctness.
- Redis remains an optional disposable accelerator. Flushing or removing it
  cannot change a command decision, revision, receipt, or recovered snapshot.
- Suggested app machines: AWS `t4g.small`/`t4g.medium` equivalent. On
  DigitalOcean: Basic 2 vCPU / 2 GB or 2 vCPU / 4 GB for a future self-hosted
  SFU. Recorder capture uses scale-to-zero CPU-Optimized 2 vCPU / 4 GB nodes;
  composite rendering uses scale-to-zero RTX 4000 GPU nodes. The infrastructure
  readiness spec owns their measured density, quota, deadline, and cost gates.

## Web App Decision

- Official web app ships as a **static SPA first on Cloudflare Pages**.
- SSR/SSG only for marketing, docs, share-preview, public SEO pages — **not** the meeting app.

## Open Later

- DigitalOcean Singapore self-hosted SFU via `DigitalOceanMediaPlaneAdapter`.
- `DurableObjectSyncAdapter` as sync path.
- Optional Redis acceleration if measured fanout or presence load justifies it.
- `PyannoteDiarizationAdapter` for imported mixed audio or a shared physical
  microphone, never as an extra ordinary-recording stage.
- Multi-region beyond Singapore.
