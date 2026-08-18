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

- Added typed `classic` and `chalk` skins to the web React SDK theme. Classic is
  the default, the existing hand-drawn treatment remains available as Chalk,
  and either skin composes independently with every typed palette and texture.
- Added deterministic hand-drawn chalk controls across the React SDK Entrance
  and Space, plus public chalk buttons, fields, toggles, panels, menus, dialogs,
  alerts, sliders, badges, and loading primitives for custom SDK surfaces.
- Added exact-SHA, component-aware managed release manifests and a manual
  release workflow that builds only the changed API or Sync image while
  carrying the stable component digest and provenance forward.
- Added a local-first web release runner that builds one cached artifact,
  verifies staging by default, supports an explicit staging bypass, and reuses
  the same path as the CI fallback.
- Added a product-first landing journey for Account creation, dashboard entry,
  invite-link joining, and SDK discovery, backed by the official technology
  marks distributed through SVGL.
- Added an original responsive editorial illustration system to the landing
  page and distilled its shipped capabilities inventory into four readable
  groups.
- Added routed Space administration pages with readable configuration,
  Episode history, and separate details and Join Space actions.
- Added authenticated Dashboard Space entry by slug. Opening a Space now reuses
  its live Episode or starts one, admits the Dashboard Account as a stable
  Participant, and leaves only that Participant when the page closes.
- Added account-scoped Episode Debugger launch links to Episode details and the
  Developer page, with safe Episode references that resolve to canonical
  diagnostics only after tenant authorization.

### Changed

- Restored the React SDK’s pre-redesign Entrance and Space layouts as the
  Classic skin, and rebuilt the Chalk Entrance as a balanced responsive split
  between the camera preview and entry form.
- Made the local API gate own its isolated migrated PostgreSQL database, expose
  every integration-test database alias, run independent checks in parallel,
  avoid duplicate vet work in `go test`, and overlap PostgreSQL preparation
  with database-free checks.
- Made detached local web releases reuse the main checkout's Turbo cache while
  keeping web build inputs and the exact release SHA in the cache key.
- Removed the unfinished standalone API performance harness. A replacement can
  return when it has stable workload, latency, and regression contracts.

### Fixed

- Fixed the dependency vulnerability gate under macOS's system Bash so its
  lockfile discovery no longer fails inside nested null-delimited reads.
- Serialized web releases across SHAs, added guarded stale-lock recovery, and
  made manifest component ordering match runtime validation.
- Fixed chat attachment reservation against the Space-scoped stream schema and
  corrected cleanup fixtures so historical Whiteboard scenes do not violate
  the one-current-scene constraint.
- Fixed named Dashboard joins so broker invite capabilities cannot silently
  connect Participants to a different Space, and ensured every Episode's
  authoritative start time, webhook Event, history row, and Episode Diagnostics
  root commit together.
- Stabilized the landing hero headline, removed decorative eyebrow labels from
  the primary product surfaces, and made the local SVGL marks valid standalone
  browser assets.
- Rebuilt the Dashboard and Episode Debugger into responsive, keyboard-friendly
  product surfaces with dependable navigation, readable tables and dialogs,
  complete-row affordances, and accessible mobile controls.
- Fixed visitor Space access refresh so the browser forwards media proof to the
  broker. Proof-less renewals made the broker replace the media connection,
  which the client rejected at the first refresh window as an invalid grant.
- Fixed Dashboard Space access refresh so scheduled renewal preserves current
  media proof and rejected credentials recover with a replacement connection.
- Fixed Dashboard Space and Episode navigation so active Spaces are directly
  openable, Episode history links back to its Space, duplicate Space names show
  their slug, and empty diagnostic references no longer claim healthy evidence.
- Fixed server SDK AccessGrants dropping the optional diagnostics credential,
  which prevented browser Episode evidence from being captured.
- Fixed the hosted Episode Debugger so canonical diagnostic snapshots load
  directly after an alternate Episode reference resolves, including Episodes
  whose empty projections serialize required arrays.
- Fixed browser Sync startup recovery so a healthy connection is not replaced by
  stale queued snapshots, restored the Space Entrance, expanded the live Space
  across its host viewport, and made creator cleanup survive page unloads.
- Fixed the live Space diagnostics action so embedding apps can open the current
  Episode in the gated Episode Debugger on React and React Native.
- Fixed the guarded npm publish workflow for pnpm 10 and made release dispatches
  target `Q9Labs/chalk` explicitly.

## [4.0.1] - 2026-08-09

### Fixed

- Hardened the Metro image-size dependency against the upstream-unfixed
  zero-length parser loops and added ESM/CJS regression coverage.

## [4.0.0] - 2026-08-08

> Recording and transcription hosted infrastructure is intentionally excluded
> from this release. Those hosted services are not part of 4.0.0.

### Added

- Added the public `@q9labsai/diagnostics-contracts@0.1.0` package for shared,
  versioned Episode Diagnostics validators, schemas, and fixtures. Publish it
  before `@q9labsai/chalk-client`, then publish `@q9labsai/chalk-react`; this
  manual order keeps the client's public runtime dependency resolvable.

- Added six labeled Home and Entrance mobile inspiration studies, including cardless, illustrated, bottom-sheet, and preview-first directions.

- Added a development-only, URL-addressable SDK state gallery for the Entrance and Space, including loading, waiting, empty, warning, retry, confirmation, timeout, failure, recovery, and ended states built from production React SDK components.

- Added a development-only, deep-linkable React Native mobile gallery built
  from canonical `<Entrance />` and `<Chalk />` fixtures over a local
  deterministic `SpaceClient`/`SpaceSnapshot`, with app-owned `PreviewStatus`;
  its permission-free, network-free Entrance and Space states expose only
  supported native knobs with lifecycle surface parity.

