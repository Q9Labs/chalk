# Chalk Architecture Decision Note

Scratchpad. Decisions, not spec.

## Decision

Core infrastructure capabilities sit behind **ports-and-adapters**:

- **MediaPlane** — real-time audio/video transport, behind adapters.
- **SyncEngine** — collaborative state/API sync, behind adapters.

Each has a primary adapter now and named alternatives kept viable for later.

## Current Architecture

- **Media:** Cloudflare SFU, direct, via `CloudflareMediaPlaneAdapter`.
- **Recording:** custom recorder writing to **R2**. Not Cloudflare Stream minute-based recording. Preserve existing R2 data through the teardown.
- **Transcription:** rebuild as a first-class post-meeting artifact pipeline, not an afterthought. It needs provider adapters, queue/retry/DLQ semantics, callback verification, transcript lookup by recording, language/provider metadata, and future summary hooks.
- **Sync/API:** custom **WebSocket sync server + Postgres**. Redis may be added only as optional head-hint or volatile-presence acceleration.
- **Region:** Singapore, single-region.
- **Runtime:** independently scalable API and WebSocket sync processes sharing one Postgres authority.

## Adapters

| Port       | Primary now                                   | Later option                                                   |
| ---------- | --------------------------------------------- | -------------------------------------------------------------- |
| MediaPlane | `CloudflareMediaPlaneAdapter` (CF SFU direct) | `DigitalOceanMediaPlaneAdapter` (DO Singapore self-hosted SFU) |
| SyncEngine | custom WS sync + Postgres                     | `DurableObjectSyncAdapter`                                     |

Durable Objects not primary now, but must stay possible.

## Scaling Notes

- Multiple WebSocket nodes coordinate through Postgres transactions,
  notifications, and authoritative head repair. They require no shared BEAM
  process or Redis deployment for correctness.
- Redis remains an optional disposable accelerator. Flushing or removing it
  cannot change a command decision, revision, receipt, or recovered snapshot.
- Suggested machines: AWS `t4g.small`/`t4g.medium` equivalent. On DigitalOcean: Basic 2 vCPU / 2 GB or 2 vCPU / 4 GB; CPU-Optimized 2 vCPU / 4 GB for recorder and future self-hosted SFU.

## Web App Decision

- Official web app ships as a **static SPA first on Cloudflare Pages**.
- SSR/SSG only for marketing, docs, share-preview, public SEO pages — **not** the meeting app.

## Open Later

- DigitalOcean Singapore self-hosted SFU via `DigitalOceanMediaPlaneAdapter`.
- `DurableObjectSyncAdapter` as sync path.
- Optional Redis acceleration if measured fanout or presence load justifies it.
- Multi-region beyond Singapore.
