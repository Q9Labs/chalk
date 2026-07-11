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

## Interactive sync lab

Start the development server with `mix run --no-halt`, then open
`http://localhost:4100/dev/lab`. The lab starts empty so a session can be
observed from its first participant. It connects participants to the real
`/v1/sync` WebSocket and shows shared state, command acknowledgements, raw
protocol frames, reconnect behavior, and a human-readable server trace.

The production drills exercise bad authentication, malformed frames, duplicate
commands, cursor fallback, and room-writer loss. The lab labels which behavior
is real, which behavior is a local approximation, and which production work is
still missing.

The lab and its `/dev/traces` stream are enabled only when `dev_tools` is true.
Development and test enable them; production keeps them disabled and returns
404 for both surfaces. Trace records are bounded in memory and never include
participant tokens.

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

Routes: `GET /healthz` (liveness), `GET /readyz` (room registry, supervisor,
and stateholder readiness), and `GET /v1/sync` (WebSocket).

## Observability v1

`ChalkSync.Observability` is the only production observability boundary. It
emits stable `:telemetry` events, correlated Logger metadata, and short
OpenTelemetry spans. It does not retain a connection-long span. Socket work
uses root, phase, and terminal events; room-writer work links back to the
originating socket span after crossing the OTP process boundary.

Set `CHALK_SYNC_OTLP_ENDPOINT` to enable OTLP HTTP/protobuf export. The
service resource name is `chalk-sync`; the exporter is otherwise disabled.
The batch processor isolates collector failures from room and socket work.

```bash
CHALK_SYNC_OTLP_ENDPOINT=http://localhost:4318 mix run --no-halt
```

The stable telemetry event name is `[:chalk_sync, :observability, :event]`.
Its measurements are `%{count: 1}` and its metadata contains `event`, `stage`
(`root`, `phase`, or `terminal`), `journey_id`, and bounded `attributes`.
BEAM health uses `[:chalk_sync, :runtime, :health]` with memory, process, and
run-queue measurements. Logger events include the journey and, when tracing is
enabled, the trace and span identifiers. Tokens, room ids, participant ids,
command ids, and raw revisions are never observability dimensions.

Every client and server protocol frame may carry these optional top-level
fields without changing v1 frame semantics:

```json
{
  "journey_id": "00000000-0000-4000-8000-000000000042",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "tracestate": "vendor=value"
}
```

`traceparent` and `tracestate` use W3C Trace Context. HTTP upgrades use the
same headers plus `x-chalk-journey-id`; browser clients that cannot set upgrade
headers send the three fields on `hello`. The server forwards valid context on
its response frames and creates a journey at sync ingress when one is absent.

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
