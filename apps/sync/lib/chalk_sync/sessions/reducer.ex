defmodule ChalkSync.Sessions.Reducer do
  @moduledoc "Pure state machine for one durable Session control stream."

  alias ChalkSync.CanonicalJSON

  @state_schema_version 3
  @digest_prefix "chalk-sync-state-v3"
  @max_display_name_bytes 256
  @max_participants 500
  @roles ["host", "cohost", "participant"]
  @assignable_roles ["cohost", "participant"]
  @admission_policies ["open", "approval", "closed"]
  @host_exit_policies ["require_transfer", "promote_cohost"]
  @capabilities ~w(publishAudio publishVideo publishScreen subscribe raiseHand renameSelf manageAdmission promoteDemote transferHost muteOthers stopVideoOthers stopScreenOthers requestMediaOthers removeParticipant manageRecording endMeeting)
  @default_role_capabilities %{
    "host" => @capabilities,
    "cohost" =>
      ~w(publishAudio publishVideo publishScreen subscribe raiseHand renameSelf manageAdmission promoteDemote muteOthers stopVideoOthers stopScreenOthers requestMediaOthers removeParticipant manageRecording),
    "participant" => ~w(publishAudio publishVideo publishScreen subscribe raiseHand renameSelf)
  }

  @enforce_keys [:session_id]
  defstruct session_id: nil,
            revision: 0,
            status: "active",
            admission_policy: "open",
            host_exit_policy: "require_transfer",
            role_capabilities: @default_role_capabilities,
            host_participant_session_id: nil,
            deadline_at_ms: 1,
            deadline_generation: 1,
            recording: nil,
            admission_requests: %{},
            participants: %{}

  @type participant :: %{
          display_name: String.t(),
          hand_raised: boolean(),
          role: String.t(),
          eligible_roles: [String.t()],
          admission_revision: non_neg_integer()
        }
  @type event :: %{
          name: String.t(),
          base_revision: non_neg_integer(),
          revision: pos_integer(),
          payload: map()
        }
  @type t :: %__MODULE__{}

  def state_schema_version, do: @state_schema_version

  def new(session_id, policy \\ %{}) when is_binary(session_id) and is_map(policy) do
    %__MODULE__{
      session_id: session_id,
      admission_policy:
        Map.get(policy, :admission_policy, Map.get(policy, "admission_policy", "open")),
      host_exit_policy:
        Map.get(
          policy,
          :host_exit_policy,
          Map.get(policy, "host_exit_policy", "require_transfer")
        ),
      role_capabilities:
        Map.get(
          policy,
          :role_capabilities,
          Map.get(policy, "role_capabilities", @default_role_capabilities)
        ),
      deadline_at_ms: Map.get(policy, :deadline_at_ms, Map.get(policy, "deadline_at_ms", 1)),
      deadline_generation:
        Map.get(policy, :deadline_generation, Map.get(policy, "deadline_generation", 1)),
      recording: Map.get(policy, :recording, Map.get(policy, "recording")),
      admission_requests:
        Map.get(policy, :admission_requests, Map.get(policy, "admission_requests", %{}))
    }
  end

  @spec decide_command(t(), String.t(), atom(), map()) ::
          {:change, event(), t()} | {:satisfied, t()} | {:error, atom()}
  def decide_command(%__MODULE__{status: "ended"}, _actor_id, _name, _payload),
    do: {:error, :session_ended}

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

  def apply_lifecycle(%__MODULE__{} = state, :admission_requested, payload)
      when is_map(payload) do
    advance(state, "admission_requested", payload)
  end

  def apply_lifecycle(%__MODULE__{}, _name, _payload), do: {:error, :invalid_lifecycle_intent}

  @external_events ~w(participant_left host_left_and_transferred session_ended host_transferred deadline_changed admission_denied admission_expired participant_microphone_stopped participant_camera_stopped participant_screen_share_stopped recording_status_changed)

  def apply_external(%__MODULE__{} = state, name, payload)
      when is_atom(name) and is_map(payload),
      do: apply_external(state, Atom.to_string(name), payload)

  def apply_external(%__MODULE__{} = state, name, payload)
      when name in @external_events and is_map(payload),
      do: advance(state, name, payload)

  def apply_external(%__MODULE__{}, _name, _payload), do: {:error, :invalid_external_operation}

  def decide_external(%__MODULE__{} = state, :participant_leave, payload) when is_map(payload) do
    with {:ok, participant_id, reason} <- participant_leave(payload),
         {:ok, event_name, event_payload} <- leave_target(state, participant_id, reason),
         {:ok, event, next} <- advance(state, event_name, event_payload) do
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

  def from_snapshot(session_id, snapshot) when is_binary(session_id) and is_map(snapshot) do
    with :ok <- exact_keys(snapshot, snapshot_keys()),
         revision when is_integer(revision) and revision >= 0 <- snapshot["control_revision"],
         @state_schema_version <- snapshot["state_schema_version"],
         status when status in ["active", "ended"] <- snapshot["status"],
         admission_policy when admission_policy in @admission_policies <-
           snapshot["admission_policy"],
         host_exit_policy when host_exit_policy in @host_exit_policies <-
           snapshot["host_exit_policy"],
         {:ok, role_capabilities} <- decode_role_capabilities(snapshot["role_capabilities"]),
         host_id when is_binary(host_id) or is_nil(host_id) <-
           snapshot["host_participant_session_id"],
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
        session_id: session_id,
        revision: revision,
        status: status,
        admission_policy: admission_policy,
        host_exit_policy: host_exit_policy,
        role_capabilities: role_capabilities,
        host_participant_session_id: host_id,
        deadline_at_ms: deadline_at_ms,
        deadline_generation: deadline_generation,
        recording: recording,
        admission_requests: admission_requests,
        participants: participant_map
      }

      case valid_state?(state) do
        :ok -> {:ok, state}
        _ -> {:error, :invalid_snapshot}
      end
    else
      _ -> {:error, :invalid_snapshot}
    end
  end

  def from_snapshot(_session_id, _snapshot), do: {:error, :invalid_snapshot}

  def snapshot(%__MODULE__{} = state) do
    participants =
      state.participants
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(fn {participant_id, participant} ->
        %{
          "participant_session_id" => participant_id,
          "display_name" => participant.display_name,
          "hand_raised" => participant.hand_raised,
          "role" => participant.role,
          "eligible_roles" => participant.eligible_roles,
          "capabilities" => Map.fetch!(state.role_capabilities, participant.role),
          "admission_revision" => participant.admission_revision
        }
      end)

    %{
      "control_revision" => state.revision,
      "state_schema_version" => @state_schema_version,
      "status" => state.status,
      "admission_policy" => state.admission_policy,
      "host_exit_policy" => state.host_exit_policy,
      "host_participant_session_id" => state.host_participant_session_id,
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

  def snapshot(%__MODULE__{} = state, 2) do
    %{
      "control_revision" => state.revision,
      "state_schema_version" => @state_schema_version,
      "status" => state.status,
      "participants" =>
        state.participants
        |> Enum.sort_by(&elem(&1, 0))
        |> Enum.map(fn {participant_id, participant} ->
          %{
            "participant_session_id" => participant_id,
            "display_name" => participant.display_name,
            "hand_raised" => participant.hand_raised
          }
        end)
    }
  end

  def snapshot(%__MODULE__{} = state, 3), do: snapshot(state)

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
        else: {:ok, hand_event_name(raised), %{"participant_session_id" => actor_id}}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_target}
    end
  end

  defp command_target(state, actor_id, :set_display_name, payload) do
    with :ok <- exact_keys(payload, ["displayName"]),
         display_name when is_binary(display_name) <- payload["displayName"],
         true <- String.valid?(display_name),
         true <- display_name == String.trim(display_name),
         true <- byte_size(display_name) in 1..@max_display_name_bytes,
         {:ok, participant} <- participant(state, actor_id) do
      if participant.display_name == display_name,
        do: {:error, :satisfied},
        else:
          {:ok, "participant_display_name_changed",
           %{"participant_session_id" => actor_id, "display_name" => display_name}}
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

  defp command_target(state, _actor_id, :set_participant_role, payload) do
    with :ok <- exact_keys(payload, ["participantSessionId", "role"]),
         participant_id when is_binary(participant_id) <- payload["participantSessionId"],
         role when role in @assignable_roles <- payload["role"],
         {:ok, participant} <- participant(state, participant_id),
         true <- role in participant.eligible_roles do
      if participant.role == role,
        do: {:error, :satisfied},
        else:
          {:ok, "participant_role_changed",
           %{"participant_session_id" => participant_id, "role" => role}}
    else
      false -> {:error, :role_not_eligible}
      {:error, :not_joined} -> {:error, :invalid_target}
      _ -> {:error, :invalid_target}
    end
  end

  defp command_target(state, actor_id, :transfer_host, payload) do
    with :ok <- exact_keys(payload, ["participantSessionId"]),
         true <- state.host_participant_session_id == actor_id,
         participant_id when is_binary(participant_id) <- payload["participantSessionId"],
         true <- participant_id != actor_id,
         {:ok, participant} <- participant(state, participant_id),
         true <- "host" in participant.eligible_roles do
      {:ok, "host_transferred",
       %{
         "previous_host_participant_session_id" => actor_id,
         "new_host_participant_session_id" => participant_id
       }}
    else
      false -> {:error, :invalid_target}
      {:error, :not_joined} -> {:error, :invalid_target}
      _ -> {:error, :invalid_target}
    end
  end

  # The disabled v1 compatibility socket still uses operation-shaped hand commands.
  defp command_target(state, actor_id, name, payload) when name in [:raise_hand, :lower_hand] do
    with :ok <- exact_keys(payload, []),
         {:ok, participant} <- participant(state, actor_id),
         target = name == :raise_hand,
         false <- participant.hand_raised == target do
      {:ok, if(target, do: "hand_raised", else: "hand_lowered"),
       %{
         "participant_session_id" => actor_id
       }}
    else
      true -> {:error, :no_change}
      error -> error
    end
  end

  defp command_target(_state, _actor_id, _name, _payload), do: {:error, :unknown_command}

  defp hand_event_name(true), do: "hand_raised"
  defp hand_event_name(false), do: "hand_lowered"

  defp leave_target(state, participant_id, reason) do
    with {:ok, _participant} <- participant(state, participant_id) do
      leave_for_role(state, participant_id, reason)
    end
  end

  defp leave_for_role(%{host_participant_session_id: host_id}, participant_id, reason)
       when host_id != participant_id,
       do:
         {:ok, "participant_left",
          %{"participant_session_id" => participant_id, "reason" => reason}}

  defp leave_for_role(%{host_exit_policy: "promote_cohost"} = state, participant_id, _reason) do
    case longest_tenured_cohost(state, participant_id) do
      nil ->
        {:error, :host_transfer_required}

      successor ->
        {:ok, "host_left_and_transferred",
         %{
           "departing_participant_session_id" => participant_id,
           "successor_participant_session_id" => successor
         }}
    end
  end

  defp leave_for_role(_state, _participant_id, _reason), do: {:error, :host_transfer_required}

  defp longest_tenured_cohost(state, departing_id) do
    state.participants
    |> Enum.reject(fn {id, _participant} -> id == departing_id end)
    |> Enum.filter(fn {_id, participant} -> participant.role == "cohost" end)
    |> Enum.min_by(fn {id, participant} -> {participant.admission_revision, id} end, fn -> nil end)
    |> case do
      {id, _participant} -> id
      nil -> nil
    end
  end

  # credo:disable-for-next-line Credo.Check.Refactor.CyclomaticComplexity
  defp normalize_join(state, payload) do
    allowed = [
      "participant_session_id",
      "display_name",
      "role",
      "eligible_roles",
      "admission_revision"
    ]

    with true <- Enum.all?(Map.keys(payload), &(&1 in allowed)),
         participant_id when is_binary(participant_id) <- payload["participant_session_id"],
         display_name when is_binary(display_name) <- payload["display_name"],
         true <- String.valid?(display_name) and display_name == String.trim(display_name),
         true <- byte_size(display_name) in 1..@max_display_name_bytes do
      first? = map_size(state.participants) == 0
      role = Map.get(payload, "role", if(first?, do: "host", else: "participant"))
      eligible = Map.get(payload, "eligible_roles", if(first?, do: @roles, else: ["participant"]))
      admission_revision = Map.get(payload, "admission_revision", state.revision + 1)

      if role in @roles and valid_eligible_roles?(eligible) and role in eligible and
           (role != "host" or "cohost" in eligible) and is_integer(admission_revision) and
           admission_revision >= 0 do
        {:ok,
         %{
           "participant_session_id" => participant_id,
           "display_name" => display_name,
           "role" => role,
           "eligible_roles" => eligible,
           "admission_revision" => admission_revision
         }}
      else
        {:error, :invalid_payload}
      end
    else
      _ -> {:error, :invalid_payload}
    end
  end

  defp only_participant_id(payload) do
    with :ok <- exact_keys(payload, ["participant_session_id"]),
         participant_id when is_binary(participant_id) <- payload["participant_session_id"] do
      {:ok, participant_id}
    else
      _ -> {:error, :invalid_payload}
    end
  end

  defp participant_leave(payload) do
    with true <- Enum.all?(Map.keys(payload), &(&1 in ["participant_session_id", "reason"])),
         participant_id when is_binary(participant_id) <- payload["participant_session_id"],
         reason = Map.get(payload, "reason", "left"),
         true <- reason in ["left", "removed"] do
      {:ok, participant_id, reason}
    else
      _ -> {:error, :invalid_payload}
    end
  end

  defp apply_payload(%{status: "ended"}, _name, _payload), do: {:error, :session_ended}

  defp apply_payload(state, "participant_joined", payload) do
    with :ok <-
           exact_keys(payload, [
             "admission_revision",
             "display_name",
             "eligible_roles",
             "participant_session_id",
             "role"
           ]),
         false <- joined?(state, payload["participant_session_id"]),
         true <- map_size(state.participants) < @max_participants,
         {:ok, admission_request_id} <- matching_admission_request(state, payload) do
      participant = %{
        display_name: payload["display_name"],
        hand_raised: false,
        role: payload["role"],
        eligible_roles: payload["eligible_roles"],
        admission_revision: payload["admission_revision"]
      }

      next =
        state
        |> put_in([Access.key(:participants), payload["participant_session_id"]], participant)
        |> remove_admission_request(admission_request_id)

      if participant.role == "host" and is_nil(state.host_participant_session_id),
        do: {:ok, %{next | host_participant_session_id: payload["participant_session_id"]}},
        else: {:ok, next}
    else
      true -> {:error, :invalid_transition}
      false -> {:error, :capacity_exceeded}
      _ -> {:error, :invalid_payload}
    end
  end

  defp apply_payload(state, "participant_left", payload) do
    with {:ok, participant_id, _reason} <- participant_leave(payload),
         true <- joined?(state, participant_id),
         false <- state.host_participant_session_id == participant_id do
      {:ok, %{state | participants: Map.delete(state.participants, participant_id)}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "host_left_and_transferred", payload) do
    with :ok <-
           exact_keys(payload, [
             "departing_participant_session_id",
             "successor_participant_session_id"
           ]),
         departing_id when departing_id == state.host_participant_session_id <-
           payload["departing_participant_session_id"],
         successor_id when is_binary(successor_id) <- payload["successor_participant_session_id"],
         {:ok, %{role: "cohost"}} <- participant(state, successor_id) do
      participants =
        state.participants
        |> Map.delete(departing_id)
        |> put_in([successor_id, :role], "host")

      {:ok, %{state | participants: participants, host_participant_session_id: successor_id}}
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
    with :ok <- exact_keys(payload, ["display_name", "participant_session_id"]),
         {:ok, participant} <- participant(state, payload["participant_session_id"]),
         false <- participant.display_name == payload["display_name"] do
      {:ok,
       put_in(
         state.participants[payload["participant_session_id"]].display_name,
         payload["display_name"]
       )}
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

  defp apply_payload(state, "deadline_changed", payload) do
    with :ok <- exact_keys(payload, ["deadline_at_ms", "deadline_generation"]),
         deadline_at_ms when is_integer(deadline_at_ms) and deadline_at_ms > 0 <-
           payload["deadline_at_ms"],
         deadline_generation when deadline_generation == state.deadline_generation + 1 <-
           payload["deadline_generation"] do
      {:ok,
       %{
         state
         | deadline_at_ms: deadline_at_ms,
           deadline_generation: deadline_generation
       }}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "admission_requested", payload) do
    with {:ok, request} <- decode_admission_request(payload),
         false <- Map.has_key?(state.admission_requests, request["admission_request_id"]),
         false <-
           Enum.any?(state.admission_requests, fn {_id, existing} ->
             existing["participant_session_id"] == request["participant_session_id"]
           end),
         false <- joined?(state, request["participant_session_id"]),
         true <- map_size(state.admission_requests) < @max_participants do
      {:ok,
       put_in(
         state.admission_requests[request["admission_request_id"]],
         request
       )}
    else
      true -> {:error, :invalid_transition}
      _ -> {:error, :invalid_payload}
    end
  end

  defp apply_payload(state, "admission_denied", payload) do
    with :ok <- exact_keys(payload, ["admission_request_id"]),
         request_id when is_binary(request_id) <- payload["admission_request_id"],
         true <- Map.has_key?(state.admission_requests, request_id) do
      {:ok, %{state | admission_requests: Map.delete(state.admission_requests, request_id)}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "admission_expired", payload) do
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
    with {:ok, participant_id} <- only_participant_id(payload),
         true <- joined?(state, participant_id) do
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

  defp apply_payload(state, "participant_role_changed", payload) do
    with :ok <- exact_keys(payload, ["participant_session_id", "role"]),
         participant_id when participant_id != state.host_participant_session_id <-
           payload["participant_session_id"],
         role when role in @assignable_roles <- payload["role"],
         {:ok, participant} <- participant(state, participant_id),
         true <- role in participant.eligible_roles,
         false <- role == participant.role do
      {:ok, put_in(state.participants[participant_id].role, role)}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "host_transferred", payload) do
    with :ok <-
           exact_keys(payload, [
             "new_host_participant_session_id",
             "previous_host_participant_session_id"
           ]),
         from_id when from_id == state.host_participant_session_id <-
           payload["previous_host_participant_session_id"],
         to_id when is_binary(to_id) and to_id != from_id <-
           payload["new_host_participant_session_id"],
         {:ok, target} <- participant(state, to_id),
         true <- "host" in target.eligible_roles do
      participants =
        state.participants
        |> put_in([from_id, :role], "cohost")
        |> put_in([to_id, :role], "host")

      {:ok, %{state | participants: participants, host_participant_session_id: to_id}}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(state, "session_ended", payload) do
    with :ok <- exact_keys(payload, ["reason"]),
         true <-
           payload["reason"] in ["ended_by_participant", "tenant_recovery", "maximum_duration"] do
      {:ok,
       %{
         state
         | status: "ended",
           participants: %{},
           host_participant_session_id: nil,
           admission_requests: %{},
           recording: nil
       }}
    else
      _ -> {:error, :invalid_transition}
    end
  end

  defp apply_payload(_state, _name, _payload), do: {:error, :unknown_event}

  defp valid_state?(
         %{
           status: "ended",
           participants: participants,
           host_participant_session_id: nil,
           admission_requests: admission_requests,
           recording: nil
         } = state
       )
       when map_size(participants) == 0 and map_size(admission_requests) == 0,
       do: validate_common_state(state)

  defp valid_state?(
         %{
           status: "active",
           participants: participants,
           host_participant_session_id: nil
         } = state
       )
       when map_size(participants) == 0,
       do: validate_common_state(state)

  defp valid_state?(%{status: "active"} = state) do
    hosts =
      Enum.filter(state.participants, fn {_id, participant} -> participant.role == "host" end)

    case hosts do
      [{host_id, _participant}] when host_id == state.host_participant_session_id ->
        validate_common_state(state)

      _ ->
        {:error, :invalid_state}
    end
  end

  defp valid_state?(_state), do: {:error, :invalid_state}

  defp validate_common_state(state) do
    with true <- state.admission_policy in @admission_policies,
         true <- state.host_exit_policy in @host_exit_policies,
         true <- is_integer(state.deadline_at_ms) and state.deadline_at_ms > 0,
         true <- is_integer(state.deadline_generation) and state.deadline_generation > 0,
         true <- map_size(state.participants) <= @max_participants,
         true <- map_size(state.admission_requests) <= @max_participants,
         {:ok, _mapping} <- decode_role_capabilities(state.role_capabilities),
         true <- Enum.all?(state.participants, &valid_participant?/1),
         true <- Enum.all?(state.admission_requests, &valid_admission_request_entry?/1),
         {:ok, _recording} <- decode_recording(state.recording) do
      :ok
    else
      _ -> {:error, :invalid_state}
    end
  end

  defp valid_participant?({_id, participant}) do
    participant.role in @roles and valid_eligible_roles?(participant.eligible_roles) and
      participant.role in participant.eligible_roles and
      (participant.role != "host" or "cohost" in participant.eligible_roles) and
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
           participant_id when is_binary(participant_id) <- encoded["participant_session_id"],
           display_name when is_binary(display_name) <- encoded["display_name"],
           hand_raised when is_boolean(hand_raised) <- encoded["hand_raised"],
           role when role in @roles <- encoded["role"],
           true <- valid_eligible_roles?(encoded["eligible_roles"]),
           true <- role in encoded["eligible_roles"],
           true <- role != "host" or "cohost" in encoded["eligible_roles"],
           expected_capabilities = Map.fetch!(role_capabilities, role),
           ^expected_capabilities <- encoded["capabilities"],
           admission_revision when is_integer(admission_revision) and admission_revision > 0 <-
             encoded["admission_revision"],
           false <- Map.has_key?(result, participant_id) do
        participant = %{
          display_name: display_name,
          hand_raised: hand_raised,
          role: role,
          eligible_roles: encoded["eligible_roles"],
          admission_revision: admission_revision
        }

        {:cont, {:ok, Map.put(result, participant_id, participant)}}
      else
        _ -> {:halt, {:error, :invalid_snapshot}}
      end
    end)
  end

  defp decode_role_capabilities(mapping) when is_map(mapping) do
    with :ok <- exact_keys(mapping, @roles),
         true <- Enum.all?(mapping, fn {_role, values} -> valid_capabilities?(values) end) do
      {:ok, mapping}
    else
      _ -> {:error, :invalid_snapshot}
    end
  end

  defp decode_role_capabilities(_mapping), do: {:error, :invalid_snapshot}

  defp decode_admission_requests(requests)
       when is_list(requests) and length(requests) <= @max_participants do
    Enum.reduce_while(requests, {:ok, %{}}, fn encoded, {:ok, result} ->
      with {:ok, request} <- decode_admission_request(encoded),
           id = request["admission_request_id"],
           false <- Map.has_key?(result, id),
           false <- admission_participant_exists?(result, request["participant_session_id"]) do
        {:cont, {:ok, Map.put(result, id, request)}}
      else
        _ -> {:halt, {:error, :invalid_snapshot}}
      end
    end)
  end

  defp decode_admission_requests(_requests), do: {:error, :invalid_snapshot}

  defp admission_participant_exists?(requests, participant_id) do
    Enum.any?(requests, fn {_id, request} ->
      request["participant_session_id"] == participant_id
    end)
  end

  defp decode_admission_request(request) when is_map(request) do
    with :ok <- exact_keys(request, admission_request_keys()),
         id when is_binary(id) <- request["admission_request_id"],
         participant_id when is_binary(participant_id) <- request["participant_session_id"],
         display_name when is_binary(display_name) <- request["display_name"],
         true <- valid_display_name?(display_name),
         role when role in @roles <- request["initial_role"],
         true <- valid_eligible_roles?(request["eligible_roles"]),
         true <- role in request["eligible_roles"],
         true <- role != "host" or "cohost" in request["eligible_roles"],
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

  defp valid_failure_code?("failed", code),
    do: is_binary(code) and byte_size(code) in 1..96

  defp valid_failure_code?(_status, nil), do: true
  defp valid_failure_code?(_status, _code), do: false

  defp valid_recording_transition(nil, %{"status" => "starting"}), do: :ok

  defp valid_recording_transition(
         %{"status" => status},
         %{"status" => "starting"}
       )
       when status in ["stopped", "failed"],
       do: :ok

  defp valid_recording_transition(
         %{"recording_id" => id, "status" => from},
         %{"recording_id" => id, "status" => to}
       ) do
    if {from, to} in [
         {"starting", "recording"},
         {"starting", "failed"},
         {"recording", "stopping"},
         {"recording", "failed"},
         {"stopping", "stopped"},
         {"stopping", "failed"}
       ],
       do: :ok,
       else: {:error, :invalid_transition}
  end

  defp valid_recording_transition(_current, _next), do: {:error, :invalid_transition}

  defp matching_admission_request(state, payload) do
    matches =
      Enum.filter(state.admission_requests, fn {_id, request} ->
        request["participant_session_id"] == payload["participant_session_id"]
      end)

    case matches do
      [] ->
        {:ok, nil}

      [{id, request}] ->
        if request["display_name"] == payload["display_name"] and
             request["initial_role"] == payload["role"] and
             request["eligible_roles"] == payload["eligible_roles"],
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

  defp valid_capabilities?(values) when is_list(values),
    do:
      length(values) <= 16 and Enum.uniq(values) == values and
        Enum.all?(values, &(&1 in @capabilities))

  defp valid_capabilities?(_values), do: false

  defp valid_eligible_roles?(roles) when is_list(roles),
    do: length(roles) in 1..3 and Enum.uniq(roles) == roles and Enum.all?(roles, &(&1 in @roles))

  defp valid_eligible_roles?(_roles), do: false

  defp participant(state, participant_id) do
    case state.participants do
      %{^participant_id => participant} -> {:ok, participant}
      _ -> {:error, :not_joined}
    end
  end

  defp event_participant(state, payload) do
    with {:ok, participant_id} <- only_participant_id(payload),
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

  defp exact_keys(map, keys) do
    if map |> Map.keys() |> Enum.sort() == Enum.sort(keys),
      do: :ok,
      else: {:error, :invalid_payload}
  end

  defp stringify_keys(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {Atom.to_string(key), value}
      pair -> pair
    end)
  end

  defp snapshot_keys,
    do: [
      "admission_policy",
      "admission_requests",
      "control_revision",
      "deadline_at_ms",
      "deadline_generation",
      "host_exit_policy",
      "host_participant_session_id",
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
      "eligible_roles",
      "hand_raised",
      "participant_session_id",
      "role"
    ]

  defp admission_request_keys,
    do: [
      "admission_request_id",
      "display_name",
      "eligible_roles",
      "expires_at_ms",
      "initial_role",
      "participant_session_id"
    ]
end
