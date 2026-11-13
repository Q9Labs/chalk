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
      `Stateholder.Postgres` is the one adapter, and every suite runs on it.
    * `ChalkSync.Auth.TokenVerifier` — port over participant-token
      verification (JWT in production, a development verifier for local proof).
    * `ChalkSync.ProtocolV1` — the language-neutral wire protocol.
    * `ChalkSync.Transport.*` — HTTP/WebSocket edge; stateless fanout only.

  See `README.md` for invariants and the protocol walkthrough.
  """
end
