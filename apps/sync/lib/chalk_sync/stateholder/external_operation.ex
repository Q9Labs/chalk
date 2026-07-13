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
    :actor_participant_session_id,
    :actor_generation,
    :target_participant_session_id,
    :target_participant_generation,
    :parent_external_operation_id,
    :source,
    :recording_id,
    :deadline_generation,
    :journey_id,
    :parent_journey_event_id,
    :producing_trace_id,
    :producing_span_id,
    :applied_event_id,
    :applied_revision,
    :last_error_code
  ]

  @type t :: %__MODULE__{}
end
