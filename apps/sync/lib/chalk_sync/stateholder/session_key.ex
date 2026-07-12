defmodule ChalkSync.Stateholder.SessionKey do
  @moduledoc "Verified durable authority key for one Session occurrence."

  @enforce_keys [:tenant_id, :room_id, :session_id]
  defstruct [:tenant_id, :room_id, :session_id]

  @type t :: %__MODULE__{
          tenant_id: String.t(),
          room_id: String.t(),
          session_id: String.t()
        }

  @spec authority_key(t()) :: {String.t(), String.t()}
  def authority_key(%__MODULE__{} = key),
    do: {String.downcase(key.tenant_id), String.downcase(key.session_id)}
end
