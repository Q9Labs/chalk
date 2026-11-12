defmodule ChalkSync.Episodes.Reducer.Events do
  @moduledoc """
  How each Episode event changes the control state. One clause per event name.
  """

  alias ChalkSync.Episodes.Reducer.Validation

  @admission_policies Validation.admission_policies()
  @max_participants Validation.max_participants()

  defp joined?(state, participant_id), do: Map.has_key?(state.participants, participant_id)

  def apply_payload(%{status: "ended"}, _name, _payload), do: {:error, :episode_ended}

  def apply_payload(state, "episode_started", payload) do
    with :ok <- Validation.exact_keys(payload, ["episode_id"]),
         true <- payload["episode_id"] == state.episode_id,
         true <- state.revision == 0 do
      {:ok, state}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(state, "participant_joined", payload) do
    with :ok <-
           Validation.exact_keys(payload, ["admission_revision", "display_name", "participant_id", "role"]),
         false <- joined?(state, payload["participant_id"]),
         true <- map_size(state.participants) < @max_participants,
         {:ok, admission_request_id} <- matching_admission_request(state, payload) do
      participant = %{
        display_name: payload["display_name"],
        hand_raised: false,
        role: payload["role"],
        admission_revision: payload["admission_revision"]
      }

      next =
        state
        |> put_in([Access.key(:participants), payload["participant_id"]], participant)
        |> remove_admission_request(admission_request_id)

      {:ok, next}
    else
      true -> {:error, :invalid_transition}
      false -> {:error, :capacity_exceeded}
      _ -> {:error, :invalid_payload}
    end
  end

  def apply_payload(state, "participant_left", payload) do
    with :ok <- Validation.exact_keys(payload, ["participant_id", "reason"]),
         {:ok, participant_id} <- participant_id(payload["participant_id"]),
         true <- joined?(state, participant_id) do
      {:ok, %{state | participants: Map.delete(state.participants, participant_id)}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(state, name, payload) when name in ["hand_raised", "hand_lowered"] do
    with {:ok, participant_id, participant} <- event_participant(state, payload),
         target = name == "hand_raised",
         false <- participant.hand_raised == target do
      {:ok, put_in(state.participants[participant_id].hand_raised, target)}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(state, "participant_display_name_changed", payload) do
    with :ok <- Validation.exact_keys(payload, ["display_name", "participant_id"]),
         {:ok, participant} <- participant(state, payload["participant_id"]),
         true <- Validation.valid_display_name?(payload["display_name"]),
         false <- participant.display_name == payload["display_name"] do
      {:ok,
       put_in(state.participants[payload["participant_id"]].display_name, payload["display_name"])}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(state, "admission_policy_changed", payload) do
    with :ok <- Validation.exact_keys(payload, ["policy"]),
         policy when policy in @admission_policies <- payload["policy"],
         false <- policy == state.admission_policy do
      {:ok, %{state | admission_policy: policy}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(state, "role_assigned", payload) do
    with :ok <- Validation.exact_keys(payload, ["participant_id", "role"]),
         participant_id when is_binary(participant_id) <- payload["participant_id"],
         role when is_binary(role) <- payload["role"],
         true <- Validation.valid_role?(role),
         {:ok, participant} <- participant(state, participant_id),
         true <- Map.has_key?(state.role_capabilities, role),
         false <- role == participant.role do
      {:ok, put_in(state.participants[participant_id].role, role)}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(state, "deadline_changed", payload) do
    with :ok <- Validation.exact_keys(payload, ["deadline_at_ms", "deadline_generation"]),
         deadline_at_ms when is_integer(deadline_at_ms) and deadline_at_ms > 0 <-
           payload["deadline_at_ms"],
         deadline_generation when deadline_generation == state.deadline_generation + 1 <-
           payload["deadline_generation"] do
      {:ok, %{state | deadline_at_ms: deadline_at_ms, deadline_generation: deadline_generation}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(state, "admission_requested", payload) do
    with {:ok, request} <- Validation.decode_admission_request(payload),
         false <- Map.has_key?(state.admission_requests, request["admission_request_id"]),
         false <-
           Enum.any?(state.admission_requests, fn {_id, existing} ->
             existing["participant_id"] == request["participant_id"]
           end),
         false <- joined?(state, request["participant_id"]),
         true <- map_size(state.admission_requests) < @max_participants do
      request_id = request["admission_request_id"]

      {:ok,
       %{
         state
         | admission_requests: Map.put(state.admission_requests, request_id, request),
           admission_request_order: state.admission_request_order ++ [request_id]
       }}
    else
      true -> {:error, :invalid_transition}
      _ -> {:error, :invalid_payload}
    end
  end

  def apply_payload(state, name, payload)
       when name in ["admission_denied", "admission_expired"] do
    with :ok <- Validation.exact_keys(payload, ["admission_request_id"]),
         request_id when is_binary(request_id) <- payload["admission_request_id"],
         true <- Map.has_key?(state.admission_requests, request_id) do
      {:ok, remove_admission_request(state, request_id)}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(state, name, payload)
       when name in [
              "participant_microphone_stopped",
              "participant_camera_stopped",
              "participant_screen_share_stopped"
            ] do
    with :ok <- Validation.exact_keys(payload, ["participant_id"]),
         true <- joined?(state, payload["participant_id"]) do
      {:ok, state}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(state, "recording_status_changed", payload) do
    with {:ok, recording} <- Validation.decode_recording(payload),
         :ok <- valid_recording_transition(state.recording, recording) do
      {:ok, %{state | recording: recording}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(state, "episode_ended", payload) do
    with :ok <- Validation.exact_keys(payload, ["reason"]),
         true <-
           payload["reason"] in ["ended_by_participant", "tenant_recovery", "maximum_duration"] do
      {:ok,
       %{
         state
         | status: "ended",
           participants: %{},
           admission_requests: %{},
           admission_request_order: [],
           recording: nil
       }}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  def apply_payload(_state, _name, _payload), do: {:error, :unknown_event}


  defp valid_recording_transition(nil, %{"status" => "starting"}), do: :ok

  defp valid_recording_transition(%{"status" => status}, %{"status" => "starting"})
       when status in ["stopped", "failed"], do: :ok

  defp valid_recording_transition(%{"recording_id" => id, "status" => from}, %{
         "recording_id" => id,
         "status" => to
       }) do
    if {from, to} in [
         {"starting", "recording"},
         {"starting", "failed"},
         {"starting", "stopped"},
         {"recording", "stopping"},
         {"recording", "failed"},
         {"recording", "stopped"},
         {"stopping", "stopped"},
         {"stopping", "failed"}
       ], do: :ok, else: {:error, :invalid_transition}
  end

  defp valid_recording_transition(_current, _next), do: {:error, :invalid_transition}


  defp matching_admission_request(state, payload) do
    matches =
      Enum.filter(state.admission_requests, fn {_id, request} ->
        request["participant_id"] == payload["participant_id"]
      end)

    case matches do
      [] ->
        {:ok, nil}

      [{id, request}] ->
        if request["display_name"] == payload["display_name"] and
             request["role"] == payload["role"],
           do: {:ok, id},
           else: {:error, :invalid_transition}

      _ ->
        {:error, :invalid_state}
    end
  end


  defp remove_admission_request(state, nil), do: state

  defp remove_admission_request(state, request_id),
    do: %{
      state
      | admission_requests: Map.delete(state.admission_requests, request_id),
        admission_request_order: List.delete(state.admission_request_order, request_id)
    }


  defp participant_id(value) when is_binary(value) and byte_size(value) > 0, do: {:ok, value}
  defp participant_id(_value), do: {:error, :invalid_payload}


  def participant(state, participant_id) do
    case state.participants do
      %{^participant_id => participant} -> {:ok, participant}
      _ -> {:error, :not_joined}
    end
  end


  defp event_participant(state, payload) do
    with :ok <- Validation.exact_keys(payload, ["participant_id"]),
         {:ok, participant_id} <- participant_id(payload["participant_id"]),
         {:ok, participant} <- participant(state, participant_id) do
      {:ok, participant_id, participant}
    end
  end
end
