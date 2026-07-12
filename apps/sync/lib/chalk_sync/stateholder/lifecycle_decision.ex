defmodule ChalkSync.Stateholder.LifecycleDecision do
  @moduledoc "Authoritative outcome for one durable lifecycle intent."

  @enforce_keys [:lifecycle_intent_id, :result]
  defstruct [:lifecycle_intent_id, :result, :event_id, :revision, :reason, :event]

  @type t :: %__MODULE__{
          lifecycle_intent_id: String.t(),
          result: :applied | :already_applied | :superseded,
          event_id: String.t() | nil,
          revision: pos_integer() | nil,
          reason: atom() | nil,
          event: map() | nil
        }
end
