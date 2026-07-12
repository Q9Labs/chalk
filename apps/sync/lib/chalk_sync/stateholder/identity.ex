defmodule ChalkSync.Stateholder.Identity do
  @moduledoc "Verified participant-session identity used for durable decisions."

  alias ChalkSync.Stateholder.SessionKey

  @enforce_keys [:session, :participant_session_id, :participant_session_generation]
  defstruct [
    :session,
    :participant_session_id,
    :participant_session_generation,
    :admission_lifecycle_intent_id,
    capabilities: []
  ]

  @type t :: %__MODULE__{
          session: SessionKey.t(),
          participant_session_id: String.t(),
          participant_session_generation: pos_integer(),
          admission_lifecycle_intent_id: String.t() | nil,
          capabilities: [String.t()]
        }
end
