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

  # Operations that only change Sync's own database. Everything else calls a provider.
  @local_names [
    :admit_participant,
    :participant_leave,
    :deny_admission,
    :admission_request_expired,
    :tenant_set_deadline,
    :recording_capture_ready,
    :recording_capture_stopped,
    :recording_capture_failed
  ]

  defguard is_local_name(name) when name in @local_names

  @doc false
  def local_names, do: @local_names

  @doc false
  def local?(%__MODULE__{name: name}), do: is_local_name(name)

  @doc false
  def leave_cleanup?(%__MODULE__{name: :remove_participant, payload: payload}),
    do: is_binary(payload["departureOperationId"])

  def leave_cleanup?(_operation), do: false
end
