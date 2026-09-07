defmodule ChalkSync.Stateholder.Postgres.PublicationGrants do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.RoleTransitionSettlement
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.PublicationGrants, as: SQL
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.UUID

  @max_publication_grant_reservations 6_144
  @publication_operation_id ~r/\A[A-Za-z0-9_-]{16,128}\z/

  def reserve_transaction(connection, identity, operation_id, source) do
    Transaction.configure(connection)

    unless Regex.match?(@publication_operation_id, operation_id) do
      Postgrex.rollback(connection, {:error, :invalid_operation})
    end

    policy = Authority.lock_episode(connection, identity.episode)

    participant =
      Authority.lock_participant(
        connection,
        identity.episode,
        identity.participant_id
      )

    with :ok <-
           Authority.validate_operation_actor(
             identity,
             %{name: :participant_leave},
             policy,
             participant
           ),
         :ok <- validate_capability(policy, participant, source) do
      params = Scope.episode(identity.episode) ++ [operation_id]

      case Postgrex.query!(connection, SQL.select_publication_grant_reservation(), params).rows do
        [row] -> from_row(row)
        [] -> insert_publication_grant_reservation(connection, identity, operation_id, source)
      end
    else
      {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp validate_capability(_policy, participant, source) do
    capability = capability(source)
    allowed = participant.capabilities
    if capability in allowed, do: :ok, else: {:error, :capability_denied}
  end

  defp insert_publication_grant_reservation(connection, identity, operation_id, source) do
    participant_id = Scope.uuid(identity.participant_id)
    source_name = Atom.to_string(source)

    fence_params = [
      Scope.uuid(identity.episode.tenant_id),
      Scope.uuid(identity.episode.episode_id),
      participant_id,
      identity.participant_generation,
      source_name
    ]

    case Postgrex.query!(connection, SQL.publication_fence(), fence_params).rows do
      [] -> :ok
      [_row] -> Postgrex.rollback(connection, {:error, :publication_fenced})
    end

    case Postgrex.query!(
           connection,
           SQL.count_publication_grant_reservations(),
           Scope.episode(identity.episode)
         ).rows do
      [[count]] when count < @max_publication_grant_reservations -> :ok
      _ -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    reservation_id = UUID.generate()

    params =
      Scope.episode(identity.episode) ++
        [
          Scope.uuid(reservation_id),
          operation_id,
          participant_id,
          identity.participant_generation,
          source_name
        ]

    case Postgrex.query!(connection, SQL.insert_publication_grant_reservation(), params).rows do
      [row] -> from_row(row)
      [] -> Postgrex.rollback(connection, {:error, :publication_in_progress})
    end
  end

  def complete_transaction(connection, episode, reservation_id, outcome) do
    Transaction.configure(connection)
    policy = Authority.lock_episode(connection, episode)
    params = Scope.episode(episode) ++ [Scope.uuid(reservation_id)]
    observed = read_publication_reservation!(connection, params)
    participant = lock_grant_participant!(connection, episode, observed)
    reservation = lock_publication_reservation!(connection, params)

    reservation = persist_publication_grant_outcome(connection, episode, reservation, outcome)

    cleanup_required =
      publication_cleanup_required?(connection, episode, policy, participant, reservation)

    if reservation.status == :failed and cleanup_required do
      satisfy_failed_grant_child(connection, episode, reservation)
    end

    Map.put(reservation, :result, if(cleanup_required, do: :cleanup_required, else: :authorized))
  end

  defp read_publication_reservation!(connection, params) do
    case Postgrex.query!(connection, SQL.read_publication_grant_reservation(), params).rows do
      [row] -> from_row(row)
      [] -> Postgrex.rollback(connection, {:error, :reservation_not_found})
    end
  end

  defp lock_grant_participant!(connection, episode, reservation) do
    participant =
      Authority.lock_participant(connection, episode, reservation.participant_id)

    if participant && participant.generation == reservation.participant_generation,
      do: participant,
      else: Postgrex.rollback(connection, {:error, :participant_inactive})
  end

  defp lock_publication_reservation!(connection, params) do
    case Postgrex.query!(connection, SQL.lock_publication_grant_reservation(), params).rows do
      [row] -> from_row(row)
      [] -> Postgrex.rollback(connection, {:error, :reservation_not_found})
    end
  end

  defp persist_publication_grant_outcome(
         _connection,
         _episode,
         %{status: status} = reservation,
         _outcome
       )
       when status in [:confirmed, :failed],
       do: reservation

  defp persist_publication_grant_outcome(connection, episode, reservation, outcome) do
    {status, failure_code} = publication_grant_outcome(outcome)

    params =
      Scope.episode(episode) ++ [Scope.uuid(reservation.reservation_id), status, failure_code]

    case Postgrex.query!(connection, SQL.complete_publication_grant_reservation(), params).rows do
      [row] -> from_row(row)
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp publication_grant_outcome(outcome) when outcome in [:confirmed, :satisfied],
    do: {"confirmed", nil}

  defp publication_grant_outcome({:terminal_failure, reason}) when is_atom(reason),
    do: {"failed", Atom.to_string(reason)}

  defp publication_grant_outcome(_outcome), do: {"ambiguous", nil}

  defp publication_cleanup_required?(connection, episode, _policy, participant, reservation) do
    capability_denied =
      capability(reservation.source) not in participant.capabilities

    fence_params = [
      Scope.uuid(episode.tenant_id),
      Scope.uuid(episode.episode_id),
      Scope.uuid(reservation.participant_id),
      reservation.participant_generation,
      Atom.to_string(reservation.source)
    ]

    capability_denied or
      Postgrex.query!(connection, SQL.publication_fence(), fence_params).rows != []
  end

  defp satisfy_failed_grant_child(connection, episode, reservation) do
    params =
      Scope.episode(episode) ++
        [
          Scope.uuid(reservation.participant_id),
          reservation.participant_generation,
          Atom.to_string(reservation.source)
        ]

    case Postgrex.query!(connection, SQL.pending_role_transition_child_for_source(), params).rows do
      [[child_id]] ->
        RoleTransitionSettlement.settle_child(connection, episode, UUID.load!(child_id), :applied)

      [] ->
        :ok
    end
  end

  def capability(:microphone), do: "publishAudio"
  def capability(:camera), do: "publishVideo"
  def capability(:screen), do: "publishScreen"

  def from_row([
        reservation_id,
        operation_id,
        participant_id,
        generation,
        source,
        status,
        failure_code,
        expires_at
      ]) do
    %{
      reservation_id: UUID.load!(reservation_id),
      operation_id: operation_id,
      participant_id: UUID.load!(participant_id),
      participant_generation: generation,
      source: String.to_existing_atom(source),
      status: String.to_existing_atom(status),
      failure_code: failure_code,
      expires_at: expires_at
    }
  end
end
