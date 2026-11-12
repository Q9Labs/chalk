defmodule ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Facts do
  @moduledoc """
  The fact an external operation outcome must prove.
  """

  alias ChalkSync.Episodes.Reducer

  def local_operation_outcome(%{name: name} = external, state)
       when name in [:participant_leave, :remove_participant] do
    reason = if name == :participant_leave, do: "left", else: "removed"

    case Reducer.decide_external(state, :participant_leave, %{
           "participant_id" => external.target_participant_id,
           "reason" => reason
         }) do
      {:change, event, _next_state} ->
        {:ok, String.to_existing_atom(event.name), event.payload}

      {:error, reason} ->
        {:error, reason}
    end
  end

  def local_operation_outcome(external, state) do
    case expected_fact(external, state) do
      {name, payload} -> {:ok, name, payload}
      :invalid -> {:error, :invalid_operation_outcome}
    end
  end


  def expected_external_fact(external, state, name, payload)
       when external.name in [:remove_participant, :participant_leave] do
    reason = if external.name == :remove_participant, do: "removed", else: "left"

    case Reducer.decide_external(state, :participant_leave, %{
           "participant_id" => external.target_participant_id,
           "reason" => reason
         }) do
      {:change, event, next_state} ->
        if name == String.to_existing_atom(event.name) and payload == event.payload,
          do: {:ok, event, next_state},
          else: {:error, :invalid_operation_outcome}

      error ->
        error
    end
  end

  def expected_external_fact(external, state, name, payload) do
    expected = expected_fact(external, state)

    if expected == {name, payload} do
      Reducer.apply_external(state, name, payload)
    else
      {:error, :invalid_operation_outcome}
    end
  end


  defp expected_fact(%{name: :deny_admission} = external, _state),
    do: {:admission_denied, %{"admission_request_id" => external.payload["admissionRequestId"]}}

  defp expected_fact(%{name: :admission_request_expired} = external, _state),
    do: {:admission_expired, %{"admission_request_id" => external.payload["admissionRequestId"]}}

  defp expected_fact(%{name: :mute_participant} = external, _state),
    do: {:participant_microphone_stopped, %{"participant_id" => external.target_participant_id}}

  defp expected_fact(%{name: :stop_participant_camera} = external, _state),
    do: {:participant_camera_stopped, %{"participant_id" => external.target_participant_id}}

  defp expected_fact(%{name: :stop_participant_screen_share} = external, _state),
    do: {:participant_screen_share_stopped, %{"participant_id" => external.target_participant_id}}

  defp expected_fact(%{name: :start_recording}, _state),
    do: :reservation_acknowledged

  defp expected_fact(%{name: :recording_capture_ready} = external, _state) do
    {:recording_status_changed,
     %{
       "recording_id" => external.recording_id,
       "status" => "recording",
       "failure_code" => nil
     }}
  end

  defp expected_fact(%{name: :stop_recording}, _state),
    do: :reservation_acknowledged

  defp expected_fact(%{name: :recording_capture_stopped} = external, _state) do
    {:recording_status_changed,
     %{
       "recording_id" => external.recording_id,
       "status" => "stopped",
       "failure_code" => nil
     }}
  end

  defp expected_fact(%{name: :recording_capture_failed} = external, _state) do
    {:recording_status_changed,
     %{
       "recording_id" => external.recording_id,
       "status" => "failed",
       "failure_code" => external.payload["failureCode"]
     }}
  end

  defp expected_fact(%{name: :end_episode}, _state),
    do: {:episode_ended, %{"reason" => "ended_by_participant"}}

  defp expected_fact(%{name: :tenant_end_episode}, _state),
    do: {:episode_ended, %{"reason" => "tenant_recovery"}}

  defp expected_fact(%{name: :maximum_duration_expired}, _state),
    do: {:episode_ended, %{"reason" => "maximum_duration"}}

  defp expected_fact(%{name: :tenant_set_deadline} = external, _state),
    do:
      {:deadline_changed,
       %{
         "deadline_at_ms" => external.payload["deadlineAtMs"],
         "deadline_generation" => external.deadline_generation
       }}

  defp expected_fact(_external, _state), do: :invalid
end
