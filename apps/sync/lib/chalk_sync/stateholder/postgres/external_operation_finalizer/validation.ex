defmodule ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Validation do
  @moduledoc """
  Locks and authority checks before an external operation is finalized.
  """

  alias ChalkSync.Stateholder.OperationTable
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: SQL
  require OperationTable

  def stale_maximum_duration?(%{name: :maximum_duration_expired} = external, policy) do
    external.deadline_generation != policy.deadline_generation ||
      DateTime.compare(policy.deadline_at, DateTime.utc_now()) == :gt
  end

  def stale_maximum_duration?(_external, _policy), do: false

  def lock_external_operation(connection, episode, external_operation_id) do
    params = Scope.episode(episode) ++ [Scope.uuid(external_operation_id)]

    case Postgrex.query!(connection, SQL.lock_operation(), params).rows do
      [row] -> ExternalOperationRecord.from_row(row)
      [] -> Postgrex.rollback(connection, {:error, :operation_not_found})
    end
  end

  def validate_finalization_authority(connection, episode, external, policy) do
    with :ok <- validate_finalization_episode(external, policy),
         :ok <- validate_finalization_target(connection, episode, external) do
      validate_finalization_deadline(external, policy)
    end
  end

  defp validate_finalization_episode(%{name: name}, %{status: "ending"})
       when OperationTable.is_episode_end_name(name),
       do: :ok

  defp validate_finalization_episode(%{name: :recording_capture_stopped}, %{status: status})
       when status in ["active", "ending", "ended"],
       do: :ok

  defp validate_finalization_episode(%{name: name}, %{status: "active"})
       when not OperationTable.is_episode_end_name(name),
       do: :ok

  defp validate_finalization_episode(_external, _policy), do: {:error, :episode_ended}

  defp validate_finalization_target(_connection, _episode, %{target_participant_id: nil}),
    do: :ok

  defp validate_finalization_target(connection, episode, external) do
    generation = external.target_participant_generation

    case Authority.lock_participant(connection, episode, external.target_participant_id) do
      %{generation: ^generation, status: status}
      when status in ["active", "leaving", "joining"] ->
        :ok

      %{generation: _other} ->
        {:error, :stale_participant_generation}

      _ ->
        {:error, :participant_inactive}
    end
  end

  defp validate_finalization_deadline(
         %{name: :tenant_set_deadline, deadline_generation: generation},
         policy
       ) do
    if generation == policy.deadline_generation + 1,
      do: :ok,
      else: {:error, :stale_deadline_generation}
  end

  defp validate_finalization_deadline(
         %{name: :maximum_duration_expired, deadline_generation: generation},
         policy
       ) do
    cond do
      generation != policy.deadline_generation ->
        {:error, :stale_deadline_generation}

      DateTime.compare(policy.deadline_at, DateTime.utc_now()) == :gt ->
        {:error, :stale_deadline_generation}

      true ->
        :ok
    end
  end

  defp validate_finalization_deadline(_external, _policy), do: :ok
end
