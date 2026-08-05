defmodule ChalkSync.Stateholder.Identity do
  @moduledoc "Verified participant-episode identity used for durable decisions."

  alias ChalkSync.Stateholder.EpisodeKey

  @enforce_keys [:episode, :participant_id, :participant_generation]
  defstruct [
    :episode,
    :participant_id,
    :participant_generation,
    :admission_lifecycle_intent_id,
    :role,
    protocol_version: 1,
    capabilities: []
  ]

  @type t :: %__MODULE__{
          episode: EpisodeKey.t(),
          participant_id: String.t(),
          participant_generation: pos_integer(),
          admission_lifecycle_intent_id: String.t() | nil,
          role: String.t() | nil,
          protocol_version: 1,
          capabilities: [String.t()]
        }
end
