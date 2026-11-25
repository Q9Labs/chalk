defmodule ChalkSync.Episodes.Reducer.Validation do
  @moduledoc """
  Shape checks for Episode state: names, roles, capabilities and the exact keys of a snapshot.
  """

  @admission_policies ["open", "knock", "members_only"]
  @capabilities ~w(
    publishAudio publishVideo publishScreen subscribe raiseHand renameSelf sendChat
    sendReaction drawWhiteboard manageWhiteboard manageAdmission assignRoles muteOthers
    stopVideoOthers stopScreenOthers requestMediaOthers removeParticipant manageRecording
    startEpisode extendEpisode endEpisode manageMembers clearSpaceContent
  )
  @max_capabilities 23
  @max_display_name_bytes 256
  @max_participants 500
  @max_role_bytes 64
  @max_roles 16

  def max_participants, do: @max_participants
  def admission_policies, do: @admission_policies
  def capabilities, do: @capabilities

  def valid_state?(state) do
    with true <- state.status in ["active", "ended"],
         true <- state.admission_policy in @admission_policies,
         true <- is_integer(state.deadline_at_ms) and state.deadline_at_ms > 0,
         true <- is_integer(state.deadline_generation) and state.deadline_generation > 0,
         true <- map_size(state.participants) <= @max_participants,
         true <- map_size(state.admission_requests) <= @max_participants,
         {:ok, _} <- decode_role_capabilities(state.role_capabilities),
         true <- Enum.all?(state.participants, &valid_participant?/1),
         true <- Enum.all?(state.admission_requests, &valid_admission_request_entry?/1),
         {:ok, _} <- decode_recording(state.recording),
         true <-
           state.status == "active" or
             (map_size(state.participants) == 0 and map_size(state.admission_requests) == 0 and
                is_nil(state.recording)) do
      :ok
    else
      _ -> {:error, :invalid_state}
    end
  end

  defp valid_participant?({_id, participant}) do
    valid_display_name?(participant.display_name) and is_boolean(participant.hand_raised) and
      valid_role?(participant.role) and
      is_integer(participant.admission_revision) and
      participant.admission_revision > 0
  end

  defp valid_admission_request_entry?({id, request}) do
    case decode_admission_request(request) do
      {:ok, decoded} -> decoded["admission_request_id"] == id
      _ -> false
    end
  end

  def decode_participants(participants, role_capabilities) do
    Enum.reduce_while(participants, {:ok, %{}}, fn encoded, {:ok, result} ->
      with true <- is_map(encoded),
           :ok <- exact_keys(encoded, participant_keys()),
           participant_id when is_binary(participant_id) <- encoded["participant_id"],
           display_name when is_binary(display_name) <- encoded["display_name"],
           true <- valid_display_name?(display_name),
           hand_raised when is_boolean(hand_raised) <- encoded["hand_raised"],
           role when is_binary(role) <- encoded["role"],
           true <- valid_role?(role),
           true <- Map.has_key?(role_capabilities, role),
           true <- valid_capabilities?(encoded["capabilities"]),
           true <- encoded["capabilities"] == Map.get(role_capabilities, role),
           admission_revision when is_integer(admission_revision) and admission_revision > 0 <-
             encoded["admission_revision"],
           false <- Map.has_key?(result, participant_id) do
        participant = %{
          display_name: display_name,
          hand_raised: hand_raised,
          role: role,
          admission_revision: admission_revision
        }

        {:cont, {:ok, Map.put(result, participant_id, participant)}}
      else
        _ -> {:halt, {:error, :invalid_snapshot}}
      end
    end)
  end

  def decode_role_capabilities(mapping) when is_map(mapping) do
    if map_size(mapping) <= @max_roles and
         Enum.all?(mapping, fn {role, values} ->
           valid_role?(to_string(role)) and valid_capabilities?(values)
         end),
       do: {:ok, Map.new(mapping, fn {role, values} -> {to_string(role), values} end)},
       else: {:error, :invalid_snapshot}
  end

  def decode_role_capabilities(_mapping), do: {:error, :invalid_snapshot}

  def decode_admission_requests(requests)
      when is_list(requests) and length(requests) <= @max_participants do
    Enum.reduce_while(requests, {:ok, %{}}, fn encoded, {:ok, result} ->
      with {:ok, request} <- decode_admission_request(encoded),
           id = request["admission_request_id"],
           false <- Map.has_key?(result, id),
           false <- duplicate_participant_id?(result, request["participant_id"]) do
        {:cont, {:ok, Map.put(result, id, request)}}
      else
        _ -> {:halt, {:error, :invalid_snapshot}}
      end
    end)
  end

  def decode_admission_requests(_requests), do: {:error, :invalid_snapshot}

  defp duplicate_participant_id?(requests, participant_id) do
    Enum.any?(requests, fn {_existing_id, value} -> value["participant_id"] == participant_id end)
  end

  def decode_admission_request(request) when is_map(request) do
    with :ok <- exact_keys(request, admission_request_keys()),
         id when is_binary(id) <- request["admission_request_id"],
         participant_id when is_binary(participant_id) <- request["participant_id"],
         display_name when is_binary(display_name) <- request["display_name"],
         true <- valid_display_name?(display_name),
         role when is_binary(role) <- request["role"],
         true <- valid_role?(role),
         expires_at_ms when is_integer(expires_at_ms) and expires_at_ms > 0 <-
           request["expires_at_ms"] do
      {:ok, request}
    else
      _ -> {:error, :invalid_admission_request}
    end
  end

  def decode_admission_request(_request), do: {:error, :invalid_admission_request}

  def decode_recording(nil), do: {:ok, nil}

  def decode_recording(recording) when is_map(recording) do
    with :ok <- exact_keys(recording, ["failure_code", "recording_id", "status"]),
         recording_id when is_binary(recording_id) <- recording["recording_id"],
         status when status in ["starting", "recording", "stopping", "stopped", "failed"] <-
           recording["status"],
         true <- valid_failure_code?(status, recording["failure_code"]) do
      {:ok, recording}
    else
      _ -> {:error, :invalid_recording}
    end
  end

  def decode_recording(_recording), do: {:error, :invalid_recording}

  defp valid_failure_code?("failed", code), do: is_binary(code) and byte_size(code) in 1..96
  defp valid_failure_code?(_status, nil), do: true
  defp valid_failure_code?(_status, _code), do: false

  def valid_display_name?(display_name),
    do:
      String.valid?(display_name) and display_name == String.trim(display_name) and
        byte_size(display_name) in 1..@max_display_name_bytes

  def valid_role?(role),
    do:
      is_binary(role) and String.valid?(role) and role == String.trim(role) and
        byte_size(role) in 1..@max_role_bytes

  defp valid_capabilities?(values) when is_list(values),
    do:
      length(values) <= @max_capabilities and Enum.uniq(values) == values and
        Enum.all?(values, &(&1 in @capabilities))

  defp valid_capabilities?(_values), do: false

  def exact_keys(map, keys),
    do:
      if(map |> Map.keys() |> Enum.sort() == Enum.sort(keys),
        do: :ok,
        else: {:error, :invalid_payload}
      )

  def stringify_keys(map),
    do:
      Map.new(map, fn
        {key, value} when is_atom(key) -> {Atom.to_string(key), value}
        pair -> pair
      end)

  def snapshot_keys,
    do: [
      "admission_policy",
      "admission_requests",
      "control_revision",
      "deadline_at_ms",
      "deadline_generation",
      "participants",
      "recording",
      "role_capabilities",
      "state_schema_version",
      "status"
    ]

  defp participant_keys,
    do: [
      "admission_revision",
      "capabilities",
      "display_name",
      "hand_raised",
      "participant_id",
      "role"
    ]

  defp admission_request_keys,
    do: [
      "admission_request_id",
      "display_name",
      "expires_at_ms",
      "participant_id",
      "role"
    ]
end
