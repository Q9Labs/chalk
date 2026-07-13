defmodule ChalkSync.Stateholder.Decision do
  @moduledoc "Authoritative terminal command result read from a durable receipt."

  @enforce_keys [:command_id, :result]
  defstruct [
    :command_id,
    :result,
    :delivery,
    :event_id,
    :external_operation_id,
    :revision,
    :state_digest,
    :reason,
    :event
  ]

  @type result ::
          :pending | :committed | :satisfied | :duplicate | :rejected | :command_id_conflict
  @type t :: %__MODULE__{
          command_id: String.t(),
          result: result(),
          delivery: :original | :duplicate | nil,
          event_id: String.t() | nil,
          external_operation_id: String.t() | nil,
          revision: non_neg_integer() | nil,
          state_digest: binary() | nil,
          reason: atom() | nil,
          event: map() | nil
        }
end
