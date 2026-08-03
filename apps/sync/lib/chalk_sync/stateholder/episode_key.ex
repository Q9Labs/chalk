defmodule ChalkSync.Stateholder.EpisodeKey do
  @moduledoc "Verified durable authority key for one Episode occurrence."

  @enforce_keys [:tenant_id, :space_id, :episode_id]
  defstruct [:tenant_id, :space_id, :episode_id]

  @type t :: %__MODULE__{
          tenant_id: String.t(),
          space_id: String.t(),
          episode_id: String.t()
        }

  @spec authority_key(t()) :: {String.t(), String.t()}
  def authority_key(%__MODULE__{} = key),
    do: {String.downcase(key.tenant_id), String.downcase(key.episode_id)}
end
