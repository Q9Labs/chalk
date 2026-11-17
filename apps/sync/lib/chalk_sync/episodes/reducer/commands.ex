defmodule ChalkSync.Episodes.Reducer.Commands do
  @moduledoc """
  What each Participant command means for the control state: the one event it asks for, or the
  reason it cannot be asked. One clause per command name.
  """

  alias ChalkSync.Episodes.Reducer.Events
  alias ChalkSync.Episodes.Reducer.Validation

  def target(state, actor_id, :set_hand_raised, payload) do
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

  def target(state, actor_id, :set_display_name, payload) do
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

  def target(state, _actor_id, :set_admission_policy, payload) do
    with :ok <- Validation.exact_keys(payload, ["policy"]),
         policy when policy in ["open", "knock"] <- payload["policy"] do
      if state.admission_policy == policy,
        do: {:error, :satisfied},
        else: {:ok, "admission_policy_changed", %{"policy" => policy}}
    else
      _ -> {:error, :invalid_target}
    end
  end

  def target(state, _actor_id, :assign_roles, payload) do
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

  # The caller resolves an extension against the Episode's ceiling and passes the new deadline,
  # because the ceiling is Episode configuration and not part of the replicated state.
  def target(state, _actor_id, :extend_episode, payload) do
    with :ok <- Validation.exact_keys(payload, ["deadlineAtMs"]),
         deadline_at_ms when is_integer(deadline_at_ms) <- payload["deadlineAtMs"],
         true <- deadline_at_ms > state.deadline_at_ms do
      {:ok, "deadline_changed",
       %{
         "deadline_at_ms" => deadline_at_ms,
         "deadline_generation" => state.deadline_generation + 1
       }}
    else
      _ -> {:error, :invalid_state}
    end
  end

  def target(_state, _actor_id, _name, _payload), do: {:error, :unknown_command}

  defp hand_event_name(true), do: "hand_raised"
  defp hand_event_name(false), do: "hand_lowered"
end
