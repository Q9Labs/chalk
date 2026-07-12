defmodule ChalkSync.Sessions.Reducer do
  @moduledoc """
  Pure, total state machine for one durable Session control stream.

  Every accepted command or lifecycle transition produces exactly the next
  event. Decoded events are validated before application and return explicit
  errors for gaps, unknown shapes, and invalid transitions.
  """

  alias ChalkSync.CanonicalJSON

  @state_schema_version 1
  @digest_prefix "chalk-sync-state-v2"
  @max_display_name_bytes 256
  @max_participants 500
  @active_status "active"
  @ended_status "ended"

  @enforce_keys [:session_id]
  defstruct [:session_id, revision: 0, status: @active_status, participants: %{}]

  @type participant :: %{display_name: String.t(), hand_raised: boolean()}
  @type event :: %{
          name: String.t(),
          base_revision: non_neg_integer(),
          revision: pos_integer(),
          payload: %{optional(String.t()) => term()}
        }
  @type t :: %__MODULE__{
          session_id: String.t(),
          revision: non_neg_integer(),
          status: String.t(),
          participants: %{optional(String.t()) => participant()}
        }

  @spec state_schema_version() :: pos_integer()
  def state_schema_version, do: @state_schema_version

  @spec new(String.t()) :: t()
  def new(session_id) when is_binary(session_id), do: %__MODULE__{session_id: session_id}

  @spec decide_command(t(), String.t(), atom(), map()) ::
          {:ok, event(), t()} | {:error, atom()}
  def decide_command(%__MODULE__{status: @ended_status}, _actor_id, _name, _payload),
    do: {:error, :session_ended}

  def decide_command(%__MODULE__{} = state, actor_id, name, payload)
      when is_binary(actor_id) and is_atom(name) and is_map(payload) do
    with {:ok, event_name, event_payload} <- validate_command(state, actor_id, name, payload) do
      advance(state, event_name, event_payload)
    end
  end

  def decide_command(%__MODULE__{}, _actor_id, _name, _payload), do: {:error, :invalid_command}

  @spec apply_lifecycle(t(), atom(), map()) :: {:ok, event(), t()} | {:error, atom()}
  def apply_lifecycle(%__MODULE__{} = state, name, payload)
      when name in [:participant_joined, :participant_left, :session_ended] and is_map(payload) do
    advance(state, Atom.to_string(name), payload)
  end

  def apply_lifecycle(%__MODULE__{}, _name, _payload), do: {:error, :invalid_lifecycle_intent}

  @spec apply_event(t(), event() | map()) :: {:ok, t()} | {:error, atom()}
  def apply_event(%__MODULE__{} = state, event) when is_map(event) do
    with {:ok, name, base_revision, revision, payload} <- event_fields(event),
         :ok <- validate_revision(state.revision, base_revision, revision),
         {:ok, next} <- apply_payload(state, name, payload) do
      {:ok, %{next | revision: revision}}
    end
  end

  def apply_event(%__MODULE__{}, _event), do: {:error, :invalid_event}

  @spec from_snapshot(String.t(), map()) :: {:ok, t()} | {:error, atom()}
  def from_snapshot(session_id, snapshot) when is_binary(session_id) and is_map(snapshot) do
    with :ok <- exact_keys(snapshot, snapshot_keys()),
         revision when is_integer(revision) and revision >= 0 <- snapshot["control_revision"],
         @state_schema_version <- snapshot["state_schema_version"],
         status when status in [@active_status, @ended_status] <- snapshot["status"],
         participants when is_list(participants) <- snapshot["participants"],
         true <- length(participants) <= @max_participants,
         {:ok, participant_map} <- decode_participants(participants),
         true <- status == @active_status or map_size(participant_map) == 0 do
      {:ok,
       %__MODULE__{
         session_id: session_id,
         revision: revision,
         status: status,
         participants: participant_map
       }}
    else
      _ -> {:error, :invalid_snapshot}
    end
  end

  def from_snapshot(_session_id, _snapshot), do: {:error, :invalid_snapshot}

  @spec snapshot(t()) :: map()
  def snapshot(%__MODULE__{} = state) do
    participants =
      state.participants
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(fn {participant_session_id, participant} ->
        %{
          "participant_session_id" => participant_session_id,
          "display_name" => participant.display_name,
          "hand_raised" => participant.hand_raised
        }
      end)

    %{
      "control_revision" => state.revision,
      "state_schema_version" => @state_schema_version,
      "status" => state.status,
      "participants" => participants
    }
  end

  @spec digest(t()) :: binary()
  def digest(%__MODULE__{} = state) do
    canonical = state |> snapshot() |> CanonicalJSON.encode!()

    :crypto.hash(:sha256, [
      @digest_prefix,
      <<0, @state_schema_version::unsigned-big-32>>,
      canonical
    ])
  end

  @spec wire_snapshot(t()) :: map()
  def wire_snapshot(%__MODULE__{} = state) do
    Map.put(snapshot(state), "state_digest", Base.encode16(digest(state), case: :lower))
  end

  @spec snapshot_bytes(t()) :: non_neg_integer()
  def snapshot_bytes(%__MODULE__{} = state),
    do: state |> wire_snapshot() |> JSON.encode!() |> byte_size()

  @spec joined?(t(), String.t()) :: boolean()
  def joined?(%__MODULE__{} = state, participant_session_id),
    do: Map.has_key?(state.participants, participant_session_id)

  defp advance(state, name, payload) do
    event = %{
      name: name,
      base_revision: state.revision,
      revision: state.revision + 1,
      payload: stringify_keys(payload)
    }

    case apply_event(state, event) do
      {:ok, next} -> {:ok, event, next}
      {:error, reason} -> {:error, reason}
    end
  end

  defp validate_command(state, actor_id, :raise_hand, payload) do
    with :ok <- empty_payload(payload),
         {:ok, participant} <- participant(state, actor_id),
         false <- participant.hand_raised do
      {:ok, "hand_raised", %{"participant_session_id" => actor_id}}
    else
      true -> {:error, :no_change}
      {:error, reason} -> {:error, reason}
    end
  end

  defp validate_command(state, actor_id, :lower_hand, payload) do
    with :ok <- empty_payload(payload),
         {:ok, participant} <- participant(state, actor_id),
         true <- participant.hand_raised do
      {:ok, "hand_lowered", %{"participant_session_id" => actor_id}}
    else
      false -> {:error, :no_change}
      {:error, reason} -> {:error, reason}
    end
  end

  defp validate_command(_state, _actor_id, _name, _payload), do: {:error, :unknown_command}

  defp empty_payload(payload) when map_size(payload) == 0, do: :ok
  defp empty_payload(_payload), do: {:error, :invalid_payload}

  defp participant(state, participant_session_id) do
    case state.participants do
      %{^participant_session_id => participant} -> {:ok, participant}
      _ -> {:error, :not_joined}
    end
  end

  defp validate_revision(current, current, revision) when revision == current + 1, do: :ok
  defp validate_revision(_current, _base_revision, _revision), do: {:error, :revision_gap}

  defp apply_payload(%{status: @ended_status}, _name, _payload), do: {:error, :session_ended}

  defp apply_payload(state, "participant_joined", payload) do
    with :ok <- exact_keys(payload, ["display_name", "participant_session_id"]),
         participant_session_id when is_binary(participant_session_id) <-
           payload["participant_session_id"],
         display_name when is_binary(display_name) <- payload["display_name"],
         true <- byte_size(display_name) <= @max_display_name_bytes do
      cond do
        joined?(state, participant_session_id) ->
          {:error, :already_joined}

        map_size(state.participants) >= @max_participants ->
          {:error, :capacity_exceeded}

        true ->
          participant = %{display_name: display_name, hand_raised: false}
          {:ok, put_in(state.participants[participant_session_id], participant)}
      end
    else
      _ -> {:error, :invalid_payload}
    end
  end

  defp apply_payload(state, "participant_left", payload) do
    with :ok <- exact_keys(payload, ["participant_session_id"]),
         participant_session_id when is_binary(participant_session_id) <-
           payload["participant_session_id"],
         true <- joined?(state, participant_session_id) do
      {:ok, %{state | participants: Map.delete(state.participants, participant_session_id)}}
    else
      false -> {:error, :not_joined}
      _ -> {:error, :invalid_payload}
    end
  end

  defp apply_payload(state, "hand_raised", payload) do
    with {:ok, participant_session_id, participant} <- event_participant(state, payload),
         false <- participant.hand_raised do
      {:ok, put_in(state.participants[participant_session_id].hand_raised, true)}
    else
      true -> {:error, :invalid_transition}
      {:error, reason} -> {:error, reason}
    end
  end

  defp apply_payload(state, "hand_lowered", payload) do
    with {:ok, participant_session_id, participant} <- event_participant(state, payload),
         true <- participant.hand_raised do
      {:ok, put_in(state.participants[participant_session_id].hand_raised, false)}
    else
      false -> {:error, :invalid_transition}
      {:error, reason} -> {:error, reason}
    end
  end

  defp apply_payload(state, "session_ended", payload) do
    with :ok <- exact_keys(payload, []) do
      {:ok, %{state | status: @ended_status, participants: %{}}}
    end
  end

  defp apply_payload(_state, _name, _payload), do: {:error, :unknown_event}

  defp event_participant(state, payload) do
    with :ok <- exact_keys(payload, ["participant_session_id"]),
         participant_session_id when is_binary(participant_session_id) <-
           payload["participant_session_id"],
         {:ok, participant} <- participant(state, participant_session_id) do
      {:ok, participant_session_id, participant}
    else
      {:error, reason} -> {:error, reason}
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
       do: {:ok, name, base, revision, stringify_keys(payload)}

  defp validate_event_fields(_name, _base, _revision, _payload), do: {:error, :invalid_event}

  defp decode_participants(participants) do
    Enum.reduce_while(participants, {:ok, %{}}, fn encoded, {:ok, result} ->
      with true <- is_map(encoded),
           :ok <- exact_keys(encoded, participant_keys()),
           participant_session_id when is_binary(participant_session_id) <-
             encoded["participant_session_id"],
           display_name when is_binary(display_name) <- encoded["display_name"],
           true <- byte_size(display_name) <= @max_display_name_bytes,
           hand_raised when is_boolean(hand_raised) <- encoded["hand_raised"],
           false <- Map.has_key?(result, participant_session_id) do
        participant = %{display_name: display_name, hand_raised: hand_raised}
        {:cont, {:ok, Map.put(result, participant_session_id, participant)}}
      else
        _ -> {:halt, {:error, :invalid_snapshot}}
      end
    end)
  end

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
    do: ["control_revision", "participants", "state_schema_version", "status"]

  defp participant_keys,
    do: ["display_name", "hand_raised", "participant_session_id"]
end
