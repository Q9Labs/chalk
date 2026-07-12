defmodule ChalkSync.Stateholder.Decision do
  @moduledoc "Authoritative terminal command result read from a durable receipt."

  @enforce_keys [:command_id, :result]
  defstruct [:command_id, :result, :event_id, :revision, :reason, :event]

  @type result :: :committed | :duplicate | :rejected | :command_id_conflict
  @type t :: %__MODULE__{
          command_id: String.t(),
          result: result(),
          event_id: String.t() | nil,
          revision: pos_integer() | nil,
          reason: atom() | nil,
          event: map() | nil
        }
end
