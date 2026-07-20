# Changelog

All notable public changes to this project will be documented in this file.

This changelog starts from the public-source cleanup. Earlier internal release
notes were archived privately before publication because they included
deployment, customer, and incident-specific detail that is not appropriate for a
public repository.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Implementation-ready web SDK launch board with frozen consumer contracts,
  file-level pseudodiffs, dependency-ordered task cards, an interactive
  lifecycle companion, and a packed two-browser release gate.
- Consumer SDK launch audit covering npm availability, missing meeting runtime
  and credential boundaries, stale readiness inventory entries, and the
  install-to-live-call release gate.
- Domain-grouped `product.yaml` and `checklist.md` inventories with 88 evidence-backed boolean capabilities, separating repository implementation from missing end-to-end or production proof.
- Interactive system architecture atlas with drillable product planes,
  end-to-end journey swimlanes, runtime topology, Postgres data domains,
  implementation-status semantics with explicit completion gaps for partial
  work, global search, and accessible keyboard navigation.
- Standalone protected architecture Worker deployment with content-hashed local
  assets, encrypted-secret access-code verification, signed secure sessions,
  native login rate limiting, anonymous-boundary monitoring, and one-command
  deployment integrity verification.
- Recorder pipeline foundation with bounded reservation admission, PostgreSQL
  leased jobs and fencing, mTLS worker identity, encrypted capture bundles,
  deterministic 720p render fixtures, generated API/SDK contracts, public-safe
  pool health checks, and fail-closed recorder infrastructure gates.
- Track-aware asynchronous transcription foundations, including recorder-owned
  source manifests, fenced PostgreSQL artifact and cleanup jobs, private R2
  transcript artifacts, DeepInfra and Cloudflare adapters, and a scale-to-zero
  Lambda dispatcher with deterministic OpenTofu release contracts.
- Tenant-scoped outbound webhooks for the eight core Room, Session, and
  Participant lifecycle events, with durable signed retries and redelivery,
  generated management clients, server-only TypeScript receiver processing,
  and linked journey observability.
- Declarative SyncEngine v3 TypeScript client support for exact four-stream
  recovery, role-derived capabilities, durable target commands, conference
  operations, live media targets, directed consent requests, and isolated web
  and React Native pending-target persistence.
- Declarative SyncEngine v3 server authority for immutable Session policy,
  roles and admission, generation-fenced deadlines, confirmed moderation and
  Recording operations, single-share leases, exact-next live projections, and
  bounded terminal retention on PostgreSQL 18.
- A checksummed four-phase SyncEngine v3 breaker that executes 37 seeded
  durable, provider, delivery, recovery, wire, and production-SDK schedules and
  reproduces the complete semantic artifact twice.
- API-issued five-minute Ed25519 sync participant tokens with fail-closed
  production verification, overlap key rotation, authenticated refresh, and
  generated SDK contracts.
- Public-safe release-topology failure scheduling with validated deterministic
  schedules, local/staging execution safeguards, and sanitized evidence
  bundles.
- Test-only sync breaker harness with deterministic model histories, real
  WebSocket campaigns, controlled writer faults, replay-ready JSONL traces, and
  failure-first Markdown reports.
- End-to-end observability v1 across the TypeScript client, Go API, Elixir sync
  server, Cloudflare provider adapters, durable journey ledger, OpenTelemetry
  signals, and a provisioned local Grafana/Tempo/Prometheus/Loki surface with
  critical pipeline alerts and a reproducible full-journey proof.
- Development-only sync server lab that starts empty and exercises live
  WebSocket participants, shared state, raw protocol frames, reconnects,
  redacted human-readable traces, and production failure drills.
- OpenRouter BYOK transcription support in the Go API, including a tenant
  `ai_provider_config` path, OpenRouter adapter, recording transcription route,
  and trace harness scenario.
- Go API database foundation for external integrations, including provider/service
  connection records for Composio-backed integrations.
- npm publish workflow and package metadata for publishing the public SDK
  packages under the `@q9labsai` scope.
- Resend-backed outbound email adapter foundation for the Go API, including a
  provider-neutral email port and env-based Resend configuration.
- Cloudflare R2-backed object storage adapter foundation for Go API media,
  image, and file objects.
