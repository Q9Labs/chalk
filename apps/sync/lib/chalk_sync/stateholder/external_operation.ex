defmodule ChalkSync.Stateholder.ExternalOperation do
  @moduledoc "Claimable durable external-operation authority record."

  @enforce_keys [
    :external_operation_id,
    :request_key,
    :request_fingerprint,
    :name,
    :payload,
    :status,
    :attempt_count
  ]
  defstruct [
    :external_operation_id,
    :request_key,
    :request_fingerprint,
    :name,
    :payload,
    :status,
    :attempt_count,
    :actor_kind,
    :actor_id,
    :actor_participant_id,
    :actor_generation,
    :target_participant_id,
    :target_participant_generation,
    :parent_external_operation_id,
    :source,
    :recording_id,
    :deadline_generation,
    :journey_id,
    :parent_journey_event_id,
    :producing_trace_id,
    :producing_span_id,
    :producing_traceparent,
    :producing_tracestate,
    :applied_event_id,
    :applied_revision,
    :last_error_code
  ]

  @type t :: %__MODULE__{}
  @doc false
  def leave_cleanup?(%__MODULE__{name: :remove_participant, payload: payload}),
    do: is_binary(payload["departureOperationId"])

  def leave_cleanup?(_operation), do: false
end
