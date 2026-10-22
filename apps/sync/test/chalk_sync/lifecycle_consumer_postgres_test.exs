defmodule ChalkSync.LifecycleConsumerPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)

      Application.put_env(:chalk_sync, :stateholder, Postgres)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        Application.put_env(:chalk_sync, :stateholder, previous_stateholder)
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  for state <- ["pending", "cancelled", "expired"] do
    @seat_state state
    @tag :join_seat_retry
    test "retry from #{@seat_state} fences the previous Sync identity", %{
      connections: connections
    } do
      connection = hd(connections)
      fixture = managed_pending_join(connection)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

      case @seat_state do
        "cancelled" ->
          assert [["cancelled"]] = seat_transition(connection, fixture, "cancel")

        "expired" ->
          Postgrex.query!(
            connection,
            "update participant_join_seats set expires_at=now()-interval '1 second' where participant_id=$1",
            [UUID.dump!(fixture.identity.participant_id)]
          )

          assert [["expired"]] = seat_transition(connection, fixture, "expire")

        "pending" ->
          :ok
      end

      assert [["pending"]] = seat_transition(connection, fixture, "retry")

      assert {:error, :stale_participant_generation} =
               Postgres.confirm_admission(fixture.identity)

      assert [["joining", nil, generation]] =
               Postgrex.query!(
                 connection,
                 "select status, first_joined_at, generation from participants where id=$1",
                 [UUID.dump!(fixture.identity.participant_id)]
               ).rows

      assert generation > fixture.identity.participant_generation
      current = %{fixture.identity | participant_generation: generation}
      assert {:ok, %{result: :applied}} = Postgres.confirm_admission(current)
      assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)
    end
  end

  @tag :join_seat_retry
  test "retry renews both pending-seat deadlines without adding reservations", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    participant = [UUID.dump!(fixture.identity.participant_id)]

    reservations = fn ->
      Postgrex.query!(
        connection,
        "select snapshot_reserved_bytes,lifecycle_reserved_events,lifecycle_reserved_bytes,lifecycle_reserved_intents,lifecycle_reserved_intent_bytes from sync_episode_control where episode_id=$1",
        [UUID.dump!(fixture.episode.episode_id)]
      ).rows
    end

    before_retry = reservations.()

    Postgrex.query!(
      connection,
      "update participant_join_seats set expires_at=now()+interval '2 seconds' where participant_id=$1",
      participant
    )

    Postgrex.query!(
      connection,
      "update sync_lifecycle_intents set next_attempt_at=now()+interval '2 seconds' where participant_id=$1",
      participant
    )

    assert [["pending"]] = seat_transition(connection, fixture, "retry")

    assert [[true, true]] =
             Postgrex.query!(
               connection,
               """
               select s.expires_at between now()+interval '115 seconds' and now()+interval '2 minutes',
                 i.next_attempt_at=s.expires_at
               from participant_join_seats s join sync_lifecycle_intents i using(participant_id)
               where s.participant_id=$1 and i.intent_name='participant_joined'
               """,
               participant
             ).rows

    assert reservations.() == before_retry
  end

  defp managed_pending_join(connection) do
    fixture = SyncPostgres.seed_pending_join(connection)

    Postgrex.query!(
      connection,
      """
      insert into participant_join_seats(tenant_id,space_id,episode_id,participant_id,generation,state,expires_at)
      values($1,$2,$3,$4,1,'pending',now()+interval '2 minutes')
      """,
      Scope.participant(fixture.identity)
    )

    Postgrex.query!(
      connection,
      "update participants set media_connection_id='attempt-old' where id=$1",
      [UUID.dump!(fixture.identity.participant_id)]
    )

    fixture
  end

  defp seat_transition(connection, fixture, action) do
    Postgrex.query!(
      connection,
      "select transition_participant_join_seat($1,$2,$3,$4,1,$5,'attempt-old')",
      Scope.participant(fixture.identity) ++ [action]
    ).rows
  end

  test "records concurrent failures without losing attempts or overflowing the counter", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    first =
      Task.async(fn ->
        Process.put(:sync_test_node, :first)

        Postgres.record_lifecycle_failure(
          fixture.episode,
          fixture.lifecycle_intent_id,
          :dependency_unavailable
        )
      end)

    second =
      Task.async(fn ->
        Process.put(:sync_test_node, :second)

        Postgres.record_lifecycle_failure(
          fixture.episode,
          fixture.lifecycle_intent_id,
          :dependency_unavailable
        )
      end)

    assert :ok = Task.await(first)
    assert :ok = Task.await(second)
    assert ["pending", 2, "dependency_unavailable"] = intent_attempt(connection, fixture)

    Postgrex.query!(
      connection,
      "update sync_lifecycle_intents set attempt_count = 2147483647 where lifecycle_intent_id = $1",
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )

    assert :ok =
             Postgres.record_lifecycle_failure(
               fixture.episode,
               fixture.lifecycle_intent_id,
               :dependency_unavailable
             )

    assert ["pending", 2_147_483_647, "dependency_unavailable"] =
             intent_attempt(connection, fixture)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    assert ["applied", 2_147_483_647, nil] = intent_attempt(connection, fixture)
  end

  test "defers a full poison page until its durable retry deadline", %{connections: connections} do
    connection = hd(connections)
    poison = Enum.map(1..32, fn _index -> SyncPostgres.seed_pending_join(connection) end)

    on_exit(fn ->
      Enum.each(poison, &SyncPostgres.cleanup(connection, &1.episode))
    end)

    Enum.each(poison, fn fixture ->
      Postgrex.query!(
        connection,
        "update sync_lifecycle_intents set attempt_count = 9 where lifecycle_intent_id = $1",
        [UUID.dump!(fixture.lifecycle_intent_id)]
      )

      assert :ok =
               Postgres.record_lifecycle_failure(
                 fixture.episode,
                 fixture.lifecycle_intent_id,
                 :dependency_unavailable
               )
    end)

    assert {:ok, pending} = Postgres.pending_lifecycle_intents(32)

    for fixture <- poison do
      refute {fixture.episode, fixture.lifecycle_intent_id} in pending
    end
  end

  defp intent_attempt(connection, fixture) do
    connection
    |> Postgrex.query!(
      """
      select status, attempt_count, last_error_code
      from sync_lifecycle_intents
      where lifecycle_intent_id = $1
      """,
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )
    |> Map.fetch!(:rows)
    |> then(fn [attempt] -> attempt end)
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection), do: TestProcess.stop(connection)
end
