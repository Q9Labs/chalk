# Chalk Architecture Decision Note

Scratchpad. Decisions, not spec.

## Decision

Core infrastructure capabilities sit behind **ports-and-adapters**:

- **MediaPlane** — real-time audio/video transport, behind adapters.
- **SyncEngine** — collaborative state/API sync, behind adapters.

Each has a primary adapter now and named alternatives kept viable for later.

## Initial Architecture

- **Media:** Cloudflare SFU, direct, via `CloudflareMediaPlaneAdapter`.
- **Recording:** custom recorder writing to **R2**. Not Cloudflare Stream minute-based recording. Preserve existing R2 data through the teardown.
- **Transcription:** rebuild as a first-class post-meeting artifact pipeline, not an afterthought. It needs provider adapters, queue/retry/DLQ semantics, callback verification, transcript lookup by recording, language/provider metadata, and future summary hooks.
- **Sync/API:** custom **WebSocket sync server + Redis**.
- **Region:** Singapore, single-region.
- **Runtime:** one small app server bundling API, WebSocket sync, background workers, and local Redis.

## Adapters

| Port       | Primary now                                   | Later option                                                   |
| ---------- | --------------------------------------------- | -------------------------------------------------------------- |
| MediaPlane | `CloudflareMediaPlaneAdapter` (CF SFU direct) | `DigitalOceanMediaPlaneAdapter` (DO Singapore self-hosted SFU) |
| SyncEngine | custom WS sync + Redis                        | `DurableObjectSyncAdapter`                                     |

Durable Objects not primary now, but must stay possible.

## Scaling Notes

- Local Redis is fine for baseline.
- **When multiple WebSocket nodes exist, Redis must become external/shared.** Avoid Upstash pay-as-you-go for hot sync loops.
- Suggested machines: AWS `t4g.small`/`t4g.medium` equivalent. On DigitalOcean: Basic 2 vCPU / 2 GB or 2 vCPU / 4 GB; CPU-Optimized 2 vCPU / 4 GB for recorder and future self-hosted SFU.

## Web App Decision

- Official web app ships as a **static SPA first on Cloudflare Pages**.
- SSR/SSG only for marketing, docs, share-preview, public SEO pages — **not** the meeting app.

## Open Later

- DigitalOcean Singapore self-hosted SFU via `DigitalOceanMediaPlaneAdapter`.
- `DurableObjectSyncAdapter` as sync path.
- External/shared Redis once WS scales past one node.
- Multi-region beyond Singapore.

## Teardown Reset — 2026-06-24

Decision: delete the current Go API, Terraform prod stack, whisper worker, and Cloudflare post-meeting worker implementation before the clean rebuild. Production infrastructure should be destroyed from CI while the Terraform code still exists, because CI has the provider credentials. R2 data is the explicit carve-out and should remain available for later inspection/recovery.

The rebuild should not inherit old schema, Terraform modules, or worker code by default. Use the old system only as a feature inventory and failure-mode archive:

- API/control plane: rebuild around Room, Session, Participant, ParticipantSession, artifacts, webhooks, tenant config, and ops as deliberate bounded contexts.
- Infra: rebuild from a clean Terraform/IaC baseline after product boundaries settle; keep provider-specific resources behind adapters.
- Workers: replace ad hoc Whisper/Cloudflare worker paths with a provider-neutral artifact-processing pipeline.
- Contracts: generate SDKs and server contract types from one language-neutral schema source.
