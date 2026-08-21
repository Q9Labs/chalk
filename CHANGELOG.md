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

- Added public docs at `/docs` with Why Chalk, a working Quickstart,
  first-class TypeScript, React, and React Native guides, product concepts,
  feature guides, webhooks, public API guidance, local search, and responsive
  keyboard-friendly navigation.
- Added canonical metadata, structured data, a sitemap, crawler guidance,
  `llms.txt`, and a product-led social preview to the public web app.

- Added a shared animated `Logo` to the React and React Native SDKs. Its chalk
  sticks orbit by default and burst immediately on hover, focus, or press while
  the wordmark stays still; the web app now uses the same component.
- Added QR invite sharing, safe diagnostic references, optional Space
  descriptions, Entrance media-device selectors, capability-aware admission
  requests inside Participants, and Funavatars to the React SDK Space.
- Added `web` and `mobile` shipment targets to the affected-workspace gate, so
  shared SDK changes can validate one consumer lane without hiding shared,
  non-platform, global, or directly changed work.
- Added typed `classic` and `chalk` skins to the web React SDK theme. Classic is
  the default, the existing hand-drawn treatment remains available as Chalk,
  and either skin composes independently with every typed palette and texture.
- Added deterministic hand-drawn chalk controls across the React SDK Entrance
  and Space, plus public chalk buttons, fields, toggles, panels, menus, dialogs,
  alerts, sliders, badges, and loading primitives for custom SDK surfaces.
- Wired the React SDK sound cues: join, leave, chat, hand raise, and reaction
  cues from the shared assets play on Space changes, on by default behind the
  new `sounds` feature and a Settings toggle.
- Added a System, Light, and Dark theme choice to the dashboard account menu.
  The preference is remembered across visits and applied before the first
  paint, and it covers the dashboard, Space administration, and every chalk
  popup. Landing and legal pages stay on the paper palette.
- Added exact-SHA, component-aware managed release manifests and a manual
  release workflow that builds only the changed API or Sync image while
  carrying the stable component digest and provenance forward.
- Added a versioned SSM host deployment controller with fail-closed runtime
  inputs, health-gated promotion, automatic rollback, and exact secret restore
  after reboot.
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

- Nested microphone input and speaker selection behind the Entrance microphone
  control and camera selection behind the camera control. The SDK preview now
  uses the same light defaults and deterministic device contract as the real
  Entrance, and its primary action keeps the same neutral primary color in
  light and dark themes.
- Reworked the React SDK Space controls, details, Settings, Participants,
  capability requests, Entrance, and exit surfaces into one consistent and
  responsive interaction system. Settings now has one visible surface with a
  combined Audio and video section, and Leave is separate from the
  capability-gated End Episode action.
- Removed the duplicate name-only Entrance, obsolete Settings groups, separate
  admission drawer, and unwired Transcript Space entry points while preserving
  the lower-level transcript contracts.
- Isolated the public Open a Space flow. Each new invite now gets its own
  one-hour Space, while invite joins reuse that Space. Cleanup archives it, so
  unrelated anonymous visitors no longer share durable chat or whiteboard data.
- Restored the React SDK’s pre-redesign Entrance and Space layouts as the
  Classic skin, and rebuilt the Chalk Entrance as a balanced responsive split
  between the camera preview and entry form.
- Rebuilt the React SDK Space stage on one measured renderer for both skins.
  Participants, each live screen share, and the open whiteboard are all stage
  tiles: any tile can be pinned or become the primary, spotlight shows one
  primary with a strip, and grid keeps tiles equal. Overflow pages instead of a
  "+N more" tile, tiles keep their video element across layout and page
  changes, and speaking and active-speaker come from sync presence. `Stage`,
  `buildStageItems`, `StageItem`, and `StageLayout` are exported; the
  `showScreenShareIndicator` and `screenShareContent` grid props are removed and
  `isVideoEnabled` now means the camera alone.
- Made the SDK preview gallery share a real captured canvas track and offer
  9- and 12-Participant rosters, so the stage renders live rather than behind a
  mock overlay.
- Brought `/sdk-preview` Entrance and Space states to production-surface parity
  with deterministic local media, device, whiteboard, lifecycle, admission,
  diagnostics, capability, feature, and theme controls. The tweaker now drives
  stable URLs while the visible Settings and End Episode controls exercise the
  same preview state.
- Replaced the React SDK Space side panels with one right-hand drawer in both
  skins. Chat, People, Transcript, and Admission dock as a full-height column
  that pushes the stage on wide screens and slide in as a sheet over a scrim on
  narrow ones; the drawer animates open and closed, honours reduced motion,
  closes on Escape, and returns focus to the control that opened it.
  `AdmissionPanel` gains an `onClose` prop and close button.
