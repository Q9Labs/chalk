defmodule ChalkSync.ExternalOperationOrderingPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.ExternalOperationDispatchTestHelpers, as: Helpers
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    previous =
      for key <- [:stateholder, :database_connections],
          do: {key, Application.get_env(:chalk_sync, key)}

    connections = SyncPostgres.start_connections(@database_url, 8)
    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      for {key, value} <- previous do
        if value,
          do: Application.put_env(:chalk_sync, key, value),
          else: Application.delete_env(:chalk_sync, key)
      end

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections), early_connection: List.last(connections)}
  end

  test "an older Leave transaction cannot block actor work and Episode end", %{
    connection: connection,
    early_connection: early_connection
  } do
    seed = fixture(connection, 3)
    [actor, target, ender] = seed.identities
    parent = self()

    early_leave =
      Task.async(fn ->
        Postgrex.transaction(early_connection, fn transaction ->
          # Start this transaction before accepting the actor's publication change.
          %{rows: [[started]]} = Postgrex.query!(transaction, "select now()", [])
          Process.put(:sync_test_transaction, transaction)
          send(parent, {:early_transaction_started, started})
          receive do: (:accept_leave -> :ok)
          queue(actor, :participant_leave)
        end)
      end)

    assert_receive {:early_transaction_started, _started}, 2_000
    mute_id = queue(actor, :mute_participant, %{"participantId" => target.participant_id})
    send(early_leave.pid, :accept_leave)
    assert {:ok, leave_id} = Task.await(early_leave)
    expire_fences(connection, seed)
    _end_id = queue(ender, :end_episode)

    %{rows: [[true]]} =
      Postgrex.query!(
        connection,
        "select (select created_at from sync_external_operations where external_operation_id=$1) < (select created_at from sync_external_operations where external_operation_id=$2)",
        [UUID.dump!(leave_id), UUID.dump!(mute_id)]
      )

    drain_operations()
    assert_ended(connection, seed)
    assert_pending_count(connection, seed, 0)
  end

  test "a crash on claim 100 cannot block unrelated Leave and Episode end", %{
    connection: connection
  } do
    seed = fixture(connection, 4)
    [actor, target, leaver, ender] = seed.identities
    mute_id = queue(actor, :mute_participant, %{"participantId" => target.participant_id})
    _leave_id = queue(leaver, :participant_leave)

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99 where external_operation_id=$1",
      [UUID.dump!(mute_id)]
    )

    assert {:ok, [{_, claimed}]} = Postgres.claim_operations(1)
    assert claimed.external_operation_id == mute_id
    assert claimed.attempt_count == 100
    # Deterministic crash: do not execute/finalize this committed final claim.
    # Moving its lease into the past models restart after the lease expires.
    expire_fences(connection, seed)
    _end_id = queue(ender, :end_episode)

    drain_operations()
    assert_ended(connection, seed)
    # The existing exhausted operation remains pending for reconciliation;
    # it does not become a dependency of either healthy successor.
    assert_pending_count(connection, seed, 1)
  end

  test "one claimant retains the actor's accepted work, Leave and Episode end in order", %{
    connection: connection
  } do
    seed = fixture(connection, 3)
    [actor, target, ender] = seed.identities
    mute_id = queue(actor, :mute_participant, %{"participantId" => target.participant_id})
    leave_id = queue(actor, :participant_leave)
    expire_fences(connection, seed)
    end_id = queue(ender, :end_episode)

    assert {:ok, first_node} = Postgres.claim_operations(32)

    assert Enum.map(first_node, fn {_, operation} -> operation.external_operation_id end) ==
             [mute_id, leave_id, end_id]

    # Splitting this batch lets another node finish Leave before the actor's
    # publication change, which would then fail its finalization authority check.
    assert {:ok, []} = Postgres.claim_operations(32)

    for {episode, operation} <- first_node do
      assert {:ok, _} =
               Postgres.finalize_operation(
                 episode,
                 operation.external_operation_id,
                 {:confirmed, :provider}
               )
    end

    assert_ended(connection, seed)
    assert_pending_count(connection, seed, 0)
  end

  test "runtime table grants can allocate acceptance order without sequence privileges", %{
    connection: connection
  } do
    seed = fixture(connection, 2)
    [actor, target] = seed.identities
    source_id = queue(actor, :mute_participant, %{"participantId" => target.participant_id})
    role = "leave_order_" <> String.replace(UUID.generate(), "-", "")

    assert {:error, :verified} =
             Postgrex.transaction(connection, fn transaction ->
               Postgrex.query!(transaction, "create role #{role}", [])
               Postgrex.query!(transaction, "grant usage on schema public to #{role}", [])

               Postgrex.query!(
                 transaction,
                 "grant select, insert on sync_external_operations to #{role}",
                 []
               )

               Postgrex.query!(transaction, "set local role #{role}", [])

               %{rows: [[order]]} =
                 Postgrex.query!(
                   transaction,
                   """
                   insert into sync_external_operations (
                     tenant_id, space_id, episode_id, external_operation_id, request_key,
                     request_fingerprint, operation_name, actor_participant_id, actor_generation,
                     target_participant_id, target_participant_generation, source, payload, fence_active
                   )
                   select tenant_id, space_id, episode_id, $2, $3,
                     request_fingerprint, operation_name, actor_participant_id, actor_generation,
                     target_participant_id, target_participant_generation, source, payload, fence_active
                   from sync_external_operations where external_operation_id = $1
                   returning acceptance_order
                   """,
                   [
                     UUID.dump!(source_id),
                     UUID.dump!(UUID.generate()),
                     "runtime_" <> UUID.generate()
                   ]
                 )

               assert is_integer(order) and order > 0
               Postgrex.rollback(transaction, :verified)
             end)
  end

  defp fixture(connection, count) do
    seed = Helpers.fixture(connection, count)

    on_exit(fn -> SyncPostgres.cleanup(connection, seed.episode) end)
    seed
  end

  defp queue(identity, name, payload \\ %{}), do: Helpers.queue(identity, name, payload)

  defp expire_fences(connection, seed), do: Helpers.expire_fences(connection, seed)

  defp drain_operations do
    for _ <- 1..3 do
      assert {:ok, operations} = Postgres.claim_operations(8)

      for {episode, operation} <- operations do
        assert {:ok, _} =
                 Postgres.finalize_operation(
                   episode,
                   operation.external_operation_id,
                   {:confirmed, :provider}
                 )
      end
    end
  end

  defp assert_pending_count(connection, seed, count),
    do: Helpers.assert_pending_count(connection, seed, count)

  defp assert_ended(connection, seed), do: Helpers.assert_ended(connection, seed)
end
