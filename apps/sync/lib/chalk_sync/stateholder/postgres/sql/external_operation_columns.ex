defmodule ChalkSync.Stateholder.Postgres.SQL.ExternalOperationColumns do
  @moduledoc false

  def columns(prefix \\ nil) do
    columns = [
      "tenant_id",
      "space_id",
      "episode_id",
      "external_operation_id",
      "parent_external_operation_id",
      "request_key",
      "request_fingerprint",
      "operation_name",
      "actor_participant_id",
      "actor_generation",
      "target_participant_id",
      "target_participant_generation",
      "source",
      "recording_id",
      "deadline_generation",
      "journey_id",
      "parent_journey_event_id",
      "producing_trace_id",
      "producing_span_id",
      "producing_traceparent",
      "producing_tracestate",
      "payload",
      "status",
      "attempt_count",
      "applied_event_id",
      "applied_revision",
      "last_error_code"
    ]

    Enum.map_join(columns, ", ", fn column ->
      if prefix, do: "#{prefix}.#{column}", else: column
    end)
  end
end
