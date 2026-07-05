# Chalk Sync Server

Elixir/OTP WebSocket sync server — the primary adapter behind the `SyncEngine`
port (`docs/redesign/north-star.md`). Real-time room state lives here; Postgres
never sees it.

## Commands

```bash
mix deps.get
mix test
iex -S mix          # dev server on http://localhost:4100
scripts/gate.sh     # canonical pre-commit gate (format, compile, credo, test)
```

## Architecture

The north-star sync invariants, mapped onto OTP:

| Invariant                            | Implementation                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| One authoritative writer per room    | `Rooms.RoomServer` — one GenServer per room, started on demand via `Registry`                                    |
| Stateholder = single source of truth | `Stateholder` port; `Stateholder.Memory` (ETS) now, Redis adapter next                                           |
| WS nodes are stateless fanout        | `Transport.Socket` owns no authoritative state; room-server loss ⇒ close 1012 ⇒ client reconnects + re-snapshots |
| Reconnect = snapshot or exact replay | declarative `hello` cursor; writer decides replay vs snapshot                                                    |

Command flow: socket → room server → validate against the pure `Rooms.Room`
state machine → compare-and-set commit to the stateholder → fan out → ack. A
commit revision conflict means a second writer exists; the server stops rather
than corrupt state (correct > fast).

`Rooms.Room` is a pure, event-sourced core: commands produce revisioned events
(`base_revision -> revision`), state advances only by applying events, and
replaying the log reproduces the state exactly. All process concerns
(serialization, monitors, fanout) live in the `RoomServer` shell.

## Ports (vendor specifics never leak past these)

- `ChalkSync.Stateholder` — durable live-state store. Adapters: `Memory` (ETS,
  single-node dev/test); Redis is the named next adapter for multi-node.
- `ChalkSync.Auth.TokenVerifier` — participant-token verification. Adapters:
  `DevTokenVerifier` (unsigned, dev/test only; prod boot refuses it); the
  per-tenant signature verifier (north-star constraint 12) is next and will
  consume the control-plane API's key registry.

## Wire protocol (v1)

JSON text frames, language-neutral — see `ChalkSync.Protocol` for the full
shape. Highlights:

- `hello` carries the participant token plus declared streams and cursors;
  the server answers `welcome` in `snapshot` or `replay` mode.
- Every control event carries `base_revision -> revision` so clients detect
  drops, duplicates, and reorders.
- Commands carry client `command_id`s and ack exactly one of
  `committed | duplicate | rejected` (session-scoped idempotency).
- Client-issuable commands are whitelisted (`raise_hand`, `lower_hand` today);
  join/leave are socket-lifecycle driven.

Routes: `GET /healthz` (unversioned, ops) and `GET /v1/sync` (WebSocket).

## What is deliberately not here yet

- **Redis stateholder adapter** — the port is shaped for it (compare-and-set
  commit + retained event tail); single-node ETS is correct until the second
  WS node.
- **Signed token verification** — blocked on the API's per-tenant key
  registry; prod boot fails without a real verifier configured.
- **Presence/volatile streams** (cursors, speaking, typing) — protocol has a
  `stream` field as the seam; volatile streams skip the stateholder entirely.
- **Capability enforcement per command** — `Claims.capabilities` is carried
  but not yet consulted; enforcement lands with the capability-bit model.
- **Schema-generated protocol types** — the shapes in `Protocol` will move to
  the language-neutral schema source of truth that generates every SDK.
