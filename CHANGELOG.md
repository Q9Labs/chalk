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

- Resend-backed outbound email adapter foundation for the Go API, including a
  provider-neutral email port and env-based Resend configuration.
- Cloudflare R2-backed object storage adapter foundation for Go API media,
  image, and file objects.
- Local Redis and combined Postgres/Redis service helpers for Go API
  development.
- MIT license metadata across the workspace.
- Generic Go API logging/observability hooks and local performance harness for
  request, database, lifecycle, and footprint profiling.
- Go API Execution Trace Harness with a colorized local `tenant-create`
  scenario for reviewing a full HTTP-to-service-to-repository flow as a
  timeline.
- Public-safe scratchpad structure for architecture decisions, debugging
  lessons, deployment lessons, and summarized session memory.
- Public repository hygiene guidance for keeping raw logs, generated debug
  bundles, production identifiers, and private operational runbooks out of
  tracked source.

### Changed

- Upgraded the web app build stack to Vite 8.1, including compatible React,
  TanStack Start, Nitro, and Cloudflare Vite plugins plus native Vite tsconfig
  path resolution.
- Moved shared UI background and sound asset delivery to the Cloudflare R2 CDN
  surface at `assets.chalkmeet.com`, leaving `@q9labs/chalk-ui/assets` to
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
- Replaced private historical scratchpad entries with curated public summaries.
- Replaced internal agent/runbook guidance with public contributor guidance.

### Removed

- Raw scratchpad session logs, local upload artifacts, private agent skills, and
  internal release archaeology from the tracked tree.