- Local Redis and combined Postgres/Redis service helpers for Go API
  development.
- MIT license metadata across the workspace.
- Private language-neutral contract codegen with a validated canonical IR,
  reproducible frontend comparison, generated OpenAPI/TypeScript/Effect output,
  generated TypeScript and Elixir sync bindings, and non-mutating drift checks.
- Generic Go API logging/observability hooks and local performance harness for
  request, database, lifecycle, and footprint profiling.
- Go API Execution Trace Harness with a colorized local `tenant-create`
  scenario for reviewing a full HTTP-to-service-to-repository flow as a
  timeline.
- Go API tenant-scoped routes for rooms, room sessions, recordings,
  transcripts, and audit logs, plus tenant provider configuration fields for
  media plane, AI, and storage integrations.
- Public-safe scratchpad structure for architecture decisions, debugging
  lessons, deployment lessons, and summarized session memory.
- Public repository hygiene guidance for keeping raw logs, generated debug
  bundles, production identifiers, and private operational runbooks out of
  tracked source.

### Changed

- Replaced the always-full local gate and partial PR checks with one
  context-aware contract that reports its decisions, follows affected
  workspace dependents, includes Go and Elixir service-backed gates, runs tests
  once with coverage, and retains nightly and release full verification.
- Replaced stale readiness claims in the root docs and web marketing surface with current implementation boundaries, open product gaps, and target-only performance language.
- Replaced synchronous application-node OpenRouter transcription with an
  API-owned artifact lifecycle and short-lived, job-scoped worker authority.
- Tightened API and service completion rules around end-to-end observability,
  uptime-monitor registration, and consumer SDK support, while removing stale
  implementation and store-review documentation.
- Made sync-breaker snapshot-boundary verification audit the complete persisted
  event stream in bounded pages and retain event/head evidence before replica
  convergence checks.
- Made Session creation, participant admission and removal, and Session end
  share the sync authority boundary through atomic lifecycle transactions with
  durable request-key idempotency.
- Upgraded the web app build stack to Vite 8.1, including compatible React,
  TanStack Start, Nitro, and Cloudflare Vite plugins plus native Vite tsconfig
  path resolution.
- Moved shared UI background and sound asset delivery to the Cloudflare R2 CDN
  surface at `assets.chalkmeet.com`, leaving `@q9labsai/chalk-ui/assets` to
  export CDN metadata instead of bundled media binaries.
- Replaced the first-pass generic shared UI backgrounds with six generated,
  video-call-oriented backgrounds and documented the reusable generation prompt.
- Renamed the Cloudflare uptime monitor package to `@chalk/uptime-worker`,
  wired it into workspace gates, and hardened its ingest fallback alerting,
  storage failure handling, and manual run authentication.
- Hardened the Go API HTTP edge with protected resource routes, tenant
  authorization checks, Redis-backed public auth and authenticated-write rate
  limiting, trusted proxy client-IP handling, request body limits, production
  database TLS guardrails, safer diagnostics mounting, and escaped Cloudflare
  provider paths.
- Migrated Go API v1 route registration to declarative endpoint contracts for
  auth, users, memberships, rooms, recordings, transcripts, audit logs,
  integrations, and contract generator previews.
- Reorganized customer SDKs under `sdks/typescript`, extracted shared assets to
  `packages/assets`, moved whiteboard sources to `packages/whiteboard`, and kept
  existing public npm package names and UI asset compatibility exports.
- Moved reusable React whiteboard rendering, collaboration lifecycle, file sync,
  and math authoring into `@q9labsai/chalk-whiteboard/react`, leaving the React
  SDK to provide meeting composition and Chalk-specific presentation.
- Replaced private historical scratchpad entries with curated public summaries.
- Replaced internal agent/runbook guidance with public contributor guidance.
- Renamed public package scopes from `@q9labs/*` to `@q9labsai/*` for npm.

### Removed

- Unpublished SyncEngine v2 routes, generated contracts, server transport,
  breaker harness, tests, and TypeScript client and persistence surfaces after
  the strict v3 replacement passed its local proofs.
- Raw scratchpad session logs, local upload artifacts, private agent skills, and
  internal release archaeology from the tracked tree.
