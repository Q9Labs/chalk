# Architecture And SDK Decisions

## SDK-First Ownership

Product behavior belongs in packages before apps. `sdk-core` owns client
logic, room lifecycle, auth/token plumbing, WebRTC integration, diagnostics,
and durable domain behavior. `sdk-react`, `sdk-react-native`,
`chalk-whiteboard`, and `ui` expose package-level integrations and components.
Demo apps should stay thin: configuration, branding, and verification surfaces.

This rule prevents app-only fixes from becoming hidden product behavior. When a
consumer or demo app reveals a bug, the fix should land in the owning package
unless it is truly integration-specific.

## Web Boundary Reset

The web app is useful as the first-party product shell, but reusable meeting
behavior should not depend on it. Shared APIs, debug exports, room-entry
decisions, whiteboard behavior, and media controls should be package-owned.
The app can choose routes and visual framing, but not redefine SDK contracts.

## Architecture Reset Lessons

The architecture reset specs converged on a few invariants:

- keep room/session state explicit rather than hidden behind app-local effects
- preserve typed boundaries between API contracts, SDK resources, UI state, and
  runtime diagnostics
- make join and reconnect phases observable enough to debug without raw logs
- keep migration/cutover plans reversible until browser and automated checks
  prove the new path
- verify public behavior through both package tests and user-level app flows

## Data Model Direction

Chalk moved toward a clearer multi-tenant model with rooms, participants,
recordings, transcripts, summaries, webhooks, and runtime configuration owned
by explicit tenant boundaries. Useful public lessons:

- tenant-scoped configuration should be treated as runtime policy, not static
  app behavior
- generated API contracts are valuable, but runtime migrations and checked-in
  migrations must stay aligned
- tenant and room identifiers are sensitive operational context in logs and
  scratchpad notes, even when they are not credentials
- schema changes are release blockers until local and production schemas are
  both verified

## React Native Platform Split

React Native support should not be a thin web wrapper. The package split keeps
native meeting surfaces, media handling, mobile lifecycle behavior, and
platform-specific UX inside `sdk-react-native`, with `sdk-core` exposing the
shared session and domain primitives.

Public lessons from the platform split:

- shared behavior should stay in `sdk-core`
- platform-specific layout and app lifecycle belong in native packages
- simulator and device verification catch issues package tests cannot
- app-level mobile code should remain wiring and release configuration

## Transcription Architecture

Post-meeting transcription evolved toward an asynchronous provider flow:
recording completion schedules work, provider workers process media, and the
API remains the source of truth for transcript state and tenant-facing webhook
delivery.

Durable decisions:

- terminal provider failure should be represented explicitly and still notify
  downstream webhook consumers with recording data plus failure metadata
- transient retries should avoid noisy customer-facing state changes
- queue-backed processing gives clearer retry and dead-letter semantics than
  long in-process API work
- provider implementations should be swappable behind stable domain state
