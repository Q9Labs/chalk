# Getting oriented in `apps/sync` — 2026-07-08

## The one thing to internalize

`apps/sync` is not an Elixir web app. It is a tiny event-sourced sync kernel with
a few OTP processes wrapped around it — the authoritative realtime room-control
server that Chalk's SDK runtime will eventually talk to. It is small, and the
shape is already right: pure room rules, exactly one writer per room, a
persistence port, and a WebSocket edge that owns no truth.

Read it from the inside out. If you start at the socket, Elixir feels spooky. If
you start at `Room`, it's just data transformation with process shells bolted on.

## How a command actually flows

One room, one authoritative process. A socket never mutates room state. It sends
a command to the room process; the room process asks the pure `Room` module
whether the command is legal, commits the resulting event through the
stateholder, and _only then_ broadcasts to connected sockets.

```
Socket → RoomServer → Room (validate) → Stateholder (commit) → fanout → Socket
```

Commit is compare-and-set. If the revision conflicts, a second writer exists, and
the server stops rather than corrupt state — correctness beats availability here.

Reconnect works by cursor. The client says "I last saw control revision N," and
the room process either replays retained events after N or sends a full snapshot.

Four invariants hold this together, and every design choice below traces back to
one of them:

| Invariant                                 | Where it lives                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| One authoritative writer per room         | `Rooms.RoomServer` — one GenServer per room, started on demand via `Registry`                                          |
| Stateholder is the single source of truth | `Stateholder` port; ETS adapter today, Redis next                                                                      |
| WebSocket nodes are stateless fanout      | `Transport.Socket` holds no authoritative state; if the room server dies it closes with 1012 and the client reconnects |
| Reconnect is snapshot _or_ exact replay   | The `hello` cursor is declarative; the writer decides which                                                            |

## The reading order

**`lib/chalk_sync/rooms/room.ex`** — the pure domain core. No processes, no
network, no clocks, no persistence. `apply_command/4` validates a command and
returns exactly one revisioned event plus the next state. `apply_event/2`
advances state only when the event's `base_revision` matches the current
revision. `snapshot/1` produces the wire-shaped welcome payload. That's the whole
module.

**`test/chalk_sync/rooms/room_test.exs`** — the clearest statement of intent
anywhere in the app. Joins produce revision chains, non-joined actors can't issue
commands, no-op hand changes are rejected, and replaying the event log reproduces
the exact final state.

**`lib/chalk_sync/rooms/room_server.ex`** — the OTP shell around the pure room.
`join/5` starts or finds the room process, subscribes a socket pid, and returns
either a snapshot or a replay. `command/5` routes client commands in. The server
hydrates from the stateholder on startup and stops when the last subscriber
leaves, which is safe because the process is a rebuildable projection — losing it
loses nothing. Command idempotency is a bounded FIFO of the last 256
`{participant_id, command_id}` pairs.

**`test/chalk_sync/rooms/room_server_test.exs`** — the behavior guide for the
process layer. Four tests carry it: fanout after joins and commands, command-id
idempotency, cursor replay, and stop-plus-rehydrate.

**`lib/chalk_sync/stateholder.ex`** — a behaviour, which is Elixir's word for an
interface. Three callbacks: `load/1`, compare-and-set `commit/4`, and
`events_since/2`. The point is that `RoomServer` has no idea whether storage is
ETS, Redis, or something else.

**`lib/chalk_sync/stateholder/memory.ex`** — the only adapter today. ETS tables
hold rooms and retained events; writes funnel through a GenServer so
compare-and-set stays serialized. Replay pulls events newer than the cursor,
oldest first.

**`lib/chalk_sync/protocol.ex`** — the wire contract, and the only place the wire
shape lives. JSON text frames in, internal tagged tuples out. Clients may only
issue whitelisted commands (`raise_hand` and `lower_hand` today; join and leave
are driven by socket lifecycle). Every event carries `base_revision → revision`
so clients can detect drops, duplicates, and reorders. Every command acks exactly
one of `committed | duplicate | rejected`. This module is where SDK protocol
generation should eventually point.

