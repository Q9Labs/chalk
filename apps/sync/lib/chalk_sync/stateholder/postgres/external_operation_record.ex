defmodule ChalkSync.Stateholder.Postgres.ExternalOperationRecord do
  @moduledoc false

  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.UUID

  def from_row([
        _tenant_id,
        _space_id,
        _episode_id,
        operation_id,
        parent_operation_id,
        request_key,
        fingerprint,
        name,
        actor_id,
        actor_generation,
        target_id,
        target_generation,
        source,
        recording_id,
        deadline_generation,
        journey_id,
        parent_journey_event_id,
        producing_trace_id,
        producing_span_id,
        producing_traceparent,
        producing_tracestate,
        payload,
        status,
        attempt_count,
        applied_event_id,
        applied_revision,
        last_error_code
      ]) do
    %ExternalOperation{
      external_operation_id: UUID.load!(operation_id),
      parent_external_operation_id: Scope.nullable_uuid(parent_operation_id),
      request_key: request_key,
      request_fingerprint: fingerprint,
      name: external_operation_name(name),
      payload: payload,
      status: String.to_existing_atom(status),
      attempt_count: attempt_count,
      actor_participant_id: Scope.nullable_uuid(actor_id),
      actor_generation: actor_generation,
      target_participant_id: Scope.nullable_uuid(target_id),
      target_participant_generation: target_generation,
      source: source && String.to_existing_atom(source),
      recording_id: Scope.nullable_uuid(recording_id),
      deadline_generation: deadline_generation,
      journey_id: Scope.nullable_uuid(journey_id),
      parent_journey_event_id: Scope.nullable_uuid(parent_journey_event_id),
      producing_trace_id: producing_trace_id,
      producing_span_id: producing_span_id,
      producing_traceparent: producing_traceparent,
      producing_tracestate: producing_tracestate,
      applied_event_id: Scope.nullable_uuid(applied_event_id),
      applied_revision: applied_revision,
      last_error_code: failure_reason(last_error_code)
    }
  end

  defp external_operation_name("maximum_episode_duration_expired"), do: :maximum_duration_expired
  defp external_operation_name(name), do: String.to_existing_atom(name)

  defp failure_reason(nil), do: nil

  defp failure_reason(value) do
    String.to_existing_atom(value)
  rescue
    ArgumentError -> :external_operation_failed
  end
end