- Added a web `JoinFailedScreen` with retry and Entrance actions, plus an explicit zero-Participant state for `ParticipantGrid` across desktop and mobile layouts.

- Added the first fixture-backed Chalk dashboard slice in `apps/web`, with a responsive general-product shell, Home and Spaces routes, the New Space dialog, and routed foundations for Episodes, Artifacts, People, Developer, Activity, Tenant settings, and Account.

- Added the dashboard Account/Tenant foundation: self-scoped Tenant discovery, atomic idempotent owner onboarding, a hardened same-origin account boundary, sign-in and sign-up, resumable Tenant selection, Account and Tenant reads, generated client contracts, trace proof, and public boundary monitoring.

- Added an account- and Tenant-scoped Episode Diagnostics debugger for
  localhost and staging, with bounded SDK, Sync, and API evidence; redacted
  snapshots, projections, streams, and exports; web and CLI inspection tools;
  W3C journey correlation; and a safe capacity harness. Hosted enablement and
  deployment remain manual.

- Added the framework-neutral `SpaceClient` with one stable `SpaceSnapshot`
  store, typed events, opaque `AccessGrant` refresh, and namespaced media,
  chat, Participant, reaction, and whiteboard controllers.
- Added identical React and React Native bindings built around `<Chalk />`,
  `<Entrance />`, `<ChalkProvider>`, the closed nine-hook surface, capability-
  driven controls, lifecycle recovery, settings, layouts, and closed theme
  tokens.
- Added `@q9labsai/chalk-react-native/client` for advanced native
  `SpaceClient` construction with custom API and Sync endpoints.
- Added the Episode broker, managed-Episode runtime assets, and recorder
  transition guards. Deployment and hosted cutovers remain manual.
- Added end-to-end W3C journey propagation from the SDK Sync hello through every
  Sync server frame, plus the durable `sync.episode.event.committed` signal
  emitted after the Episode command and event are committed.
- Added credential- and PII-safe telemetry restoration and export. Persisted
  events are sanitized before requeue, re-persistence, and export while bounded
  journey metadata remains available for diagnosis.

### Changed

- Redesigned the React Native mobile experience around the Chalk Light system, with first-run onboarding, a new Spaces home, a responsive Entrance, polished live Space controls and progressive sheets, reduced-motion-aware transitions, and the current gradient Chalk launcher icon.

- Refined the React Native Home with illustrated cardless creation and history states plus a Create Space bottom sheet, increased the Entrance preview and safe-area spacing, and added all 15 React SDK palettes and three material textures as native appearance controls.

- Tightened the React Native Space and Entrance headers, removed the redundant Secure badge, softened the Participant count, and made every Space sheet cover the persistent control dock through the device safe area.

- Added independently composable palette and texture options to the React `SpaceView` and `<Chalk />`, including seven paired light and dark color families plus clean, paper, and slate materials. Appearance settings now switch the active surface immediately, and the SDK preview opens directly to that surface for visual comparison.

- Reworked the platform around durable Spaces, bounded Episodes, and
  per-Episode Participants across the database, API, Sync wire, SDKs, apps, and
  infrastructure.
- Replaced built-in authority roles with customer-defined Roles and one closed
  Capability vocabulary. UI authorization now derives only from Participant
  capabilities.
- Moved client access internals under `access` and lifecycle coordination under
  `connection`; the retired client lifecycle namespace and phase mirrors are
  gone.
- Moved the client media-plane interface into a neutral contract shared by Sync
  and provider adapters.
- Moved the first-party web and mobile entry flow to `/space`, app-owned
  identity arrival, opaque access grants, and canonical Participant-credential
  cleanup.
- Squashed the unreleased control-plane database history into a clean
  Space/Episode baseline and aligned generated contracts with it.
- Consolidated reusable React primitives under `@q9labsai/chalk-ui` while
  keeping the public SDK subpath and shared visual language aligned with the
  paper, cool-neutral, watercolor, and chalk-stick design language.
- Renamed observability-facing webhook, provider, and uptime vocabulary to the
  canonical Space/Episode/Participant and connection terms, and isolated the
  observability E2E stack with unique resources, dynamic ports, durable-event
  checks, and task-owned cleanup. Hosted dashboard, provider-rule, and uptime
  consumer cutovers remain manual; this entry does not imply a deployment.

### Breaking

- Replaced `ChalkSession` and `ParticipantAccess` with `SpaceClient` and opaque
  `AccessGrant`; feature commands now live under the canonical namespaced
  controllers.
- Replaced `VideoConference`, `ConferenceView`, and `PreJoinScreen` with
  `<Chalk />`, `SpaceView`, and `<Entrance />`. Legacy exports, props, hooks,
  compatibility aliases, and role booleans were removed.
- Renamed Go, OpenAPI, webhook, Sync, Whiteboard, route, event, schema, broker,
  and runtime vocabulary to Space, Episode, Participant, `EpisodeLease`, and
  `LeaseStore`. Compatibility fallbacks for the unreleased vocabulary were
  removed.
- Renamed the server SDK namespaces to `spaces` and `episodes`, with canonical
  Participant identifiers and generations.
- Replaced the broker's legacy routes, cookie, bindings, environment keys, and
  worker identity with `/participant-credentials`, `/access-grants`,
  `EPISODE_LEASES`, `CHALK_EPISODE_DEADLINE_SECONDS`, and
  `chalk-episode-broker`. Hosted rollout remains a manual cutover.

### Removed

- Removed built-in host/cohost authority, host-exit policy, and role-name-based
  UI decisions.
- Removed app-local mock collaboration flows and standalone demo behavior that
  duplicated SDK-owned lifecycle, chat, media, or whiteboard state.
