# SDK Variant Decision Report (2026-03-06)

Scope: `packages/sdk-core`

Goal: pick one canonical variant per duplicated seam, reduce drift, keep compatibility where removal is risky.

## Executive Decisions

1. Keep `token.expired` (dot notation). Remove `token-expired`.
2. Keep whiteboard wire `v2` (`schemaVersion: 2`, `sceneId`, `syncAll`) as canonical outbound path.
3. Keep dot-notation WS event names as canonical contract (`participant.joined`, `room.snapshot`, etc.).
4. Keep `token/tokenProvider` auth path as canonical; keep `apiKey` temporarily as deprecated compatibility.

## Decision Table

| Seam | Variants found | Decision | Why | Action window |
|---|---|---|---|---|
| Auth expiry event name | `token-expired` vs `token.expired` | Keep `token.expired` | Most runtime layers already emit dot form; kebab form is drift | Immediate |
| Whiteboard update payload | v1 (no `schemaVersion`, delta merge semantics) vs v2 (`schemaVersion:2`, `sceneId`, `syncAll`) | Keep v2 | Better sync semantics, explicit schema, already supported inbound | Immediate outbound switch + staged v1 inbound deprecation |
| WS event naming | colon names in `types/events/*` vs dot names in runtime schemas/session | Keep dot names | Runtime source of truth already dot-based; colon map is legacy type layer | Immediate for internals; staged public type migration |
| Auth mode | `token/tokenProvider` vs deprecated `apiKey` | Keep token/provider | Security and modern flow; `apiKey` already flagged deprecated | Keep deprecated until next major |

## Evidence (Pinpointed)

- `token-expired` still present in client:
  - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/client.ts:39`
  - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/client.ts:83`
  - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/client.ts:325`
- `token.expired` already used across lower layers:
  - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/api-client.ts:22`
  - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/ws-client/base.ts:261`
  - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/conference-client/join-session.ts:83`

- Whiteboard v1/v2 dual outbound APIs:
  - v1 send path used by manager:
    - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/managers/whiteboard-manager.ts:347`
    - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/ws-client/client.ts:42`
  - v2 send path exists:
    - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/ws-client/client.ts:54`
    - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/room.ts:400`
  - inbound handles both:
    - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/managers/whiteboard-manager.ts:149`

- Dead/unclear toggle:
  - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/session/chalk-session.ts:63`
  - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/session/chalk-session.ts:224`

- Dot-vs-colon contract drift in public types:
  - colon-notation map/types:
    - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/types/events/server-events.ts`
    - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/types/events/client-events.ts`
  - dot-notation runtime contract:
    - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/conference-session/types.ts`
    - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/effect/schemas/ws-emitted.ts`
    - `/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/effect/schemas/ws-outbound.ts`

## Recommended Execution Plan

### Phase A (safe, immediate)

1. Normalize `ConferenceClient` to emit/listen only `token.expired`.
2. Remove/replace stale `token-expired` references in `client.ts`.
3. Mark/cleanup `whiteboardSyncV2` toggle if truly unused.

### Phase B (controlled compatibility)

1. Switch `WhiteboardManager.sendUpdate` to v2 send path.
2. Keep inbound v1+v2 parsing for one release cycle.
3. Add telemetry counters for inbound v1 usage to time final removal.

### Phase C (public surface cleanup)

1. Migrate `types/events/*` to dot-notation canonical maps.
2. Keep temporary aliases behind deprecated types only if needed.
3. Publish as breaking-change note in changelog/release notes.

## Risks

- External consumers relying on colon event type maps may break if removed abruptly.
- Whiteboard v1 send removal too early can break mixed-version sessions.

Mitigation:
- Keep inbound compatibility first, then remove old outbound.
- Ship deprecation notes + one release overlap before hard removal.
