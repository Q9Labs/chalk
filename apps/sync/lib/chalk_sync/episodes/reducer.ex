defmodule ChalkSync.Episodes.Reducer do
  @moduledoc "Pure state machine for one durable Episode control stream."

  alias ChalkSync.CanonicalJSON

  @state_schema_version 1
  @digest_prefix "chalk-sync-state-v1"
  @max_display_name_bytes 256
  @max_participants 500
  @max_role_bytes 64
  @max_roles 16
  @max_capabilities 23
  @admission_policies ["open", "knock", "members_only"]
  @capabilities ~w(
    publishAudio publishVideo publishScreen subscribe raiseHand renameSelf sendChat
    sendReaction drawWhiteboard manageWhiteboard manageAdmission assignRoles muteOthers
    stopVideoOthers stopScreenOthers requestMediaOthers removeParticipant manageRecording
    startEpisode extendEpisode endEpisode manageMembers clearSpaceContent
  )

  @default_role_capabilities %{
    "owner" => @capabilities,
    "collaborator" => ~w(
        publishAudio publishVideo publishScreen subscribe raiseHand renameSelf sendChat
        sendReaction drawWhiteboard
      ),
    "observer" => ~w(subscribe sendReaction)
  }

  @enforce_keys [:episode_id]
  defstruct episode_id: nil,
            revision: 0,
            status: "active",
            admission_policy: "open",
            deadline_at_ms: 1,
            deadline_generation: 1,
            role_capabilities: @default_role_capabilities,
            recording: nil,
            admission_requests: %{},
            participants: %{}

  @type participant :: %{
          display_name: String.t(),
          hand_raised: boolean(),
          role: String.t(),
          admission_revision: pos_integer()
        }
  @type event :: %{
          name: String.t(),
          base_revision: non_neg_integer(),
          revision: pos_integer(),
          payload: map()
        }
  @type t :: %__MODULE__{}

  def state_schema_version, do: @state_schema_version

  @spec new(String.t(), map()) :: t()
  def new(episode_id, policy \\ %{}) when is_binary(episode_id) and is_map(policy) do
    snapshot = Map.get(policy, :config_snapshot, Map.get(policy, "config_snapshot", %{}))
    snapshot = if is_map(snapshot), do: snapshot, else: %{}

    admission_policy =
      policy
      |> value(snapshot, :admission_policy, "open")
      |> normalize_admission_policy()

    role_capabilities =
      policy
      |> value(
        snapshot,
        :role_capabilities,
        Map.get(snapshot, "roles", @default_role_capabilities)
      )
      |> normalize_role_capabilities()

    %__MODULE__{
      episode_id: episode_id,
      admission_policy: admission_policy,
      role_capabilities: role_capabilities,
      deadline_at_ms: value(policy, snapshot, :deadline_at_ms, 1),
      deadline_generation: value(policy, snapshot, :deadline_generation, 1),
      recording: value(policy, snapshot, :recording, nil),
      admission_requests: value(policy, snapshot, :admission_requests, %{})
    }
  end

  defp value(policy, snapshot, key, default) do
    Map.get(
      policy,
      key,
      Map.get(
        policy,
        Atom.to_string(key),
        Map.get(snapshot, key, Map.get(snapshot, Atom.to_string(key), default))
      )
    )
  end

  defp normalize_admission_policy(%{"mode" => mode}), do: normalize_admission_policy(mode)
  defp normalize_admission_policy(%{mode: mode}), do: normalize_admission_policy(mode)
  defp normalize_admission_policy(policy) when policy in @admission_policies, do: policy
  defp normalize_admission_policy(_policy), do: "open"

  defp normalize_role_capabilities(mapping) when is_map(mapping) do
    mapping
    |> Map.new(fn {role, capabilities} ->
      {to_string(role), if(is_list(capabilities), do: capabilities, else: [])}
    end)
    |> case do
      mapping when map_size(mapping) > 0 -> mapping
      _ -> @default_role_capabilities
    end
  end

  defp normalize_role_capabilities(_mapping), do: @default_role_capabilities

  @spec decide_command(t(), String.t(), atom(), map()) ::
          {:change, event(), t()} | {:satisfied, t()} | {:error, atom()}
  def decide_command(%__MODULE__{status: "ended"}, _actor_id, _name, _payload),
    do: {:error, :episode_ended}

  def decide_command(%__MODULE__{} = state, actor_id, name, payload)
      when is_binary(actor_id) and is_atom(name) and is_map(payload) do
    case command_target(state, actor_id, name, payload) do
      {:ok, event_name, event_payload} -> advance_command(state, event_name, event_payload)
      {:error, :satisfied} -> {:satisfied, state}
      error -> error
    end
  end

  def decide_command(%__MODULE__{}, _actor_id, _name, _payload), do: {:error, :invalid_command}

  @spec apply_lifecycle(t(), atom(), map()) :: {:ok, event(), t()} | {:error, atom()}
  def apply_lifecycle(%__MODULE__{} = state, :participant_joined, payload)
      when is_map(payload) do
    with {:ok, normalized} <- normalize_join(state, payload) do
      advance(state, "participant_joined", normalized)
    end
  end

  def apply_lifecycle(%__MODULE__{} = state, :episode_started, payload)
      when is_map(payload) do
    with :ok <- exact_keys(payload, ["episode_id"]),
         true <- payload["episode_id"] == state.episode_id do
      advance(state, "episode_started", payload)
    else
      _ -> {:error, :invalid_lifecycle_intent}
    end
  end

  def apply_lifecycle(%__MODULE__{} = state, :admission_requested, payload)
      when is_map(payload) do
    advance(state, "admission_requested", stringify_keys(payload))
  end

  def apply_lifecycle(%__MODULE__{}, _name, _payload), do: {:error, :invalid_lifecycle_intent}

  @external_events ~w(
    participant_left episode_ended deadline_changed admission_denied admission_expired
    participant_microphone_stopped participant_camera_stopped participant_screen_share_stopped
    recording_status_changed
  )

  def apply_external(%__MODULE__{} = state, name, payload)
      when is_atom(name) and is_map(payload),
      do: apply_external(state, Atom.to_string(name), payload)

  def apply_external(%__MODULE__{} = state, name, payload)
      when name in @external_events and is_map(payload),
      do: advance(state, name, payload)

  def apply_external(%__MODULE__{}, _name, _payload), do: {:error, :invalid_external_operation}

  def decide_external(%__MODULE__{} = state, :participant_leave, payload) when is_map(payload) do
    with {:ok, participant_id, reason} <- participant_leave(payload),
         {:ok, event, next} <-
           advance(state, "participant_left", %{
             "participant_id" => participant_id,
             "reason" => reason
           }) do
      {:change, event, next}
    end
  end

  def decide_external(%__MODULE__{}, _name, _payload), do: {:error, :invalid_external_operation}

  @spec apply_event(t(), event() | map()) :: {:ok, t()} | {:error, atom()}
  def apply_event(%__MODULE__{} = state, event) when is_map(event) do
    with {:ok, name, base_revision, revision, payload} <- event_fields(event),
         :ok <- validate_revision(state.revision, base_revision, revision),
         {:ok, next} <- apply_payload(state, name, payload),
         :ok <- valid_state?(%{next | revision: revision}) do
      {:ok, %{next | revision: revision}}
    end
  end

  def apply_event(%__MODULE__{}, _event), do: {:error, :invalid_event}

  @spec from_snapshot(String.t(), map()) :: {:ok, t()} | {:error, atom()}
  def from_snapshot(episode_id, snapshot) when is_binary(episode_id) and is_map(snapshot) do
    with :ok <- exact_keys(snapshot, snapshot_keys()),
         revision when is_integer(revision) and revision >= 0 <- snapshot["control_revision"],
         @state_schema_version <- snapshot["state_schema_version"],
         status when status in ["active", "ended"] <- snapshot["status"],
         admission_policy when admission_policy in @admission_policies <-
           snapshot["admission_policy"],
         {:ok, role_capabilities} <- decode_role_capabilities(snapshot["role_capabilities"]),
         deadline_at_ms when is_integer(deadline_at_ms) and deadline_at_ms >= 1 <-
           snapshot["deadline_at_ms"],
         deadline_generation when is_integer(deadline_generation) and deadline_generation >= 1 <-
           snapshot["deadline_generation"],
         {:ok, recording} <- decode_recording(snapshot["recording"]),
         {:ok, admission_requests} <- decode_admission_requests(snapshot["admission_requests"]),
         participants when is_list(participants) and length(participants) <= @max_participants <-
           snapshot["participants"],
         {:ok, participant_map} <- decode_participants(participants, role_capabilities) do
      state = %__MODULE__{
        episode_id: episode_id,
        revision: revision,
        status: status,
        admission_policy: admission_policy,
        deadline_at_ms: deadline_at_ms,
        deadline_generation: deadline_generation,
        role_capabilities: role_capabilities,
        recording: recording,
        admission_requests: admission_requests,
        participants: participant_map
      }

      if valid_state?(state) == :ok, do: {:ok, state}, else: {:error, :invalid_snapshot}
    else
      _ -> {:error, :invalid_snapshot}
    end
  end

  def from_snapshot(_episode_id, _snapshot), do: {:error, :invalid_snapshot}

  def snapshot(%__MODULE__{} = state) do
    participants =
      state.participants
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(fn {participant_id, participant} ->
        %{
          "participant_id" => participant_id,
          "display_name" => participant.display_name,
          "hand_raised" => participant.hand_raised,
          "role" => participant.role,
          "capabilities" => Map.get(state.role_capabilities, participant.role, []),
          "admission_revision" => participant.admission_revision
        }
      end)

    %{
      "control_revision" => state.revision,
      "state_schema_version" => @state_schema_version,
      "status" => state.status,
      "admission_policy" => state.admission_policy,
      "deadline_at_ms" => state.deadline_at_ms,
      "deadline_generation" => state.deadline_generation,
      "role_capabilities" => state.role_capabilities,
      "recording" => state.recording,
      "admission_requests" =>
        state.admission_requests
        |> Map.values()
        |> Enum.sort_by(& &1["admission_request_id"]),
      "participants" => participants
    }
  end

  def snapshot(%__MODULE__{} = state, _protocol_version), do: snapshot(state)

  def digest(%__MODULE__{} = state) do
    canonical = state |> snapshot() |> CanonicalJSON.encode!()
    :crypto.hash(:sha256, [@digest_prefix, <<@state_schema_version::unsigned-big-32>>, canonical])
  end

  def wire_snapshot(%__MODULE__{} = state),
    do: Map.put(snapshot(state), "state_digest", Base.encode16(digest(state), case: :lower))

  def snapshot_bytes(%__MODULE__{} = state),
    do: state |> wire_snapshot() |> JSON.encode!() |> byte_size()

  def joined?(%__MODULE__{} = state, participant_id),
    do: Map.has_key?(state.participants, participant_id)

  defp advance_command(state, event_name, payload) do
    case advance(state, event_name, payload) do
      {:ok, event, next} -> {:change, event, next}
      error -> error
    end
  end

  defp advance(state, name, payload) do
    event = %{
      name: name,
      base_revision: state.revision,
      revision: state.revision + 1,
      payload: stringify_keys(payload)
    }

    case apply_event(state, event) do
      {:ok, next} -> {:ok, event, next}
      error -> error
    end
  end

  defp command_target(state, actor_id, :set_hand_raised, payload) do
    with :ok <- exact_keys(payload, ["raised"]),
         raised when is_boolean(raised) <- payload["raised"],
         {:ok, participant} <- participant(state, actor_id) do
      if participant.hand_raised == raised,
        do: {:error, :satisfied},
        else: {:ok, hand_event_name(raised), %{"participant_id" => actor_id}}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_target}
    end
  end

  defp command_target(state, actor_id, :set_display_name, payload) do
    with :ok <- exact_keys(payload, ["displayName"]),
         display_name when is_binary(display_name) <- payload["displayName"],
         true <- valid_display_name?(display_name),
         {:ok, participant} <- participant(state, actor_id) do
      if participant.display_name == display_name,
        do: {:error, :satisfied},
        else:
          {:ok, "participant_display_name_changed",
           %{"participant_id" => actor_id, "display_name" => display_name}}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_target}
    end
  end

  defp command_target(state, _actor_id, :set_admission_policy, payload) do
    with :ok <- exact_keys(payload, ["policy"]),
         policy when policy in @admission_policies <- payload["policy"] do
      if state.admission_policy == policy,
        do: {:error, :satisfied},
        else: {:ok, "admission_policy_changed", %{"policy" => policy}}
    else
      _ -> {:error, :invalid_target}
    end
  end

  defp command_target(state, _actor_id, :assign_roles, payload) do
    with :ok <- exact_keys(payload, ["participantId", "role"]),
         participant_id when is_binary(participant_id) <- payload["participantId"],
         role when is_binary(role) <- payload["role"],
         true <- valid_role?(role),
         {:ok, participant} <- participant(state, participant_id),
         true <- Map.has_key?(state.role_capabilities, role) do
      if participant.role == role,
        do: {:error, :satisfied},
        else: {:ok, "role_assigned", %{"participant_id" => participant_id, "role" => role}}
    else
      {:error, :not_joined} -> {:error, :invalid_target}
      _ -> {:error, :invalid_target}
    end
  end

  defp command_target(_state, _actor_id, _name, _payload), do: {:error, :unknown_command}

  defp hand_event_name(true), do: "hand_raised"
  defp hand_event_name(false), do: "hand_lowered"

  defp normalize_join(state, payload) do
    allowed = ["participant_id", "display_name", "role", "admission_revision"]

    with true <- Enum.all?(Map.keys(payload), &(&1 in allowed)),
         participant_id when is_binary(participant_id) <- payload["participant_id"],
         display_name when is_binary(display_name) <- payload["display_name"],
         true <- valid_display_name?(display_name) do
      first? = map_size(state.participants) == 0
      role = Map.get(payload, "role", if(first?, do: "owner", else: "observer"))

      admission_revision = Map.get(payload, "admission_revision", state.revision + 1)

      if valid_role?(role) and
           Map.has_key?(state.role_capabilities, role) and is_integer(admission_revision) and
           admission_revision >= 1 do
        {:ok,
         %{
           "participant_id" => participant_id,
           "display_name" => display_name,
           "role" => role,
           "admission_revision" => admission_revision
         }}
      else
        {:error, :invalid_payload}
      end
    else
      _ -> {:error, :invalid_payload}
    end
  end

  defp participant_leave(payload) do
    with true <- Enum.all?(Map.keys(payload), &(&1 in ["participant_id", "reason"])),
         participant_id when is_binary(participant_id) <- payload["participant_id"],
         reason = Map.get(payload, "reason", "left"),
         true <- reason in ["left", "removed"] do
      {:ok, participant_id, reason}
    else
      _ -> {:error, :invalid_payload}
    end
  end

  defp apply_payload(%{status: "ended"}, _name, _payload), do: {:error, :episode_ended}

  defp apply_payload(state, "episode_started", payload) do
    with :ok <- exact_keys(payload, ["episode_id"]),
         true <- payload["episode_id"] == state.episode_id,
         true <- state.revision == 0 do
      {:ok, state}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "participant_joined", payload) do
    with :ok <-
           exact_keys(payload, ["admission_revision", "display_name", "participant_id", "role"]),
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

  defp apply_payload(state, "participant_left", payload) do
    with :ok <- exact_keys(payload, ["participant_id", "reason"]),
         {:ok, participant_id} <- participant_id(payload["participant_id"]),
         true <- joined?(state, participant_id) do
      {:ok, %{state | participants: Map.delete(state.participants, participant_id)}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, name, payload) when name in ["hand_raised", "hand_lowered"] do
    with {:ok, participant_id, participant} <- event_participant(state, payload),
         target = name == "hand_raised",
         false <- participant.hand_raised == target do
      {:ok, put_in(state.participants[participant_id].hand_raised, target)}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "participant_display_name_changed", payload) do
    with :ok <- exact_keys(payload, ["display_name", "participant_id"]),
         {:ok, participant} <- participant(state, payload["participant_id"]),
         true <- valid_display_name?(payload["display_name"]),
         false <- participant.display_name == payload["display_name"] do
      {:ok,
       put_in(state.participants[payload["participant_id"]].display_name, payload["display_name"])}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "admission_policy_changed", payload) do
    with :ok <- exact_keys(payload, ["policy"]),
         policy when policy in @admission_policies <- payload["policy"],
         false <- policy == state.admission_policy do
      {:ok, %{state | admission_policy: policy}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "role_assigned", payload) do
    with :ok <- exact_keys(payload, ["participant_id", "role"]),
         participant_id when is_binary(participant_id) <- payload["participant_id"],
         role when is_binary(role) <- payload["role"],
         true <- valid_role?(role),
         {:ok, participant} <- participant(state, participant_id),
         true <- Map.has_key?(state.role_capabilities, role),
         false <- role == participant.role do
      {:ok, put_in(state.participants[participant_id].role, role)}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "deadline_changed", payload) do
    with :ok <- exact_keys(payload, ["deadline_at_ms", "deadline_generation"]),
         deadline_at_ms when is_integer(deadline_at_ms) and deadline_at_ms > 0 <-
           payload["deadline_at_ms"],
         deadline_generation when deadline_generation == state.deadline_generation + 1 <-
           payload["deadline_generation"] do
      {:ok, %{state | deadline_at_ms: deadline_at_ms, deadline_generation: deadline_generation}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "admission_requested", payload) do
    with {:ok, request} <- decode_admission_request(payload),
         false <- Map.has_key?(state.admission_requests, request["admission_request_id"]),
         false <-
           Enum.any?(state.admission_requests, fn {_id, existing} ->
             existing["participant_id"] == request["participant_id"]
           end),
         false <- joined?(state, request["participant_id"]),
         true <- map_size(state.admission_requests) < @max_participants do
      {:ok, put_in(state.admission_requests[request["admission_request_id"]], request)}
    else
      true -> {:error, :invalid_transition}
      _ -> {:error, :invalid_payload}
    end
  end

  defp apply_payload(state, name, payload)
       when name in ["admission_denied", "admission_expired"] do
    with :ok <- exact_keys(payload, ["admission_request_id"]),
         request_id when is_binary(request_id) <- payload["admission_request_id"],
         true <- Map.has_key?(state.admission_requests, request_id) do
      {:ok, %{state | admission_requests: Map.delete(state.admission_requests, request_id)}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, name, payload)
       when name in [
              "participant_microphone_stopped",
              "participant_camera_stopped",
              "participant_screen_share_stopped"
            ] do
    with :ok <- exact_keys(payload, ["participant_id"]),
         true <- joined?(state, payload["participant_id"]) do
      {:ok, state}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "recording_status_changed", payload) do
    with {:ok, recording} <- decode_recording(payload),
         :ok <- valid_recording_transition(state.recording, recording) do
      {:ok, %{state | recording: recording}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "episode_ended", payload) do
    with :ok <- exact_keys(payload, ["reason"]),
         true <-
           payload["reason"] in ["ended_by_participant", "tenant_recovery", "maximum_duration"] do
      {:ok,
       %{state | status: "ended", participants: %{}, admission_requests: %{}, recording: nil}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(_state, _name, _payload), do: {:error, :unknown_event}

  defp valid_state?(state) do
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

  defp decode_participants(participants, role_capabilities) do
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

  defp decode_role_capabilities(mapping) when is_map(mapping) do
    if map_size(mapping) <= @max_roles and
         Enum.all?(mapping, fn {role, values} ->
           valid_role?(to_string(role)) and valid_capabilities?(values)
         end),
       do: {:ok, Map.new(mapping, fn {role, values} -> {to_string(role), values} end)},
       else: {:error, :invalid_snapshot}
  end

  defp decode_role_capabilities(_mapping), do: {:error, :invalid_snapshot}

  defp decode_admission_requests(requests)
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

  defp decode_admission_requests(_requests), do: {:error, :invalid_snapshot}

  defp duplicate_participant_id?(requests, participant_id) do
    Enum.any?(requests, fn {_existing_id, value} -> value["participant_id"] == participant_id end)
  end

  defp decode_admission_request(request) when is_map(request) do
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

  defp decode_admission_request(_request), do: {:error, :invalid_admission_request}

  defp decode_recording(nil), do: {:ok, nil}

  defp decode_recording(recording) when is_map(recording) do
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

  defp decode_recording(_recording), do: {:error, :invalid_recording}

  defp valid_failure_code?("failed", code), do: is_binary(code) and byte_size(code) in 1..96
  defp valid_failure_code?(_status, nil), do: true
  defp valid_failure_code?(_status, _code), do: false

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
         {"recording", "stopping"},
         {"recording", "failed"},
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
    do: %{state | admission_requests: Map.delete(state.admission_requests, request_id)}

  defp valid_display_name?(display_name),
    do:
      String.valid?(display_name) and display_name == String.trim(display_name) and
        byte_size(display_name) in 1..@max_display_name_bytes

  defp valid_role?(role),
    do:
      is_binary(role) and String.valid?(role) and role == String.trim(role) and
        byte_size(role) in 1..@max_role_bytes

  defp valid_capabilities?(values) when is_list(values),
    do:
      length(values) <= @max_capabilities and Enum.uniq(values) == values and
        Enum.all?(values, &(&1 in @capabilities))

  defp valid_capabilities?(_values), do: false

  defp participant_id(value) when is_binary(value) and byte_size(value) > 0, do: {:ok, value}
  defp participant_id(_value), do: {:error, :invalid_payload}

  defp participant(state, participant_id) do
    case state.participants do
      %{^participant_id => participant} -> {:ok, participant}
      _ -> {:error, :not_joined}
    end
  end

  defp event_participant(state, payload) do
    with :ok <- exact_keys(payload, ["participant_id"]),
         {:ok, participant_id} <- participant_id(payload["participant_id"]),
         {:ok, participant} <- participant(state, participant_id) do
      {:ok, participant_id, participant}
    end
  end

  defp event_fields(%{name: name, base_revision: base, revision: revision, payload: payload}),
    do: validate_event_fields(name, base, revision, payload)

  defp event_fields(%{
         "name" => name,
         "base_revision" => base,
         "revision" => revision,
         "payload" => payload
       }),
       do: validate_event_fields(name, base, revision, payload)

  defp event_fields(_event), do: {:error, :invalid_event}

  defp validate_event_fields(name, base, revision, payload)
       when is_binary(name) and is_integer(base) and base >= 0 and is_integer(revision) and
              revision > 0 and is_map(payload),
       do: {:ok, name, base, revision, stringify_keys(payload)}

  defp validate_event_fields(_name, _base, _revision, _payload), do: {:error, :invalid_event}
  defp validate_revision(current, current, revision) when revision == current + 1, do: :ok
  defp validate_revision(_current, _base_revision, _revision), do: {:error, :revision_gap}

  defp exact_keys(map, keys),
    do:
      if(map |> Map.keys() |> Enum.sort() == Enum.sort(keys),
        do: :ok,
        else: {:error, :invalid_payload}
      )

  defp stringify_keys(map),
    do:
      Map.new(map, fn
        {key, value} when is_atom(key) -> {Atom.to_string(key), value}
        pair -> pair
      end)

  defp snapshot_keys,
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
