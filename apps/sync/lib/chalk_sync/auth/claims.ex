defmodule ChalkSync.Auth.Claims do
  @moduledoc """
  Verified participant claims — the token-asserted identity primitive.

  The token carries resolved capabilities, never role names; enforcement
  happens server-side against these claims.
  """

  @enforce_keys [:tenant_id, :room_id]
  defstruct [
    :tenant_id,
    :room_id,
    :participant_id,
    :session_id,
    :participant_session_id,
    :participant_session_generation,
    :admission_lifecycle_intent_id,
    :issued_at,
    :expires_at,
    display_name: "Guest",
    capabilities: []
  ]

  @type t :: %__MODULE__{
          tenant_id: String.t(),
          room_id: String.t(),
          participant_id: String.t() | nil,
          session_id: String.t() | nil,
          participant_session_id: String.t() | nil,
          participant_session_generation: pos_integer() | nil,
          admission_lifecycle_intent_id: String.t() | nil,
          issued_at: integer() | nil,
          expires_at: integer() | nil,
          display_name: String.t(),
          capabilities: [String.t()]
        }
end
