defmodule ChalkSync.Stateholder.Postgres.JoinSeats do
  @moduledoc """
  Pending -> joined only on explicit entry after Sync and SFU startup.
  Failed startup remains cancellable until then.
  The Episode authority lock serializes each transition with lifecycle events.
  Absence of a seat row retains the previous admission protocol during rollout.
  """

  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.UUID

  # Episode authority is always acquired before Episode, participant, and seat.
  def admit_entry(connection, identity, requested) do
    Transaction.configure(connection)
    Authority.lock_control(connection, identity.episode)
    policy = Authority.lock_episode(connection, identity.episode)

    participant =
      Authority.lock_participant(connection, identity.episode, identity.participant_id)

    if participant && participant.generation != identity.participant_generation do
      Postgrex.rollback(connection, {:error, :stale_participant_generation})
    end

    if policy.status == "active" && participant &&
         participant.status in ["joining", "active", "leaving"] do
      allocate_entry(connection, identity, requested)
    else
      # Recovery distinguishes expired admission from cancellation and departure.
      identity
    end
  end

  defp allocate_entry(connection, identity, requested) do
    validate_entry_dispatch(connection, identity, requested)
    params = Scope.participant(identity) ++ [identity.participant_generation]

    case Postgrex.query!(
           connection,
           """
           select issued_entry_generation from participant_join_seats
           where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4 and generation=$5
           for update
           """,
           params
         ).rows do
      [] ->
        identity

      [[issued]] ->
        generation =
          case requested do
            :new when issued < 9_007_199_254_740_991 ->
              [[next]] =
                Postgrex.query!(
                  connection,
                  """
                  update participant_join_seats set issued_entry_generation=issued_entry_generation+1,
                    issued_entry_expires_at=clock_timestamp()+interval '120 seconds'
                  where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4 and generation=$5
                  returning issued_entry_generation
                  """,
                  params
                ).rows

              next

            generation when is_integer(generation) and generation > 0 and generation <= issued ->
              generation

            _ ->
              Postgrex.rollback(connection, {:error, :invalid_admission_intent})
          end

        %{identity | entry_generation: generation}
    end
  end

  defp validate_entry_dispatch(connection, identity, :new) do
    case Postgrex.query!(
           connection,
           """
           select 1 from sync_external_operations
           where tenant_id=$1 and space_id=$2 and episode_id=$3 and target_participant_id=$4
             and target_participant_generation=$5 and operation_name='participant_leave'
             and status='pending' and attempt_count > 0 limit 1
           """,
           Scope.participant(identity) ++ [identity.participant_generation]
         ).rows do
      [] -> :ok
      _ -> Postgrex.rollback(connection, {:retryable, :admission_pending})
    end
  end

  defp validate_entry_dispatch(_connection, _identity, _generation), do: :ok

  def claim_entry(_connection, nil), do: :ok
  def claim_entry(_connection, %{entry_generation: nil}), do: :ok

  def claim_entry(connection, identity) do
    Authority.lock_participant(connection, identity.episode, identity.participant_id)

    params =
      Scope.participant(identity) ++ [identity.participant_generation, identity.entry_generation]

    case Postgrex.query!(
           connection,
           """
           select state, issued_entry_generation,
             confirmed_entry_generation >= $6 or issued_entry_expires_at > clock_timestamp()
           from participant_join_seats
           where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4 and generation=$5
           for update
           """,
           params
         ).rows do
      [["joined", issued, true]] when identity.entry_generation <= issued -> :ok
      [["joined", _issued, false]] -> Postgrex.rollback(connection, {:error, :entry_expired})
      _ -> Postgrex.rollback(connection, {:error, :invalid_admission_intent})
    end

    # The CAS and invalidation share the lifecycle transaction and authority lock.
    # A superseded operation's provider response may still arrive, but its durable
    # failed status and the completion SQL fence make that response harmless.
    Postgrex.query!(
      connection,
      """
      with claimed as (
        update participant_join_seats set confirmed_entry_generation=$6
        where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4
          and generation=$5 and state='joined'
          and confirmed_entry_generation < $6 and $6 <= issued_entry_generation
        returning participant_id
      ), superseded as (
        update sync_external_operations set status='failed', fence_active=false,
          last_error_code='participant_inactive', applied_event_id=null, applied_revision=null, completed_at=now()
        where tenant_id=$1 and space_id=$2 and episode_id=$3
          and target_participant_id in (select participant_id from claimed)
          and target_participant_generation=$5 and operation_name='participant_leave' and status='pending'
          and coalesce((payload->>'entryGeneration')::bigint,0) < $6
        returning external_operation_id
      ), unfenced as (
        delete from sync_publication_fences where tenant_id=$1 and space_id=$2 and episode_id=$3
          and external_operation_id in (select external_operation_id from superseded)
      ), rejected as (
        update sync_command_receipts set outcome='rejected', rejection_reason='external_operation_failed', completed_at=now()
        where tenant_id=$1 and episode_id=$3 and participant_id=$4 and outcome='pending'
          and external_operation_id in (select external_operation_id from superseded)
      )
      update participants set status='active', updated_at=now()
      where tenant_id=$1 and space_id=$2 and episode_id=$3 and id=$4 and generation=$5
        and status='leaving' and exists(select 1 from superseded)
      """,
      params
    )

    :ok
  end

  # Claiming a Leave blocks later admissions. A prior admission defers its
  # provider work until confirmation or the bounded entry lease expires.
  def prepare_leave(connection, episode, operation_id) do
    Transaction.configure(connection)
    Authority.lock_control(connection, episode)
    Authority.lock_episode(connection, episode)

    case Postgrex.query!(
           connection,
           """
           select operation.status,
             seat.issued_entry_generation > coalesce((operation.payload->>'entryGeneration')::bigint,0)
               and seat.issued_entry_expires_at > clock_timestamp()
           from sync_external_operations operation
           left join participant_join_seats seat
             on seat.tenant_id=operation.tenant_id and seat.space_id=operation.space_id
             and seat.episode_id=operation.episode_id and seat.participant_id=operation.target_participant_id
             and seat.generation=operation.target_participant_generation
           where operation.tenant_id=$1 and operation.space_id=$2 and operation.episode_id=$3
             and operation.external_operation_id=$4
           """,
           Scope.episode(episode) ++ [UUID.dump!(operation_id)]
         ).rows do
      [["pending", true]] -> :pending
      [["pending", _]] -> :ready
      _ -> :superseded
    end
  end

  def validate_leave(connection, identity, %{name: :participant_leave}) do
    params =
      Scope.participant(identity) ++
        [identity.participant_generation, identity.entry_generation || 0]

    case Postgrex.query!(
           connection,
           """
           select 1 from participant_join_seats
           where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4 and generation=$5
             and confirmed_entry_generation <> $6
           """,
           params
         ).rows do
      [] -> :ok
      _ -> {:error, :participant_inactive}
    end
  end

  def validate_leave(_connection, _identity, _operation), do: :ok

  def prepare(connection, episode, intent, identity) do
    if identity &&
         (intent.participant_id != identity.participant_id ||
            intent.participant_generation != identity.participant_generation) do
      Postgrex.rollback(connection, {:error, :stale_participant_generation})
    end

    cond do
      intent.name != "participant_joined" -> :ok
      intent.status == "pending" -> prepare_pending(connection, episode, intent, identity)
      identity && intent.status == "superseded" -> reaped_seat(connection, episode, intent)
      true -> :ok
    end
  end

  # The lifecycle consumer may already have expired this generation's lease.
  defp reaped_seat(connection, episode, intent) do
    case Postgrex.query!(
           connection,
           """
           select state from participant_join_seats
           where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4 and generation=$5
           """,
           Scope.episode(episode) ++
             [UUID.dump!(intent.participant_id), intent.participant_generation]
         ).rows do
      [["expired"]] -> :entry_expired
      _ -> :ok
    end
  end

  defp prepare_pending(connection, episode, intent, identity) do
    action = if is_nil(identity), do: "expire", else: "confirm"

    params =
      Scope.episode(episode) ++
        [UUID.dump!(intent.participant_id), intent.participant_generation, action]

    case Postgrex.query!(
           connection,
           "select transition_participant_join_seat($1,$2,$3,$4,$5,$6)",
           params
         ).rows do
      [[state]] when state in ["legacy", "joined"] -> :ok
      [["expired"]] when not is_nil(identity) -> :entry_expired
      [[state]] when state in ["cancelled", "expired", "left"] -> :expired
      [["pending"]] -> Postgrex.rollback(connection, {:retryable, :admission_pending})
      _ -> Postgrex.rollback(connection, {:error, :invalid_admission_intent})
    end
  end
end
