defmodule ChalkSync.SyncBreakerV2.Replica do
  @moduledoc false

  alias ChalkSync.CanonicalJSON

  @digest_prefix "chalk-sync-state-v2"
  @schema_version 1

  defstruct revision: 0, status: "active", participants: %{}

  def new, do: %__MODULE__{}

  def apply_event(%__MODULE__{} = state, %{"type" => "event", "stream" => "control"} = event) do
    with true <- event["schema_version"] == @schema_version,
         true <- event["base_revision"] == state.revision,
         true <- event["revision"] == state.revision + 1,
         {:ok, next} <- apply_payload(state, event["name"], event["payload"]),
         next = %{next | revision: event["revision"]},
         true <- event["resulting_state_digest"] == digest_hex(next) do
      {:ok, next}
    else
      false -> {:error, :revision_or_digest_mismatch}
      {:error, reason} -> {:error, reason}
    end
  end

  def apply_event(_state, _event), do: {:error, :invalid_event}

  def replay(events) when is_list(events) do
    replay(new(), events)
  end

  def replay(%__MODULE__{} = initial, events) when is_list(events) do
    Enum.reduce_while(events, {:ok, initial}, fn event, {:ok, state} ->
      case apply_event(state, event) do
        {:ok, next} -> {:cont, {:ok, next}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  def snapshot(%__MODULE__{} = state) do
    participants =
      state.participants
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(fn {participant_session_id, participant} ->
        Map.put(participant, "participant_session_id", participant_session_id)
      end)

    %{
      "control_revision" => state.revision,
      "state_schema_version" => @schema_version,
      "status" => state.status,
      "participants" => participants
    }
  end

  def digest(%__MODULE__{} = state) do
    :crypto.hash(:sha256, [
      @digest_prefix,
      <<0, @schema_version::unsigned-big-32>>,
      CanonicalJSON.encode!(snapshot(state))
    ])
  end

  def digest_hex(state), do: state |> digest() |> Base.encode16(case: :lower)

  def from_snapshot(snapshot) when is_map(snapshot) do
    with revision when is_integer(revision) and revision >= 0 <- snapshot["control_revision"],
         @schema_version <- snapshot["state_schema_version"],
         status when status in ["active", "ended"] <- snapshot["status"],
         participants when is_list(participants) <- snapshot["participants"],
         {:ok, participant_map} <- participant_map(participants) do
      {:ok, %__MODULE__{revision: revision, status: status, participants: participant_map}}
    else
      _ -> {:error, :invalid_snapshot}
    end
  end

  def from_snapshot(_snapshot), do: {:error, :invalid_snapshot}

  defp apply_payload(state, "participant_joined", %{
         "participant_session_id" => id,
         "display_name" => display_name
       })
       when is_binary(id) and is_binary(display_name) and state.status == "active" do
    if Map.has_key?(state.participants, id) do
      {:error, :duplicate_participant}
    else
      {:ok,
       put_in(state.participants[id], %{"display_name" => display_name, "hand_raised" => false})}
    end
  end

  defp apply_payload(state, "participant_left", %{"participant_session_id" => id})
       when is_binary(id) do
    if Map.has_key?(state.participants, id) do
      {:ok, %{state | participants: Map.delete(state.participants, id)}}
    else
      {:error, :unknown_participant}
    end
  end

  defp apply_payload(state, name, %{"participant_session_id" => id})
       when name in ["hand_raised", "hand_lowered"] and is_binary(id) do
    hand_raised = name == "hand_raised"

    case state.participants do
      %{^id => %{"hand_raised" => current} = participant} when current != hand_raised ->
        {:ok, put_in(state.participants[id], %{participant | "hand_raised" => hand_raised})}

      _ ->
        {:error, :invalid_hand_transition}
    end
  end

  defp apply_payload(%__MODULE__{status: "active"} = state, "session_ended", %{}),
    do: {:ok, %{state | status: "ended", participants: %{}}}

  defp apply_payload(_state, _name, _payload), do: {:error, :invalid_payload}

  defp participant_map(participants) do
    Enum.reduce_while(participants, {:ok, %{}}, fn
      %{
        "participant_session_id" => id,
        "display_name" => display_name,
        "hand_raised" => hand_raised
      },
      {:ok, acc}
      when is_binary(id) and is_binary(display_name) and is_boolean(hand_raised) ->
        if Map.has_key?(acc, id) do
          {:halt, {:error, :duplicate_participant}}
        else
          participant = %{"display_name" => display_name, "hand_raised" => hand_raised}
          {:cont, {:ok, Map.put(acc, id, participant)}}
        end

      _participant, _acc ->
        {:halt, {:error, :invalid_snapshot}}
    end)
  end
end
