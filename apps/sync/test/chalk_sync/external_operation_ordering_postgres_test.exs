defmodule ChalkSync.ExternalOperationOrderingPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.fetch_env!("CHALK_SYNC_TEST_DATABASE_URL")

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

  defp fixture(connection, count) do
    seed =
      SyncPostgres.seed_episode(connection, count, %{}, %{
        participants: List.duplicate(%{role: "owner"}, count)
      })

    on_exit(fn -> SyncPostgres.cleanup(connection, seed.episode) end)
    seed
  end

  defp queue(identity, name, payload \\ %{}) do
    {:ok, operation} = Operation.new("judge_" <> UUID.generate(), name, payload)
    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(identity, operation)
    assert is_binary(id)
    id
  end

  defp expire_fences(connection, seed) do
    Postgrex.query!(
      connection,
      "update sync_publication_fences set created_at=now()-interval '2 hours', expires_at=now()-interval '1 hour' where episode_id=$1",
      [UUID.dump!(seed.episode.episode_id)]
    )

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now()-interval '1 hour' where episode_id=$1",
      [UUID.dump!(seed.episode.episode_id)]
    )
  end

  defp drain_operations do
    assert {:ok, operations} = Postgres.claim_operations(8)
    refute operations == []

    for {episode, operation} <- operations do
      assert {:ok, _} =
               Postgres.finalize_operation(
                 episode,
                 operation.external_operation_id,
                 {:confirmed, :provider}
               )
    end
  end

  defp assert_pending_count(connection, seed, count) do
    %{rows: [[^count]]} =
      Postgrex.query!(
        connection,
        "select count(*) from sync_external_operations where episode_id=$1 and status='pending'",
        [UUID.dump!(seed.episode.episode_id)]
      )
  end

  defp assert_ended(connection, seed) do
    %{rows: [["ended"]]} =
      Postgrex.query!(connection, "select status from episodes where id=$1", [
        UUID.dump!(seed.episode.episode_id)
      ])

    %{rows: [[1]]} =
      Postgrex.query!(
        connection,
        "select count(*) from sync_control_events where episode_id=$1 and event_name='participant_left'",
        [UUID.dump!(seed.episode.episode_id)]
      )

    assert {:ok, []} = Postgres.claim_operations(8)
  end
end