- Made React SDK Space grid tiles fill the stage: tiles now stretch to their
  whole cell instead of holding 16:9, so no band of empty stage is left around
  2, 9, or 12 Participants, and only absurdly tall or wide cells clamp to a
  3:4–21:9 range. `minTileHeight` joins the grid fit options and the aspect
  list is gone. Redesigned the tile name chip as one dark glass pill with the
  name, a red muted mark, and a yellow raised-hand mark, in both skins.
- Redesigned the React SDK Space chrome around the stage. The header is now a
  slim ghost bar with a Layout menu (Spotlight, Grid, Presentation) and Info
  next to Settings, the participants button leaves the header, the stage
  reaches further down under a floating control bar, and Share and Board
  join the bar. Presence is shown in the tile chip and as a soft halo on the
  avatar rather than a frame; the chip scales with the tile. Pager arrows sit
  at the strip edge with quiet dots, and the drawer docks as an inset card
  aligned with the stage. Reactions get a compact tray and a calmer float.
  The SDK preview gallery now enables the same features as the Space (share,
  whiteboard, sounds, info) and publishes a silent microphone track for
  unmuted Participants so speaking renders as it does live.
- Rebuilt the dashboard sidebar on a shadcn-style primitive: a chalkboard-dark
  panel with a collapsible icon rail, tooltips, a keyboard toggle, persisted
  state, and a drawer on small screens.
- Made the local API gate own its isolated migrated PostgreSQL database, expose
  every integration-test database alias, run independent checks in parallel,
  and avoid duplicate vet work in `go test`.
- Removed the unfinished standalone API performance harness. A replacement can
  return when it has stable workload, latency, and regression contracts.

### Fixed

- Kept a newly created public Space admitted while its index URL becomes the
  canonical invite route, so that route ownership cannot leave the creator and
  archive the Space before another Participant arrives.
- Kept app-route fallbacks separate from public pages and static assets, so
  deep links load the SPA shell without redirect loops or incorrect asset
  content types.

- Removed the faint fill behind the floating Space controls and gave raised
  hover states enough vertical clip space to remain fully visible.
- Fixed Episode Debugger live evidence reconnect loops by replacing oversized
  streamed snapshots with compact refill directives and bounding every SSE data
  line to the browser decoder limit.
- Fixed the sidebar navigation labels, which the chalk reset drew over the
  utility classes that were meant to colour them, leaving them barely legible
  on the dark panel.
- Fixed the tenant switcher, which threw when it labelled its group of Tenants
  outside a menu group.
- Fixed chalk popups reading the theme once when they opened, so a menu, a
  tooltip, or a toast no longer keeps the old palette after the theme changes
  underneath it.
- Serialized web releases across SHAs, added guarded stale-lock recovery, and
  made manifest component ordering match runtime validation.
- Fixed the web release preflight, which read the pinned Wrangler version from
  the workspace before installing it and so failed on every fresh checkout.
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

## [4.1.11] - 2026-08-20

### Fixed

- Remounting Board refreshes the authoritative Sync snapshot even when an in-memory snapshot has the same revision.

## [4.1.10] - 2026-08-20

### Fixed

- Reopening Board refreshes the current durable scene instead of replaying a stale cached snapshot.

## [4.1.9] - 2026-08-20

### Fixed

- Made immediate Board reopen wait for replayed edits before loading its snapshot.

## [4.1.8] - 2026-08-20

### Fixed

- Preserved Board edits when a Participant closes the Board immediately after editing.

## [4.1.7] - 2026-08-20

### Added

- Added one `cspi1` public link and one API-owned arrival flow for every Space,
  including capability-first web and native clients, Dashboard link controls,
  `open` and `knock` admission, browser and native Guest credentials, and
  Cloudflare SFU and RealtimeKit media access.
- Added managed public Space creation with configurable bounded retention,
  durable cleanup and archive retries, and Episode-scoped Chat and Whiteboard
  content that cannot expose a prior Episode to a public Participant.

### Changed

- Made Space creation materialize its public invite in the same database
  transaction and made public arrival, refresh, leave, rotation, disablement,
  approval, denial, audit, tracing, and status use the API control plane.
- Added provider-neutral SDK media access and production RealtimeKit adapters
  for browsers and React Native while preserving the Cloudflare SFU path.

### Fixed

- Kept public invites compatible with browsers that send B3 tracing headers.

- Made managed migration repair apply only explicitly allowed missing
  checked-in migrations before the exact release target, while rejecting any
  other out-of-order gap.
- Kept managed release validation bound to the manifest migration target while
  accepting only the bounded missing-version arguments rendered by the release.

### Removed

- Removed both Episode broker workers, their public routes and cookies, the
  legacy 43-character invite format, and their runtime, monitor, development,
  mobile, and bootstrap configuration.

## [4.1.6] - 2026-08-20

### Fixed

