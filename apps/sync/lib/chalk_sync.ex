defmodule ChalkSync do
  @moduledoc """
  Chalk sync server — the control-plane sync engine behind the `SyncEngine`
  port.

  Architecture map:

    * `ChalkSync.Rooms.Room` — pure room-control state machine (revisioned
      events; no processes or side effects).
    * `ChalkSync.Rooms.RoomServer` — one authoritative writer per room;
      serializes commands, commits to the stateholder, then fans out.
    * `ChalkSync.Stateholder` — port over durable Session control storage;
      PostgreSQL is authoritative and in-memory adapters support tests.
    * `ChalkSync.Auth.TokenVerifier` — port over participant-token
      verification (dev adapter now, per-tenant signatures next).
    * `ChalkSync.Protocol` — the language-neutral wire protocol (v1).
    * `ChalkSync.Transport.*` — HTTP/WebSocket edge; stateless fanout only.

  See `README.md` for invariants and the protocol walkthrough.
  """
end
