defmodule ChalkSync.Rooms.Room do
  @moduledoc """
  Pure room-control state machine.

  Commands validate against current state and produce exactly one event; state
  advances only by applying events (`apply_event/2`), so replaying the event
  log from any snapshot reproduces the same state. Every event carries an
  exact `base_revision -> revision` chain — clients use it to detect dropped,
  duplicated, or reordered updates.

  No processes, no side effects, no clocks. The process shell
  (`ChalkSync.Rooms.RoomServer`) owns serialization and fanout.
  """

  @enforce_keys [:id]
  defstruct [:id, revision: 0, participants: %{}]

  @type participant :: %{display_name: String.t(), hand_raised: boolean()}
  @type event :: %{
          name: String.t(),
          base_revision: non_neg_integer(),
          revision: pos_integer(),
          payload: %{optional(String.t()) => term()}
        }
  @type t :: %__MODULE__{
          id: String.t(),
          revision: non_neg_integer(),
          participants: %{optional(String.t()) => participant()}
        }

  @spec new(String.t()) :: t()
  def new(id), do: %__MODULE__{id: id}

  @doc """
  Validates a command and returns the resulting event plus the advanced state.

  `:join` and `:leave` are server-driven (socket lifecycle); clients may only
  issue the commands whitelisted in `ChalkSync.Protocol`.
  """
  @spec apply_command(t(), String.t(), atom(), map()) ::
          {:ok, event(), t()} | {:error, atom()}
  def apply_command(%__MODULE__{} = room, actor_id, command, payload \\ %{}) do
    with {:ok, name, event_payload} <- validate(room, actor_id, command, payload) do
      event = %{
        name: name,
        base_revision: room.revision,
        revision: room.revision + 1,
        payload: event_payload
      }

      {:ok, event, apply_event(room, event)}
    end
  end

  @doc "Advances state by one event. The event's base_revision must match."
  @spec apply_event(t(), event()) :: t()
  def apply_event(%__MODULE__{revision: revision} = room, %{base_revision: revision} = event) do
    %{apply_payload(room, event) | revision: event.revision}
  end

  @doc "Wire-shaped snapshot for the `welcome` frame."
  @spec snapshot(t()) :: map()
  def snapshot(%__MODULE__{} = room) do
    participants =
      Enum.map(room.participants, fn {id, p} ->
        %{
          "participant_id" => id,
          "display_name" => p.display_name,
          "hand_raised" => p.hand_raised
        }
      end)

    %{"control_revision" => room.revision, "participants" => participants}
  end

  @spec joined?(t(), String.t()) :: boolean()
  def joined?(%__MODULE__{} = room, participant_id),
    do: Map.has_key?(room.participants, participant_id)

  defp validate(room, actor_id, :join, %{display_name: display_name}) do
    if joined?(room, actor_id) do
      {:error, :already_joined}
    else
      {:ok, "participant_joined", %{"participant_id" => actor_id, "display_name" => display_name}}
    end
  end

  defp validate(room, actor_id, :leave, _payload) do
    require_joined(room, actor_id, fn _ ->
      {:ok, "participant_left", %{"participant_id" => actor_id}}
    end)
  end

  defp validate(room, actor_id, :raise_hand, _payload) do
    require_joined(room, actor_id, fn participant ->
      if participant.hand_raised do
        {:error, :no_change}
      else
        {:ok, "hand_raised", %{"participant_id" => actor_id}}
      end
    end)
  end

  defp validate(room, actor_id, :lower_hand, _payload) do
    require_joined(room, actor_id, fn participant ->
      if participant.hand_raised do
        {:ok, "hand_lowered", %{"participant_id" => actor_id}}
      else
        {:error, :no_change}
      end
    end)
  end

  defp validate(_room, _actor_id, _command, _payload), do: {:error, :unknown_command}

  defp require_joined(room, actor_id, fun) do
    case room.participants do
      %{^actor_id => participant} -> fun.(participant)
      _ -> {:error, :not_joined}
    end
  end

  defp apply_payload(room, %{name: "participant_joined", payload: payload}) do
    participant = %{display_name: payload["display_name"], hand_raised: false}
    put_in(room.participants[payload["participant_id"]], participant)
  end

  defp apply_payload(room, %{name: "participant_left", payload: payload}) do
    %{room | participants: Map.delete(room.participants, payload["participant_id"])}
  end

  defp apply_payload(room, %{name: "hand_raised", payload: payload}) do
    put_in(room.participants[payload["participant_id"]].hand_raised, true)
  end

  defp apply_payload(room, %{name: "hand_lowered", payload: payload}) do
    put_in(room.participants[payload["participant_id"]].hand_raised, false)
  end
end
