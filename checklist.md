# Product checklist

As of 2026-07-22. This is the human-readable view of [`product.yaml`](./product.yaml), which is the canonical inventory.

`[x]` means the capability is implemented in this repository. `[ ]` means it is missing, placeholder-only, incomplete end to end, or still lacks the production proof named by the item. Large capabilities are split so there is no ambiguous “partial” state.

## Launch Readiness

The web experience is the launch-critical surface. The mobile redesign remains important, but it does not block the first web release unless shared Space/Episode behavior fails on mobile. The checklist below captures the current launch direction: “once the Episode path is stable, we can give it to consumers and customers.”

### Web redesign

- [ ] Complete the remaining web redesign work in a focused two-hour block.
- [ ] Complete the mobile redesign after the web launch gate, while keeping shared Space/Episode behavior consistent across both clients.
- [x] Preserve the existing design system, design board, and image-generation concept as the visual source of truth.
- [ ] Establish the Chalk design system as Q9 Labs' reusable product baseline, adapting brand colors and product-specific identity without recreating the core interface language.
- [ ] Apply and refine the baseline in the Q9 Labs website, Recruiter, Ava, and future products, then retain those implementations as high-quality references for new work.

### Episode reliability and speed

- [ ] Trace the full join path before committing to an optimization: request, Space admission and Episode resolution, Participant credentials, Cloudflare SFU connection, media readiness, Sync connection, and interactive-Space readiness.
- [ ] Record stage timings and failure reasons for web and mobile so known and unknown bottlenecks can be distinguished.
- [ ] Complete the planned web Episode-journey integration: carry the browser journey and W3C trace context through access, Space setup, media, Sync, readiness, diagnostics, and terminal cleanup.
- [ ] Make Episode telemetry automatic for SDK consumers: `telemetry: true` must continue the active journey or start one, then cover the complete Episode lifecycle without requiring applications to pass journey plumbing manually.
- [ ] Verify that web telemetry flushes authenticate successfully in the hosted path for public Spaces, and add an end-to-end assertion that one browser join produces one durable correlated journey.
- [ ] Make the join path fast and reliable, with the same acceptance criteria on web and mobile where their behavior should match.
- [ ] Verify stable live-Episode connection and recovery behavior.
- [ ] Verify whiteboard synchronization across Participants.
- [ ] Verify chat behavior across Participants.
- [ ] Wire and verify Episode sounds and Space actions.
- [ ] Measure whether Cloudflare SFU setup dominates join time; evaluate warm Spaces only if the trace justifies their cost and operational complexity.

### Customer onboarding proof

- [ ] Automate a complete customer journey: dashboard account, tenant, API key, application, SDK installation, API-key wiring, and a created Space.
- [ ] Cover both scheduled Spaces and ordinary live Episodes.
- [ ] Configure, receive, verify, and handle webhooks in the same acceptance flow.
- [ ] Run the scripted flow against the web and mobile paths where possible, and turn every parity failure into a tracked fix.

## Product Delivery

- [x] App-tier self-hosting source is available for API, sync, and Postgres
- [x] App-tier self-hosting has a documented, repeatable production deployment qualification
- [ ] Cloudflare-free media self-hosting
- [x] Managed production deployment is qualified in this repository
- [ ] Public product documentation app

## Meeting Core

- [x] Room create, read, update, list, and lifecycle API
- [x] Room, session, and participant-session separation
- [x] Anonymous and token-based participant admission
- [x] Lobby, admission, role, host-succession, and screen-share control semantics
- [x] Local web room proof with camera, microphone, SFU media, and Sync v1
- [x] Public web create-room flow
- [x] Production-ready hosted web meeting experience
- [x] Mobile invite-link join flow
- [ ] Mobile meeting creation is enabled consistently in release builds
- [ ] Iframe meeting embed
- [ ] Public status page
- [ ] Privacy and terms pages

## Identity And Tenancy

- [x] Authentication and current-user API
- [x] Tenant and membership APIs
- [x] Server-enforced tenant authorization
- [x] Tenant-scoped API-key creation, authentication, rotation, redacted listing, and revocation
- [ ] Complete first-party tenant administration UI
- [ ] SSO, SAML, or OIDC

