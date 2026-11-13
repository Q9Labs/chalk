defmodule ChalkSync.LifecycleConsumerEnteredAdmissionPostgresTest do
  use ChalkSync.ServerCase, async: false
  use ChalkSync.LifecycleConsumerCase

  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @entry_path "/v1/sync?entry_confirmation=1&entry_generation=new"

  @tag :entry_timeout_trace
  @tag :entered_admission
  test "pending entry deadline evicts an expired socket and releases live capacity", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    handler = "entry-timeout-#{System.unique_integer([:positive])}"
    owner = self()

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _, _, metadata, _ ->
        if metadata.event == "sync.websocket.closed",
          do: send(owner, {:entry_closed, metadata.attributes})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
    {:ok, client} = Client.connect(port, @entry_path)
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)
    coordinator = Coordinator.whereis(fixture.episode)
    [socket] = coordinator |> :sys.get_state() |> Map.fetch!(:sockets) |> Map.keys()
    monitor = Process.monitor(coordinator)

    Postgrex.query!(
      connection,
      "update participant_join_seats set expires_at=now()-interval '1 second' where participant_id=$1",
      [UUID.dump!(fixture.identity.participant_id)]
    )

    assert [["expired"]] = seat_transition(connection, fixture, "expire")
    send(socket, :entry_timeout)
    assert {:closed, 1008, "entry timeout", _client} = Client.recv(client)
    assert_receive {:entry_closed, %{reason: :entry_timeout, close_code: 1008}}, 1_000
    assert_receive {:DOWN, ^monitor, :process, ^coordinator, _reason}, 2_000
    assert [["left", "expired", false]] = entry_row(connection, fixture)
  end

  for {case_name, reaped, close_reason, seat_state} <- [
        {"an expired lease", false, "entry timeout", "expired"},
        {"a lease the consumer already expired", true, "entry timeout", "expired"},
        {"a cancelled seat", nil, "policy violation", "cancelled"}
      ] do
    @case_name case_name
    @reaped reaped
    @close_reason close_reason
    @seat_state seat_state
    @tag :entered_admission
    test "entered after recovery on #{@case_name} closes with #{@close_reason}", %{
      connections: connections,
      port: port
    } do
      connection = hd(connections)
      fixture = managed_pending_join(connection)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      {:ok, client} = Client.connect(port, @entry_path)
      on_exit(fn -> Client.close_tcp(client) end)
      client = Client.send_json(client, hello(fixture.identity))
      assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
      client = Client.acknowledge_recovery(client, welcome)
      assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
      assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
      assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)

      if is_nil(@reaped) do
        assert [["cancelled"]] = seat_transition(connection, fixture, "cancel")
      else
        Postgrex.query!(
          connection,
          "update participant_join_seats set expires_at=now()-interval '1 second' where participant_id=$1",
          [UUID.dump!(fixture.identity.participant_id)]
        )

        if @reaped, do: assert([["expired"]] = seat_transition(connection, fixture, "expire"))
      end

      client = Client.send_json(client, %{"type" => "entered"})
      assert {:closed, 1008, @close_reason, _client} = Client.recv(client)
      assert [["left", @seat_state, false]] = entry_row(connection, fixture)
    end
  end

  for reaped <- [false, true] do
    @reaped reaped
    @tag :entered_admission
    test "reconnecting after the lease expired before entry closes as entry timeout (reaped: #{@reaped})",
         %{connections: connections, port: port} do
      connection = hd(connections)
      fixture = managed_pending_join(connection)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

      Postgrex.query!(
        connection,
        "update participant_join_seats set expires_at=now()-interval '1 second' where participant_id=$1",
        [UUID.dump!(fixture.identity.participant_id)]
      )

      if @reaped, do: assert([["expired"]] = seat_transition(connection, fixture, "expire"))
      {:ok, client} = Client.connect(port, @entry_path)
      on_exit(fn -> Client.close_tcp(client) end)
      client = Client.send_json(client, hello(fixture.identity))
      assert {:closed, 1008, "entry timeout", _client} = Client.recv(client)
    end
  end

  @tag :entered_admission
  test "entered from a retried seat's previous generation closes as rejected access", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, client} = Client.connect(port, @entry_path)
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
    assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)
    assert [["pending"]] = seat_transition(connection, fixture, "retry")
    client = Client.send_json(client, %{"type" => "entered"})
    assert {:closed, 1008, "invalid token", _client} = Client.recv(client)
    assert [["joining", "pending", false]] = entry_row(connection, fixture)
  end

  @tag :entered_admission
  test "hello is cancellable after Sync recovery without attendance, entered confirms exactly once",
       %{connections: connections, port: port} do
    connection = hd(connections)

    for entered <- [false, true] do
      fixture = managed_pending_join(connection)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      {:ok, client} = Client.connect(port, @entry_path)
      on_exit(fn -> Client.close_tcp(client) end)
      client = Client.send_json(client, hello(fixture.identity))

      assert {:json, %{"type" => "welcome", "entry_confirmation" => true} = welcome, client} =
               Client.recv(client)

      client = Client.acknowledge_recovery(client, welcome)
      assert {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
      assert {:json, %{"stream" => "media"}, client} = Client.recv(client)
      assert {:json, %{"stream" => "presence"}, client} = Client.recv(client)
      assert [["joining", "pending", false]] = entry_row(connection, fixture)

      if entered do
        client = Client.send_json(client, %{"type" => "entered"})
        client = receive_entered_ack(client)
        assert [["active", "joined", true]] = entry_row(connection, fixture)
        client = Client.send_json(client, %{"type" => "entered"})
        receive_entered_ack(client)

        assert [[1]] =
                 Postgrex.query!(
                   connection,
                   "select count(*) from sync_control_events where lifecycle_intent_id=$1",
                   [UUID.dump!(fixture.lifecycle_intent_id)]
                 ).rows
      else
        assert [["cancelled"]] = seat_transition(connection, fixture, "cancel")
        assert [["left", "cancelled", false]] = entry_row(connection, fixture)
      end
    end
  end

  @tag :entered_admission
  test "a stale-generation hello closes as rejected access rather than dependency outage", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert [["pending"]] = seat_transition(connection, fixture, "retry")
    {:ok, client} = Client.connect(port, @entry_path)
    on_exit(fn -> Client.close_tcp(client) end)
    client = Client.send_json(client, hello(fixture.identity))
    assert {:closed, 1008, _reason, _client} = Client.recv(client)
    assert [["joining", "pending", false]] = entry_row(connection, fixture)
  end
end