- Kept the Board presentation command bound to its Whiteboard transport, so
  opening Board updates the shared Stage instead of failing before Sync sees it.
- Made managed releases apply their exact database migration target before API
  and Sync start, and made API readiness fail when the database schema is behind.
- Fetched managed runtime inputs in AWS SSM batches of at most 10, so releases
  can add required inputs without exceeding the service request limit.
- Created new Podman secrets without replacement mode on Podman 4.9, and removed
  candidate-only units when a managed release rolls back.
- Started the dedicated migration binary as the one-shot container entrypoint,
  so managed releases use the mounted owner database URL instead of API defaults.

## [4.1.5] - 2026-08-19

### Fixed

- Made Board presentation shared across every Participant in an Episode, focus
  it ahead of an active screen share, and keep the scene intact across
  close/reopen by flushing the final pending drawing before the canvas unmounts.
- Kept Board presentation safe during rolling upgrades and replay recovery:
  older Sync servers get the legacy handshake, older clients keep their exact
  wire shape, and a recovered connection refreshes shared presentation state.

## [4.1.4] - 2026-08-19

### Fixed

- Made the React SDK start and await the Whiteboard scene subscription before
  mounting its collaboration canvas, and made snapshot failures stay on the
  reported error path instead of escaping as uncaught synchronous errors.
- Made Cloudflare SFU failures retain an unknown provider error code, scrubbed
  provider message and fingerprint, request and response track counts, response
  size, and trace IDs without recording SDP, credentials, or media identifiers.
- Made managed host secret rotation use Podman's atomic replacement path and
  an actual input pipe, so Podman 4.9 can register new values without deleting
  the stable secret first.

## [4.1.3] - 2026-08-19

### Fixed

- Made React SDK Space sound cues recover when browser autoplay policy blocks
  the first attempt: the pending cue now retries on the next pointer, touch,
  click, or keyboard interaction. Cue audio also follows the selected speaker
  when the browser supports output-device routing.

## [4.1.2] - 2026-08-18

### Added

- Added `web` and `mobile` shipment targets to the affected-workspace gate, so
  shared SDK changes can validate one consumer lane without hiding shared,
  non-platform, global, or directly changed work.
- Wired the React SDK sound cues: join, leave, chat, hand raise, and reaction
  cues from the shared assets play on Space changes, on by default behind the
  new `sounds` feature and a Settings toggle.

### Changed

- Rebuilt the React SDK Space stage on one measured renderer for both skins.
  Participants, each live screen share, and the open whiteboard are all stage
  tiles: any tile can be pinned or become the primary, spotlight shows one
  primary with a strip, and grid keeps tiles equal. Overflow pages instead of a
  "+N more" tile, tiles keep their video element across layout and page
  changes, and speaking and active-speaker come from sync presence. `Stage`,
  `buildStageItems`, `StageItem`, and `StageLayout` are exported; the
  `showScreenShareIndicator` and `screenShareContent` grid props are removed and
  `isVideoEnabled` now means the camera alone.
- Made the SDK preview gallery share a real captured canvas track and offer
  9- and 12-Participant rosters, so the stage renders live rather than behind a
  mock overlay.
- Replaced the React SDK Space side panels with one right-hand drawer in both
  skins. Chat, People, Transcript, and Admission dock as a full-height column
  that pushes the stage on wide screens and slide in as a sheet over a scrim on
  narrow ones; the drawer animates open and closed, honours reduced motion,
  closes on Escape, and returns focus to the control that opened it.
  `AdmissionPanel` gains an `onClose` prop and close button.
- Made React SDK Space grid tiles fill the stage: tiles now stretch to their
  whole cell instead of holding 16:9, so no band of empty stage is left around
  2, 9, or 12 Participants, and only absurdly tall or wide cells clamp to a
  3:4–21:9 range. `minTileHeight` joins the grid fit options and the aspect
  list is gone. Redesigned the tile name chip as one dark glass pill with the
  name, a red muted mark, and a yellow raised-hand mark, in both skins.
- Redesigned the React SDK Space chrome around the stage. The header is now a
  slim ghost bar with a Layout menu (Spotlight, Grid, Presentation) and Info
  next to Settings, the participants button leaves the header, the stage
  reaches further down under a floating control bar, and Share and Board join
  the bar. Presence is shown in the tile chip and as a soft halo on the avatar
  rather than a frame; the chip scales with the tile. Pager arrows sit at the
  strip edge with quiet dots, and the drawer docks as an inset card aligned
  with the stage. Reactions get a compact tray and a calmer float. The SDK
  preview gallery now enables the same features as the Space (share,
  whiteboard, sounds, info) and publishes a silent microphone track for
  unmuted Participants so speaking renders as it does live.

### Fixed

## [4.1.1] - 2026-08-18

### Added

- Added typed `classic` and `chalk` skins to the web React SDK theme. Classic is
  the default, the existing hand-drawn treatment remains available as Chalk,
  and either skin composes independently with every typed palette and texture.
