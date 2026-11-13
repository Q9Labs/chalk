defmodule ChalkSync.LifecycleConsumerJoinSeatRetryPostgresTest do
  use ChalkSync.ServerCase, async: false
  use ChalkSync.LifecycleConsumerCase

  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @entry_path "/v1/sync?entry_confirmation=1&entry_generation=new"

  @tag :join_seat_retry
  test "a completed reentry fences an older entry's delayed Leave", %{connections: connections} do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    first = entry_identity(fixture.identity, 1, "first-entry")
    current = entry_identity(fixture.identity, 2, "current-entry")

    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)

    {:ok, stale_leave} = Operation.new("stale_entry_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :rejected, reason: :participant_inactive}} =
             Postgres.begin_operation(first, stale_leave)

    assert [["active", "joined", 2]] =
             Postgrex.query!(
               connection,
               "select p.status,s.state,s.confirmed_entry_generation from participants p join participant_join_seats s on s.participant_id=p.id where p.id=$1",
               [UUID.dump!(current.participant_id)]
             ).rows

    {:ok, current_leave} = Operation.new("current_entry_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :applied}} = Postgres.begin_operation(current, current_leave)
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

  @tag :entered_admission
  test "legacy pending admission can recover without confirming attendance", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, recovery} = Postgres.recover(fixture.identity, nil)
    refute recovery.mode == :terminal

    assert [["joining", false]] =
             Postgrex.query!(
               connection,
               "select status, first_joined_at is not null from participants where id=$1",
               [UUID.dump!(fixture.identity.participant_id)]
             ).rows
  end

  @tag :legacy_entry
  @tag :entered_admission
  test "a v1 client without entry confirmation confirms its seat and attendance on hello", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, client} = Client.connect(port, "/v1/sync")
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    refute Map.has_key?(welcome, "entry_confirmation")
    assert [["active", "joined", true]] = entry_row(connection, fixture)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence"}, _client} = Client.recv(client)
    assert [["active", "joined", true]] = entry_row(connection, fixture)
  end

  @tag :legacy_entry
  @tag :entered_admission
  test "entered on a socket that never negotiated entry confirmation is refused", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, client} = Client.connect(port, "/v1/sync")
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    refute Map.has_key?(welcome, "entry_confirmation")
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)
    client = Client.send_json(client, %{"type" => "entered"})

    assert {:json,
            %{
              "type" => "error",
              "code" => "protocol_error",
              "detail" => "entry_confirmation_not_negotiated"
            }, client} = Client.recv(client)

    client = Client.send_json(client, %{"type" => "ping"})
    assert {:json, %{"type" => "pong"}, _client} = Client.recv(client)
    assert [["active", "joined", true]] = entry_row(connection, fixture)
  end

  @tag :entered_admission
  test "entered immediately after recovery_complete is accepted on reconnect", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(fixture.identity)
    {:ok, client} = Client.connect(port, @entry_path)
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    client = Client.send_json(client, %{"type" => "entered"})
    receive_entered_ack(client)
    assert [["active", "joined", true]] = entry_row(connection, fixture)
  end
end
