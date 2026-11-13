defmodule ChalkSync.Stateholder.Postgres.RoleTransitionPlanner do
  @moduledoc false

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.CommandDecision
  alias ChalkSync.Stateholder.Postgres.CommandPersistence
  alias ChalkSync.Stateholder.Postgres.PublicationGrants
  alias ChalkSync.Stateholder.Postgres.RoleTransitionPlanner.Persist
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.RoleTransitionPlanner, as: SQL
  alias ChalkSync.Stateholder.Postgres.Transaction

  def transaction(connection, identity, command, publications) do
    Transaction.configure(connection)
    {control, episode_policy, actor} = Authority.lock_command(connection, identity)

    case Authority.fetch_command_receipt(connection, identity, command) do
      {:ok, row} ->
        CommandDecision.from_receipt(command, row)

      :not_found ->
        with {:ok, state} <-
               Authority.validate_command(identity, command, control, episode_policy, actor),
             {:ok, affected} <-
               lock_role_transition_participants(connection, identity, command, actor),
             decision <-
               Reducer.decide_command(
                 state,
                 identity.participant_id,
                 command.name,
                 command.payload
               ) do
          decide_role_transition(
            connection,
            identity,
            command,
            episode_policy,
            affected,
            publications,
            decision
          )
        else
          {:error, reason} ->
            CommandPersistence.reject(
              connection,
              identity,
              command,
              CommandDecision.terminal_reason(reason)
            )
        end
    end
  end

  defp lock_role_transition_participants(
         connection,
         identity,
         %{name: :assign_roles} = command,
         _actor
       ) do
    target_id = command.payload["participantId"]

    case Authority.lock_participant(connection, identity.episode, target_id) do
      %{status: "active"} = target ->
        {:ok, Map.merge(target, %{id: target_id, next_role: command.payload["role"]})}

      _ ->
        {:error, :invalid_target}
    end
  end

  defp decide_role_transition(
         connection,
         identity,
         command,
         _policy,
         _affected,
         _publications,
         {:satisfied, state}
       ),
       do: CommandPersistence.satisfy(connection, identity, command, state)

  defp decide_role_transition(
         connection,
         identity,
         command,
         _policy,
         _affected,
         _publications,
         {:error, reason}
       ),
       do:
         CommandPersistence.reject(
           connection,
           identity,
           command,
           CommandDecision.terminal_reason(reason)
         )

  defp decide_role_transition(
         connection,
         identity,
         command,
         policy,
         affected,
         publications,
         {:change, event, next_state}
       ) do
    lost_sources = lost_publication_sources(policy, affected.role, affected.next_role)
    reservations = lock_publication_reservations(connection, identity.episode, affected)

    exercised_sources =
      lost_sources
      |> Enum.filter(&observed_enabled?(publications, affected.id, &1))
      |> Kernel.++(
        Enum.flat_map(reservations, fn reservation ->
          if reservation.source in lost_sources, do: [reservation.source], else: []
        end)
      )
      |> Enum.uniq()
      |> Enum.sort()

    if exercised_sources == [] do
      CommandPersistence.commit(connection, identity, command, event, next_state)
    else
      Persist.persist_pending_role_transition(
        connection,
        identity,
        command,
        event,
        next_state,
        affected,
        exercised_sources
      )
    end
  end

  defp lock_publication_reservations(connection, episode, affected) do
    params = Scope.episode(episode) ++ [Scope.uuid(affected.id), affected.generation]

    Postgrex.query!(connection, SQL.lock_active_publication_reservations(), params).rows
    |> Enum.map(&PublicationGrants.from_row/1)
  end

  defp lost_publication_sources(policy, old_role, new_role) do
    old = Map.get(policy.role_capabilities, old_role, [])
    new = Map.get(policy.role_capabilities, new_role, [])

    [:microphone, :camera, :screen]
    |> Enum.filter(fn source ->
      capability = PublicationGrants.capability(source)
      capability in old and capability not in new
    end)
  end

  defp observed_enabled?(publications, participant_id, source) do
    Enum.any?(publications, fn publication ->
      Map.get(publication, :participant_id) == participant_id and
        Map.get(publication, :source) == source and Map.get(publication, :enabled) == true
    end)
  end
end
