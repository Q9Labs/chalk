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
  keeping the public SDK subpath and shared visual language aligned.
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
