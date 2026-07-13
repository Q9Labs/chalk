defmodule ChalkSync.Stateholder.OperationDecision do
  @moduledoc "Authoritative websocket receipt state for an external operation."

  @enforce_keys [:request_key, :result]
  defstruct [
    :request_key,
    :result,
    :delivery,
    :external_operation_id,
    :event_id,
    :revision,
    :state_digest,
    :reason
  ]

  @type t :: %__MODULE__{}
end
