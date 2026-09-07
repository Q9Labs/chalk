defmodule ChalkSync.Stateholder.Postgres.Authority do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.Authority, as: SQL
  alias ChalkSync.Stateholder.Postgres.SQL.Command, as: CommandSQL

  def lock_control(connection, episode) do
    case Postgrex.query!(connection, SQL.lock_control(), Scope.episode(episode)).rows do
      [row] -> Control.from_row(row)
      [] -> Postgrex.rollback(connection, {:error, :episode_not_found})
    end
  end

  def lock_episode(connection, episode) do
    case Postgrex.query!(connection, SQL.lock_operation_episode(), Scope.episode(episode)).rows do
      [
        [
          status,
          config_snapshot,
          deadline_at,
          deadline_generation,
          created_at
        ]
      ] ->
        snapshot = if is_map(config_snapshot), do: config_snapshot, else: %{}

        role_capabilities =
          Map.get(snapshot, "roles", Map.get(snapshot, "role_capabilities", %{}))

        %{
          status: status,
          role_capabilities: role_capabilities,
          deadline_at: deadline_at,
          deadline_generation: deadline_generation,
          maximum_duration_ceiling_seconds:
            Map.get(snapshot, "maximum_episode_duration_seconds", 2_592_000),
          created_at: created_at
        }

      [] ->
        Postgrex.rollback(connection, {:error, :episode_not_found})
    end
  end

  def lock_participant(connection, episode, participant_id) do
    case Postgrex.query!(
           connection,
           SQL.lock_participant(),
           Scope.episode(episode) ++ [Scope.uuid(participant_id)]
         ).rows do
      [[generation, status, role, capabilities]] ->
        %{
          id: participant_id,
          generation: generation,
          status: status,
          role: role,
          capabilities: capabilities
        }

      [] ->
        nil
    end
  end

  def validate_operation_actor(_identity, _operation, %{status: status}, _participant)
      when status != "active",
      do: {:error, :episode_ended}

  def validate_operation_actor(_identity, _operation, _policy, nil),
    do: {:error, :participant_inactive}

  def validate_operation_actor(identity, _operation, _policy, participant)
      when participant.generation != identity.participant_generation,
      do: {:error, :stale_participant_generation}

  def validate_operation_actor(_identity, _operation, _policy, %{status: status})
      when status != "active",
      do: {:error, :participant_inactive}

  def validate_operation_actor(_identity, %{name: :participant_leave}, _policy, _participant),
    do: :ok

  def validate_operation_actor(_identity, operation, _policy, participant) do
    required = required_capability(operation.name)
    allowed = participant.capabilities
    if required in allowed, do: :ok, else: {:error, :capability_denied}
  end

  def lock_command(connection, identity) do
    episode_params = Scope.episode(identity.episode)

    control =
      case Postgrex.query!(connection, SQL.lock_control(), episode_params).rows do
        [row] -> Control.from_row(row)
        [] -> Postgrex.rollback(connection, {:retryable, :dependency_unavailable})
      end

    episode_policy =
      case Postgrex.query!(connection, SQL.lock_episode(), episode_params).rows do
        [[status, config_snapshot, deadline_at, deadline_generation, created_at]] ->
          snapshot = if is_map(config_snapshot), do: config_snapshot, else: %{}

          %{
            status: status,
            role_capabilities:
              Map.get(snapshot, "roles", Map.get(snapshot, "role_capabilities", %{})),
            deadline_at: deadline_at,
            deadline_generation: deadline_generation,
            created_at: created_at
          }

        [] ->
          Postgrex.rollback(connection, {:retryable, :dependency_unavailable})
      end

    participant =
      case Postgrex.query!(connection, SQL.lock_participant(), Scope.participant(identity)).rows do
        [[generation, status, role, capabilities]] ->
          %{generation: generation, status: status, role: role, capabilities: capabilities}

        [] ->
          nil
      end

    {control, episode_policy, participant}
  end

  def fetch_command_receipt(connection, identity, command) do
    case Postgrex.query!(
           connection,
           CommandSQL.select_receipt(),
           Scope.receipt(identity, command)
         ).rows do
      [row] -> {:ok, row}
      [] -> :not_found
    end
  end

  defp validate_product_state(_identity, _command, %{status: status}, _participant)
       when status != "active",
       do: {:error, :episode_ended}

  defp validate_product_state(_identity, _command, _episode_status, nil),
    do: {:error, :participant_inactive}

  defp validate_product_state(identity, _command, _episode_status, participant)
       when participant.generation != identity.participant_generation,
       do: {:error, :stale_participant_generation}

  defp validate_product_state(_identity, _command, _episode_status, participant)
       when participant.status != "active",
       do: {:error, :participant_inactive}

  defp validate_product_state(_identity, command, _episode_policy, participant) do
    capability = required_capability(command.name)
    allowed = participant.capabilities

    if capability in allowed, do: :ok, else: {:error, :capability_denied}
  end

  defp validate_command_authority(_identity, _command, _state), do: :ok

  defp required_capability(:set_hand_raised),
    do: "raiseHand"

  defp required_capability(:set_display_name), do: "renameSelf"
  defp required_capability(:set_admission_policy), do: "manageAdmission"
  defp required_capability(:assign_roles), do: "assignRoles"

  defp required_capability(name) when name in [:admit_participant, :deny_admission],
    do: "manageAdmission"

  defp required_capability(:mute_participant), do: "muteOthers"
  defp required_capability(:stop_participant_camera), do: "stopVideoOthers"
  defp required_capability(:stop_participant_screen_share), do: "stopScreenOthers"
  defp required_capability(:remove_participant), do: "removeParticipant"

  defp required_capability(name) when name in [:start_recording, :stop_recording],
    do: "manageRecording"

  defp required_capability(:participant_leave), do: "self"
  defp required_capability(:end_episode), do: "endEpisode"

  def validate_command(identity, command, control, episode_policy, participant) do
    with :ok <- validate_product_state(identity, command, episode_policy, participant),
         {:ok, state} <- Control.validate_fold(identity.episode, control, episode_policy),
         :ok <- validate_command_authority(identity, command, state) do
      {:ok, state}
    end
  end
end