- Added deterministic hand-drawn chalk controls across the React SDK Entrance
  and Space, plus public chalk buttons, fields, toggles, panels, menus, dialogs,
  alerts, sliders, badges, and loading primitives for custom SDK surfaces.
- Added an environment-owned Cloudflare SFU default MediaPlane for new Spaces
  while keeping concrete Tenant-managed provider configuration authoritative.
- Enabled Google sign-in in the managed production API contract with a complete
  OAuth client triplet and the exact Chalk web callback.
- Added a System, Light, and Dark theme choice to the dashboard account menu.
  The preference is remembered across visits and applied before the first
  paint, and it covers the dashboard, Space administration, and every chalk
  popup. Landing and legal pages stay on the paper palette.
- Added exact-SHA, component-aware managed release manifests and a manual
  release workflow that builds only the changed API or Sync image while
  carrying the stable component digest and provenance forward.
- Added a versioned SSM host deployment controller with fail-closed runtime
  inputs, health-gated promotion, automatic rollback, and exact secret restore
  after reboot.
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
- Added one public Space invite contract for customer-managed and auto-created
  Spaces, with collaborator Guest admission, open and knock policies, durable
  rotation controls, browser and React Native clients, and SFU or RealtimeKit
  media grants.

### Changed

- Rebuilt the dashboard sidebar on a shadcn-style primitive: a chalkboard-dark
  panel with a collapsible icon rail, tooltips, a keyboard toggle, persisted
  state, and a drawer on small screens.
- Restored the React SDK’s pre-redesign Entrance and Space layouts as the
  Classic skin, and rebuilt the Chalk Entrance as a balanced responsive split
  between the camera preview and entry form.
- Made the local API gate own its isolated migrated PostgreSQL database, expose
  every integration-test database alias, run independent checks in parallel,
  avoid duplicate vet work in `go test`, and overlap PostgreSQL preparation
  with database-free checks.
- Made detached local web releases reuse the main checkout's Turbo cache while
  keeping web build inputs and the exact release SHA in the cache key.
- Moved public Space creation, admission, credential refresh, leave, and timed
  auto-Space archival into the API, so every canonical invite resolves an exact
  Tenant and Space before account or Guest identity is selected.
- Removed the unfinished standalone API performance harness. A replacement can
  return when it has stable workload, latency, and regression contracts.

### Fixed

- Fixed Episode Debugger live evidence reconnect loops by replacing oversized
  streamed snapshots with compact refill directives and bounding every SSE data
  line to the browser decoder limit.
- Fixed the dependency vulnerability gate under macOS's system Bash so its
  lockfile discovery no longer fails inside nested null-delimited reads.
- Fixed first join for newly created Spaces whose Tenant has no custom
  MediaPlane configuration, and added bounded resolver traces, metrics, and
  structured logs for the selected configuration source.
- Fixed the sidebar navigation labels, which the chalk reset drew over the
  utility classes that were meant to colour them, leaving them barely legible
  on the dark panel.
- Fixed the tenant switcher, which threw when it labelled its group of Tenants
  outside a menu group.
- Fixed chalk popups reading the theme once when they opened, so a menu, a
  tooltip, or a toast no longer keeps the old palette after the theme changes
  underneath it.
- Restored the landing hero's anonymous Space entry so its primary action opens
  the `/space` Entrance without Account authentication.
- Serialized web releases across SHAs, added guarded stale-lock recovery, and
  made manifest component ordering match runtime validation.
- Fixed the web release preflight, which read the pinned Wrangler version from
  the workspace before installing it and so failed on every fresh checkout.
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

## [4.1.0] - 2026-08-16

### Added

- Added `spaces.get`, `spaces.list`, `spaces.archive`, and `spaces.restore` to the
  `@q9labsai/chalk-client` server SDK, with `archived` and `archived_at` on the
  returned Space.
- Added sidebar and menu primitives to `@q9labsai/chalk-ui`.

### Changed

- Let a `getAccess` callback return the server-minted grant unchanged as the
  `Response` that carries it or as its decoded JSON (`AccessGrantSource`). The
  client validates the grant and fails the join with `Access was rejected`, so
  applications proxying their own join endpoint no longer need a cast.
- Refreshed the TypeScript SDK and API dependencies to their current releases.

### Fixed

- Fixed visitor Space access refresh so the browser forwards media proof to the
  broker. Proof-less renewals made the broker replace the media connection,
  which the client rejected at the first refresh window as an invalid grant.
- Fixed Dashboard Space access refresh so scheduled renewal preserves current
  media proof and rejected credentials recover with a replacement connection.
- Accepted PostgreSQL-formatted UUID values in the generated client schemas and
  preserved Episode conflict and upstream statuses in the generated HTTP API.

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
