defmodule ChalkSync.SyncBreaker.Model do
  @moduledoc """
  Independent control-stream state model for the sync breaker.

  This module deliberately uses only plain maps and transition rules. It does
  not call the production room state machine, so shared defects cannot validate
  a breaker run accidentally.
  """

  alias ChalkSync.SyncBreaker.Operation

  defstruct revision: 0, participants: %{}, remembered: %{}

  @type participant :: %{display_name: String.t(), hand_raised: boolean()}
  @type event :: %{
          name: String.t(),
          base_revision: non_neg_integer(),
          revision: pos_integer(),
          payload: map()
        }
  @type t :: %__MODULE__{
          revision: non_neg_integer(),
          participants: %{optional(String.t()) => participant()},
          remembered: %{
            optional({String.t(), String.t()}) =>
              {:committed, pos_integer()} | {:rejected, atom()}
          }
        }

  @spec new() :: t()
  def new, do: %__MODULE__{}

  @spec apply(t(), Operation.t()) ::
          {:committed, event(), t()} | {:duplicate, pos_integer(), t()} | {:rejected, atom(), t()}
  def apply(%__MODULE__{} = state, %Operation{} = operation) do
    key = {operation.actor, operation.command_id}

    case state.remembered do
      %{^key => {:committed, revision}} -> {:duplicate, revision, state}
      %{^key => {:rejected, reason}} -> {:rejected, reason, state}
      _ -> apply_new(state, operation, key)
    end
  end

  @spec apply_event(t(), event() | map()) :: {:ok, t()} | {:error, :revision_gap | :unknown_event}
  def apply_event(%__MODULE__{} = state, event) do
    base_revision = event_value(event, :base_revision)
    revision = event_value(event, :revision)

    if base_revision == state.revision and revision == base_revision + 1 do
      case apply_payload(state, event_value(event, :name), event_value(event, :payload)) do
        {:ok, state} -> {:ok, %{state | revision: revision}}
        :error -> {:error, :unknown_event}
      end
    else
      {:error, :revision_gap}
    end
  end

  @spec replay(t(), [event() | map()]) :: {:ok, t()} | {:error, :revision_gap | :unknown_event}
  def replay(%__MODULE__{} = state, events) do
    Enum.reduce_while(events, {:ok, state}, fn event, {:ok, current} ->
      case apply_event(current, event) do
        {:ok, next} -> {:cont, {:ok, next}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  @spec snapshot(t()) :: map()
  def snapshot(%__MODULE__{} = state) do
    participants =
      state.participants
      |> Enum.sort_by(fn {id, _participant} -> id end)
      |> Enum.map(fn {id, participant} ->
        %{
          "participant_id" => id,
          "display_name" => participant.display_name,
          "hand_raised" => participant.hand_raised
        }
      end)

    %{"control_revision" => state.revision, "participants" => participants}
  end

  @spec from_snapshot(map()) :: {:ok, t()} | {:error, :invalid_snapshot}
  def from_snapshot(%{"control_revision" => revision, "participants" => participants})
      when is_integer(revision) and revision >= 0 and is_list(participants) do
    participants
    |> Enum.reduce_while({:ok, %{}}, fn participant, {:ok, acc} ->
      case participant_from_snapshot(participant) do
        {:ok, {id, value}} when not is_map_key(acc, id) ->
          {:cont, {:ok, Map.put(acc, id, value)}}

        :error ->
          {:halt, :error}

        {:ok, _duplicate} ->
          {:halt, :error}
      end
    end)
    |> case do
      {:ok, parsed} -> {:ok, %__MODULE__{revision: revision, participants: parsed}}
      :error -> {:error, :invalid_snapshot}
    end
  end

  def from_snapshot(_snapshot), do: {:error, :invalid_snapshot}

  @spec snapshot_matches?(t(), map()) :: boolean()
  def snapshot_matches?(%__MODULE__{} = state, snapshot) do
    case from_snapshot(snapshot) do
      {:ok, parsed} ->
        parsed.revision == state.revision and parsed.participants == state.participants

      {:error, :invalid_snapshot} ->
        false
    end
  end

  defp apply_new(state, operation, key) do
    case transition(state, operation) do
      {:ok, event} ->
        {:ok, next_state} = apply_event(state, event)
        remembered = Map.put(next_state.remembered, key, {:committed, event.revision})
        {:committed, event, %{next_state | remembered: remembered}}

      {:error, reason} ->
        remembered = Map.put(state.remembered, key, {:rejected, reason})
        {:rejected, reason, %{state | remembered: remembered}}
    end
  end

  defp transition(state, %Operation{
         actor: actor,
         name: :join,
         payload: %{display_name: display_name}
       })
       when is_binary(display_name) do
    if Map.has_key?(state.participants, actor) do
      {:error, :already_joined}
    else
      {:ok,
       event(state, "participant_joined", %{
         "participant_id" => actor,
         "display_name" => display_name
       })}
    end
  end

  defp transition(state, %Operation{actor: actor, name: :leave}) do
    if Map.has_key?(state.participants, actor) do
      {:ok, event(state, "participant_left", %{"participant_id" => actor})}
    else
      {:error, :not_joined}
    end
  end

  defp transition(state, %Operation{actor: actor, name: :raise_hand}) do
    case state.participants do
      %{^actor => %{hand_raised: false}} ->
        {:ok, event(state, "hand_raised", %{"participant_id" => actor})}

      %{^actor => %{hand_raised: true}} ->
        {:error, :no_change}

      _ ->
        {:error, :not_joined}
    end
  end

  defp transition(state, %Operation{actor: actor, name: :lower_hand}) do
    case state.participants do
      %{^actor => %{hand_raised: true}} ->
        {:ok, event(state, "hand_lowered", %{"participant_id" => actor})}

      %{^actor => %{hand_raised: false}} ->
        {:error, :no_change}

      _ ->
        {:error, :not_joined}
    end
  end

  defp transition(_state, _operation), do: {:error, :unknown_command}

  defp event(state, name, payload) do
    %{name: name, base_revision: state.revision, revision: state.revision + 1, payload: payload}
  end

  defp apply_payload(state, "participant_joined", %{
         "participant_id" => id,
         "display_name" => display_name
       })
       when is_binary(id) and is_binary(display_name) and not is_map_key(state.participants, id) do
    {:ok, put_in(state.participants[id], %{display_name: display_name, hand_raised: false})}
  end

  defp apply_payload(state, "participant_left", %{"participant_id" => id})
       when is_map_key(state.participants, id) do
    {:ok, %{state | participants: Map.delete(state.participants, id)}}
  end

  defp apply_payload(state, "hand_raised", %{"participant_id" => id}) do
    case state.participants do
      %{^id => %{hand_raised: false} = participant} ->
        {:ok, put_in(state.participants[id], %{participant | hand_raised: true})}

      _ ->
        :error
    end
  end

  defp apply_payload(state, "hand_lowered", %{"participant_id" => id}) do
    case state.participants do
      %{^id => %{hand_raised: true} = participant} ->
        {:ok, put_in(state.participants[id], %{participant | hand_raised: false})}

      _ ->
        :error
    end
  end

  defp apply_payload(_state, _name, _payload), do: :error

  defp participant_from_snapshot(%{
         "participant_id" => id,
         "display_name" => display_name,
         "hand_raised" => hand_raised
       })
       when is_binary(id) and is_binary(display_name) and is_boolean(hand_raised) do
    {:ok, {id, %{display_name: display_name, hand_raised: hand_raised}}}
  end

  defp participant_from_snapshot(_participant), do: :error

  defp event_value(event, key) do
    Map.get(event, key, Map.get(event, Atom.to_string(key)))
  end
end
