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

- API-issued five-minute Ed25519 sync participant tokens with fail-closed
  production verification, overlap key rotation, authenticated refresh, and
  generated SDK contracts.
- Public-safe release-topology failure scheduling with validated deterministic
  schedules, local/staging execution safeguards, and sanitized evidence
  bundles.
- Protocol-v2 durable sync control with PostgreSQL authority, stable command
  receipts, exact revision folding, acknowledged bounded recovery and live
  delivery, multi-node repair, production readiness/drain telemetry, and
  browser plus React Native client persistence adapters.
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

- Raw scratchpad session logs, local upload artifacts, private agent skills, and
  internal release archaeology from the tracked tree.
