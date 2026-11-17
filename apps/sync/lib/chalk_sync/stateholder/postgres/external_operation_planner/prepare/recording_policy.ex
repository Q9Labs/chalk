defmodule ChalkSync.Stateholder.Postgres.ExternalOperationPlanner.Prepare.RecordingPolicy do
  @moduledoc """
  Checks a recording start or stop against the Episode recording policy and reserves its recording.
  """

  alias ChalkSync.RecordingPlane
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: SQL

  def prepare_recording(
        _connection,
        episode,
        %{name: :start_recording} = operation,
        policy,
        state
      ) do
    recording_id = operation.payload["recordingId"]

    with :ok <- validate_recording_episode(policy),
         :ok <- validate_recording_policy(policy, operation),
         {:ok, recording_reservation} <- derive_recording_reservation(episode, policy) do
      if is_nil(state.recording) or state.recording["status"] in ["stopped", "failed"] do
        {:ok,
         %{
           recording_id: recording_id,
           recording_action: :start,
           recording_reservation: recording_reservation,
           target: nil,
           sources: []
         }}
      else
        {:error, :recording_in_progress}
      end
    end
  end

  def prepare_recording(
        connection,
        episode,
        %{name: :stop_recording} = operation,
        _policy,
        state
      ) do
    recording_id = operation.payload["recordingId"]
    params = Scope.episode(episode) ++ [Scope.uuid(recording_id)]

    case Postgrex.query!(connection, SQL.lock_recording(), params).rows do
      [["recording", _generation, _metadata, _start_id, nil]] ->
        if state.recording == %{
             "recording_id" => recording_id,
             "status" => "recording",
             "failure_code" => nil
           } do
          {:ok, %{recording_id: recording_id, recording_action: :stop, target: nil, sources: []}}
        else
          {:error, :invalid_state}
        end

      _ ->
        {:error, :invalid_target}
    end
  end

  defp validate_recording_policy(%{artifact_policy: artifact_policy}, operation)
       when is_map(artifact_policy) do
    with "episode_config.v2" <- artifact_policy["schema_version"],
         %{"mode" => mode} <- artifact_policy["recording"],
         true <- mode in ["manual", "automatic"] do
      if system_recording_start?(operation.payload) and mode != "automatic",
        do: {:error, :recording_policy_disabled},
        else: :ok
    else
      _ -> {:error, :recording_policy_disabled}
    end
  end

  defp validate_recording_policy(_policy, _operation),
    do: {:error, :recording_policy_disabled}

  defp validate_recording_episode(%{status: "active"}), do: :ok
  defp validate_recording_episode(_policy), do: {:error, :episode_ended}

  defp derive_recording_reservation(episode, %{
         artifact_policy: artifact_policy,
         deadline_at: deadline_at
       })
       when is_map(artifact_policy) do
    with "episode_config.v2" <- artifact_policy["schema_version"],
         %{"mode" => mode} <- artifact_policy["recording"],
         true <- mode in ["manual", "automatic"],
         true <- match?(%DateTime{}, deadline_at) do
      max_duration_seconds = DateTime.diff(deadline_at, DateTime.utc_now(), :second)

      if max_duration_seconds > 0 do
        {:ok,
         %{
           "space_id" => episode.space_id,
           "participant_count" => 10,
           "max_duration_seconds" =>
             min(RecordingPlane.maximum_duration_seconds(), max_duration_seconds),
           "input_bitrate_bps" => 4_000_000,
           "policy_snapshot_version" => artifact_policy["schema_version"]
         }}
      else
        {:error, :recording_policy_disabled}
      end
    else
      _ -> {:error, :recording_policy_disabled}
    end
  end

  defp derive_recording_reservation(_episode, _policy),
    do: {:error, :recording_policy_disabled}

  def system_recording_start?(payload) do
    payload["actorKind"] == "system" and payload["actorId"] == "recording_policy" and
      is_binary(payload["recordingId"])
  end
end