## Media

- [x] Provider-neutral media-plane boundary
- [x] Cloudflare SFU control-plane and TypeScript client adapter
- [x] Short-lived participant media credentials with exact route, generation, provider, and connection binding
- [x] React Native RealtimeKit media adapter and lifecycle
- [ ] Real-network browser media end-to-end suite
- [ ] Real-device native media end-to-end suite
- [ ] Alternative self-hosted SFU adapter

## Realtime Sync

- [x] SyncEngine v1 client, codec, reducer, and persistence
- [x] Elixir Sync v1 runtime with Postgres durability
- [x] Bounded recovery, replay, receipts, and backpressure behavior
- [ ] Production topology, standby, and failure-recovery qualification

## Collaboration

- [x] React chat, reaction, participant, and waiting-room UI components
- [ ] Durable server-owned chat stream, delivery acknowledgements, and retention
- [ ] File attachments and tenant retention flow
- [x] Framework-neutral whiteboard collaboration engine
- [x] React Excalidraw canvas and math authoring
- [ ] Whiteboard is wired into the public web app
- [ ] Native mobile whiteboard rendering
- [ ] Live multi-client whiteboard browser test

## Recording

- [x] Recording control-plane API and durable job contracts
- [x] Capture and render infrastructure definitions
- [x] React recording controls
- [ ] Qualified real capture and render worker pools
- [ ] End-to-end recording to downloadable artifact proof
- [ ] Meeting recording is wired into the first-party mobile flow

## Transcription

- [x] Transcript API, artifact contracts, and worker boundaries
- [x] Provider dispatcher, retry, finalization, and cleanup implementation
- [x] React transcript and transcription UI
- [ ] End-to-end managed recording-to-provider-to-final-transcript proof
- [ ] Live in-room captions with consent and privacy lifecycle
- [ ] Meeting transcripts are wired into the first-party mobile flow
- [x] Standalone mobile dictation and transcription flow

## Sdk And Embedding

- [x] Generated TypeScript control-plane API and schemas
- [x] TypeScript media, sync, and telemetry client
- [x] Layered React meeting components
- [x] React Native provider, hooks, meeting surfaces, and platform bridges
- [x] Turnkey React web provider, hooks, and join flow
- [x] Server-only Promise SDK for rooms, sessions, participant access, and API keys
- [ ] Public `appName` client identity flows from SDK options through the transport to server spans and logs
- [ ] All public API routes are represented in OpenAPI and generated SDKs
- [ ] Swift SDK
- [ ] Kotlin SDK
- [ ] Python SDK
- [ ] Go SDK

## Integrations And Webhooks

- [x] Tenant integration catalog, connection, policy, and audit APIs
- [ ] Integration routes are generated into OpenAPI and SDK artifacts
- [ ] Complete first-party integration management UI
- [x] Versioned webhook event contracts and fixtures
- [x] Webhook signing, raw-body verification, retries, processing, and idempotency helpers
- [ ] Live deployed webhook canary and recovery proof

## Observability And Operations

- [x] Journey IDs and W3C trace context across client and API boundaries
- [x] Local OpenTelemetry and Grafana observability stack
- [x] API liveness and readiness endpoints
- [x] Sync liveness, readiness, metrics, and graceful drain implementation
- [x] Uptime worker with bounded checks, retry, ingestion, and buffering
- [ ] Default uptime targets match every current API route
- [ ] Public status projection is implemented
- [ ] Managed telemetry backends and alert routing are production-qualified
- [ ] Real synthetic failure and recovery has been observed

## Security And Compliance

- [x] Scoped authentication, tenant isolation, and audit-log APIs
- [x] Webhook secret rotation and signature verification
- [x] Release mobile secrets are constrained to controlled CI
- [ ] End-to-end encryption
- [ ] Legal hold
- [ ] Enterprise SSO

## Deferred Product Surface

- [ ] Webinar and viewer roles
- [ ] Desktop application
- [ ] AI tutoring assistant product
- [ ] Tenant-selectable multi-pack sound system
