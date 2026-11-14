defmodule ChalkSync.Stateholder.Postgres.JoinSeats.Admit do
  @moduledoc """
  Admits a socket entry: finds or issues its seat generation and remembers the device.
  """

  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.Presence
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.Telemetry

  # Episode authority is always acquired before Episode, participant, and seat.
  def admit_entry(connection, identity, requested) do
    {identity, requested} =
      stage(:admit_configure, fn ->
        socket_request(identity, requested, Transaction.configure(connection))
      end)

    {policy, participant} =
      stage(:admit_locks, fn ->
        Authority.lock_control(connection, identity.episode)
        policy = Authority.lock_episode(connection, identity.episode)

        participant =
          Authority.lock_participant(connection, identity.episode, identity.participant_id)

        {policy, participant}
      end)

    if participant && participant.generation != identity.participant_generation do
      Postgrex.rollback(connection, {:error, :stale_participant_generation})
    end

    if policy.status == "active" && participant &&
         participant.status in ["joining", "active", "leaving"] do
      admitted =
        stage(:admit_seat, fn ->
          ensure_seat(connection, identity, participant.status)
          reconcile_applied_join(connection, identity)

          allocate_requested_entry(
            connection,
            %{identity | identity_id: participant.identity_id},
            requested
          )
        end)

      stage(:admit_presence, fn ->
        remember_device(connection, admitted)
        Presence.renew(connection, admitted)
      end)

      admitted
    else
      # Recovery distinguishes expired admission from cancellation and departure.
      identity
    end
  end

  defp stage(name, fun), do: Telemetry.timed([:entry, :stage], name, fun)

  defp remember_device(connection, identity) do
    Postgrex.query!(
      connection,
      """
      insert into participant_device_hints
        (tenant_id, space_id, episode_id, participant_id, generation, device_type)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (participant_id) do update
        set generation=excluded.generation, device_type=excluded.device_type
      """,
      Scope.participant(identity) ++ [identity.participant_generation, identity.device_type]
    )
  end

  defp socket_request(identity, {:socket, requested}, enforced) do
    mode = if enforced, do: :enforced, else: :compatibility
    {%{identity | entry_ownership: mode}, requested}
  end

  defp socket_request(identity, requested, _enforced),
    do: {%{identity | entry_ownership: nil}, requested}

  defp allocate_requested_entry(
         _connection,
         %{entry_ownership: :compatibility} = identity,
         _requested
       ),
       do: %{identity | entry_generation: nil}

  defp allocate_requested_entry(connection, identity, generation),
    do: allocate_entry(connection, identity, normalize(generation))

  defp normalize(:legacy), do: :new
  defp normalize(generation), do: generation

  # The old writer can have applied this join without updating its pending seat.
  # Participant and applied intent are authoritative, including after lease expiry.
  def reconcile_applied_join(connection, identity) do
    Postgrex.query!(
      connection,
      """
      update participant_join_seats seat
      set state='joined', generation=p.generation,
        issued_entry_generation=case when seat.generation=p.generation then seat.issued_entry_generation else 0 end,
        confirmed_entry_generation=case when seat.generation=p.generation then seat.confirmed_entry_generation else 0 end,
        issued_entry_expires_at=clock_timestamp()+interval '120 seconds', updated_at=now()
      from participants p join sync_lifecycle_intents intent
        on intent.participant_id=p.id and intent.participant_generation=p.generation
      where p.tenant_id=$1 and p.space_id=$2 and p.episode_id=$3 and p.id=$4 and p.generation=$5
        and p.status in ('active','leaving') and ($6::uuid is null or intent.lifecycle_intent_id=$6)
        and intent.intent_name='participant_joined' and intent.status='applied'
        and seat.participant_id=p.id and seat.generation <= p.generation
        and (seat.generation < p.generation or seat.state <> 'joined')
      """,
      Scope.participant(identity) ++
        [
          identity.participant_generation,
          Scope.nullable_dump(identity.admission_lifecycle_intent_id)
        ]
    )

    :ok
  end

  defp ensure_seat(connection, identity, status) do
    Postgrex.query!(
      connection,
      """
      insert into participant_join_seats
        (tenant_id,space_id,episode_id,participant_id,generation,state,expires_at)
      values ($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '120 seconds')
      on conflict (participant_id) do nothing
      """,
      Scope.participant(identity) ++
        [identity.participant_generation, if(status == "joining", do: "pending", else: "joined")]
    )
  end

  defp allocate_entry(connection, identity, requested) do
    validate_entry_dispatch(connection, identity, requested)
    params = Scope.participant(identity) ++ [identity.participant_generation]

    case issue_new_generation(connection, params, requested) do
      generation when is_integer(generation) ->
        %{identity | entry_generation: generation}

      nil ->
        existing_entry(connection, identity, params, requested)
    end
  end

  # A new entry bumps the seat in one statement, which also takes the row lock.
  defp issue_new_generation(connection, params, :new) do
    case Postgrex.query!(
           connection,
           """
           update participant_join_seats set issued_entry_generation=issued_entry_generation+1,
             issued_entry_expires_at=clock_timestamp()+interval '120 seconds'
           where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4 and generation=$5
             and issued_entry_generation < 9007199254740991
           returning issued_entry_generation
           """,
           params
         ).rows do
      [[next]] -> next
      [] -> nil
    end
  end

  defp issue_new_generation(_connection, _params, _requested), do: nil

  defp existing_entry(connection, identity, params, requested) do
    case Postgrex.query!(
           connection,
           """
           select issued_entry_generation from participant_join_seats
           where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4 and generation=$5
           for update
           """,
           params
         ).rows do
      [[issued]] when is_integer(requested) and requested > 0 and requested <= issued ->
        %{identity | entry_generation: requested}

      _missing_or_not_issued ->
        Postgrex.rollback(connection, {:error, :invalid_admission_intent})
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
end
