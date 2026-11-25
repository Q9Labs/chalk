defmodule ChalkSync.Episodes.Reducer do
  @moduledoc "Pure state machine for one durable Episode control stream."

  alias ChalkSync.CanonicalJSON
  alias ChalkSync.Episodes.Reducer.Events
  alias ChalkSync.Episodes.Reducer.Validation

  @state_schema_version 1
  @digest_prefix "chalk-sync-state-v1"
  @max_participants Validation.max_participants()
  @admission_policies Validation.admission_policies()
  @capabilities Validation.capabilities()
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
            admission_request_order: [],
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

  def max_participants, do: @max_participants

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

    admission_requests = value(policy, snapshot, :admission_requests, %{})

    %__MODULE__{
      episode_id: episode_id,
      admission_policy: admission_policy,
      role_capabilities: role_capabilities,
      deadline_at_ms: value(policy, snapshot, :deadline_at_ms, 1),
      deadline_generation: value(policy, snapshot, :deadline_generation, 1),
      recording: value(policy, snapshot, :recording, nil),
      admission_requests: admission_requests,
      admission_request_order: admission_requests |> Map.keys() |> Enum.sort()
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
    with :ok <- Validation.exact_keys(payload, ["episode_id"]),
         true <- payload["episode_id"] == state.episode_id do
      advance(state, "episode_started", payload)
    else
      _ -> {:error, :invalid_lifecycle_intent}
    end
  end

  def apply_lifecycle(%__MODULE__{} = state, :admission_requested, payload)
      when is_map(payload) do
    advance(state, "admission_requested", Validation.stringify_keys(payload))
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
         {:ok, next} <- Events.apply_payload(state, name, payload),
         :ok <- Validation.valid_state?(%{next | revision: revision}) do
      {:ok, %{next | revision: revision}}
    end
  end

  def apply_event(%__MODULE__{}, _event), do: {:error, :invalid_event}

  @spec replay_event(t(), event() | map(), binary()) :: {:ok, t()} | {:error, atom()}
  def replay_event(%__MODULE__{} = state, event, recorded_digest) do
    with {:ok, next} <- apply_event(state, event) do
      # TRIPWIRE(owner=sync, by=2027-02-13): journals written before admission order was kept unsorted digest the sorted
      # form. Delete this fallback once no stored digest needs it (replay with it disabled passes on a snapshot copy).
      legacy = %{next | admission_request_order: Enum.sort(next.admission_request_order)}

      cond do
        digest(next) == recorded_digest -> {:ok, next}
        digest(legacy) == recorded_digest -> {:ok, legacy}
        true -> {:error, :event_digest_mismatch}
      end
    end
  end

  @spec from_snapshot(String.t(), map()) :: {:ok, t()} | {:error, atom()}
  def from_snapshot(episode_id, snapshot) when is_binary(episode_id) and is_map(snapshot) do
    with :ok <- Validation.exact_keys(snapshot, Validation.snapshot_keys()),
         revision when is_integer(revision) and revision >= 0 <- snapshot["control_revision"],
         @state_schema_version <- snapshot["state_schema_version"],
         status when status in ["active", "ended"] <- snapshot["status"],
         admission_policy when admission_policy in @admission_policies <-
           snapshot["admission_policy"],
         {:ok, role_capabilities} <-
           Validation.decode_role_capabilities(snapshot["role_capabilities"]),
         deadline_at_ms when is_integer(deadline_at_ms) and deadline_at_ms >= 1 <-
           snapshot["deadline_at_ms"],
         deadline_generation when is_integer(deadline_generation) and deadline_generation >= 1 <-
           snapshot["deadline_generation"],
         {:ok, recording} <- Validation.decode_recording(snapshot["recording"]),
         {:ok, admission_requests} <-
           Validation.decode_admission_requests(snapshot["admission_requests"]),
         participants when is_list(participants) and length(participants) <= @max_participants <-
           snapshot["participants"],
         {:ok, participant_map} <- Validation.decode_participants(participants, role_capabilities) do
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
        admission_request_order:
          Enum.map(snapshot["admission_requests"], & &1["admission_request_id"]),
        participants: participant_map
      }

      if Validation.valid_state?(state) == :ok,
        do: {:ok, state},
        else: {:error, :invalid_snapshot}
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
        Enum.map(state.admission_request_order, &Map.fetch!(state.admission_requests, &1)),
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
      payload: Validation.stringify_keys(payload)
    }

    case apply_event(state, event) do
      {:ok, next} -> {:ok, event, next}
      error -> error
    end
  end

  defp command_target(state, actor_id, :set_hand_raised, payload) do
    with :ok <- Validation.exact_keys(payload, ["raised"]),
         raised when is_boolean(raised) <- payload["raised"],
         {:ok, participant} <- Events.participant(state, actor_id) do
      if participant.hand_raised == raised,
        do: {:error, :satisfied},
        else: {:ok, hand_event_name(raised), %{"participant_id" => actor_id}}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_target}
    end
  end

  defp command_target(state, actor_id, :set_display_name, payload) do
    with :ok <- Validation.exact_keys(payload, ["displayName"]),
         display_name when is_binary(display_name) <- payload["displayName"],
         true <- Validation.valid_display_name?(display_name),
         {:ok, participant} <- Events.participant(state, actor_id) do
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
    with :ok <- Validation.exact_keys(payload, ["policy"]),
         policy when policy in ["open", "knock"] <- payload["policy"] do
      if state.admission_policy == policy,
        do: {:error, :satisfied},
        else: {:ok, "admission_policy_changed", %{"policy" => policy}}
    else
      _ -> {:error, :invalid_target}
    end
  end

  defp command_target(state, _actor_id, :assign_roles, payload) do
    with :ok <- Validation.exact_keys(payload, ["participantId", "role"]),
         participant_id when is_binary(participant_id) <- payload["participantId"],
         role when is_binary(role) <- payload["role"],
         true <- Validation.valid_role?(role),
         {:ok, participant} <- Events.participant(state, participant_id),
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
         true <- Validation.valid_display_name?(display_name) do
      first? = map_size(state.participants) == 0
      role = Map.get(payload, "role", if(first?, do: "owner", else: "observer"))

      admission_revision = Map.get(payload, "admission_revision", state.revision + 1)

      if Validation.valid_role?(role) and
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
       do: {:ok, name, base, revision, Validation.stringify_keys(payload)}

  defp validate_event_fields(_name, _base, _revision, _payload), do: {:error, :invalid_event}

  defp validate_revision(current, current, revision) when revision == current + 1, do: :ok
  defp validate_revision(_current, _base_revision, _revision), do: {:error, :revision_gap}
end