**The auth port** — `auth/claims.ex`, `auth/token_verifier.ex`,
`auth/dev_token_verifier.ex`. Claims carry tenant, room, participant, display
name, and capabilities. The verifier is a behaviour-backed port. The dev verifier
deliberately trusts unsigned base64url JSON, and prod boot refuses to start with
it configured.

**`lib/chalk_sync/transport/socket.ex`** — intentionally thin. Wait for `hello`,
verify the token, join the room, encode the welcome, forward commands to
`RoomServer`, push room events back out. The branch worth knowing: if the room
server dies, the socket closes with 1012 and the client reconnects and
re-snapshots.

**`lib/chalk_sync/transport/router.ex`** and **`application.ex`** — the router
exposes exactly two routes, `GET /healthz` and `GET /v1/sync`. The application
starts the room registry, the dynamic room supervisor, the stateholder, and the
Bandit listener.

## Elixir handles, if you need them

`defmodule X do ... end` defines a module; `def` is a function, `defp` a private
one. Atoms like `:ok`, `:join`, `:raise_hand` are interned constants — think
enums or symbols.

Tuples carry tagged results: `{:ok, value}`, `{:error, reason}`,
`{:committed, revision}`. Pattern matching is everywhere, and it does double duty.
In `{:ok, event, room} = Room.apply_command(...)`, the left side both asserts the
call succeeded and destructures the result.

Maps are `%{"type" => "hello"}` with string keys, `%{phase: :joined}` with atom
keys. Structs like `%Claims{tenant_id: tenant_id}` are maps with a fixed shape
declared by a module.

Pipes pass the previous value as the first argument:
`conn |> put_resp_content_type(...) |> send_resp(...)`.

`with` is a happy-path chain — every pattern matches and the `do` block runs;
one doesn't and control jumps to `else`.

`GenServer.call(pid, msg)` is synchronous process messaging; `send(pid, msg)` is
async; `Process.monitor(pid)` asks the runtime for a `:DOWN` message when that
process dies.

`use GenServer` or `use Plug.Router` injects behaviour boilerplate. `@impl true`
marks a function as implementing a behaviour callback.

## What's missing, and how much it matters

**Signed token verification is not implemented.** _Major — blocks running this as
a trusted service._ The `TokenVerifier` port is shaped and prod boot refuses an
unset verifier, so the guardrails are in place. But the only real adapter today
is the dev one that trusts unsigned JSON. Real per-tenant signature verification
is waiting on the control-plane API's key registry.

**Capabilities are carried but never consulted.** _Major — correctness, and it
gets worse with time._ `Claims.capabilities` rides along on every verified token
and nothing reads it. Before host controls or moderation commands land, command
authorization needs to sit between verified claims and `Room.apply_command/4` —
most likely inside `RoomServer.execute/5` or a small policy module called from
there. Adding host-only commands _first_ would mean retrofitting a trust boundary
under live code.

**`Stateholder.Memory` is single-node only.** _Minor — not urgent, just finite._
ETS is correct for dev and test and stays correct right up until the second
WebSocket node. The port shape already anticipates the Redis adapter
(compare-and-set commit plus a retained event tail), so this is a fill-in, not a
redesign.

**Protocol types are hand-written.** _Minor — maintainability._ Fine today. It's
also the highest-leverage place to connect API/SDK generation, since that's what
stops client and server from drifting apart.

## Good first changes

**Add capability enforcement for `raise_hand` and `lower_hand`.** Small enough to
learn the app, meaningful enough that you touch the real trust boundary. This is
the one I'd start with.

**Add one command end-to-end** — something like `set_participant_status` — but
decide its wire event name and snapshot shape _before_ writing code. The path is
mechanical once you've picked those: `Protocol` whitelist → `Room.validate/4` →
`Room.apply_payload/2` → room tests → room-server tests → socket integration test.

**Don't add schema generation around `Protocol` yet.** It's a contract move that
should follow the SDK direction, not a local cleanup you do while you're in there.

## Commands

From `apps/sync`:

```bash
mix test
scripts/gate.sh     # canonical pre-commit gate: format, compile, credo, test
iex -S mix          # dev server on http://localhost:4100
```

Focused runs:

```bash
mix test test/chalk_sync/rooms/room_test.exs
mix test test/chalk_sync/rooms/room_server_test.exs
mix test test/chalk_sync/transport/socket_test.exs
```
