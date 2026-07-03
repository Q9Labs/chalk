defmodule ChalkSync.Auth.Claims do
  @moduledoc """
  Verified participant claims — the token-asserted identity primitive.

  The token carries resolved capabilities, never role names; enforcement
  happens server-side against these claims.
  """

  @enforce_keys [:tenant_id, :room_id, :participant_id]
  defstruct [:tenant_id, :room_id, :participant_id, display_name: "Guest", capabilities: []]

  @type t :: %__MODULE__{
          tenant_id: String.t(),
          room_id: String.t(),
          participant_id: String.t(),
          display_name: String.t(),
          capabilities: [String.t()]
        }
end
