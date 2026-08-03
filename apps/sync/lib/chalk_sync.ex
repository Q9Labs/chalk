defmodule ChalkSync do
  @moduledoc """
  Chalk sync server — the control-plane sync engine behind the `SyncEngine`
  port.

  Architecture map:

    * `ChalkSync.Episodes.Reducer` — pure Episode-control state machine
      (revisioned events; no processes or side effects).
    * `ChalkSync.Episodes.Coordinator` — node-local Episode coordination;
      PostgreSQL remains the authoritative writer.
    * `ChalkSync.Stateholder` — port over durable Episode control storage;
      PostgreSQL is authoritative and in-memory adapters support tests.
    * `ChalkSync.Auth.TokenVerifier` — port over participant-token
      verification (dev adapter now, per-tenant signatures next).
    * `ChalkSync.ProtocolV1` — the language-neutral wire protocol.
    * `ChalkSync.Transport.*` — HTTP/WebSocket edge; stateless fanout only.

  See `README.md` for invariants and the protocol walkthrough.
  """
end
