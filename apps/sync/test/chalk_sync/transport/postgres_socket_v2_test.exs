defmodule ChalkSync.Transport.PostgresSocketV2Test do
  use ExUnit.Case, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Fanout.PostgresNotifications
  alias ChalkSync.LifecycleConsumer
  alias ChalkSync.Sessions.Coordinator
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client

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

  setup %{connections: connections} do
    fixture = SyncPostgres.seed_pending_join(hd(connections))

    listener =
      start_supervised!({Bandit, plug: ChalkSync.Transport.Router, ip: {127, 0, 0, 1}, port: 0})

    {:ok, {_ip, port}} = ThousandIsland.listener_info(listener)

    on_exit(fn -> SyncPostgres.cleanup(hd(connections), fixture.session) end)
    {:ok, fixture: fixture, port: port}
  end

  test "real wire applies admission, commits, reconnects, and survives socket loss", %{
    fixture: fixture,
    port: port
  } do
    {:ok, client} = Client.connect(port, "/v2/sync")
    client = Client.send_json(client, hello(fixture, nil))

    {:json, welcome, client} = Client.recv(client)
    assert %{"type" => "welcome", "mode" => "snapshot"} = welcome
    assert welcome["head"]["revision"] == 1

    assert welcome["snapshot"]["participants"] |> hd() |> Map.fetch!("display_name") ==
             "Pending Participant"

    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)

    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => "postgres-wire-cmd1",
        "name" => "raise_hand",
        "payload" => %{}
      })

    {:json, ack, client} = Client.recv(client)
    assert %{"type" => "ack", "result" => "committed", "revision" => 2} = ack
    {:json, event, client} = Client.recv(client)
    assert %{"type" => "event", "revision" => 2, "command_id" => "postgres-wire-cmd1"} = event

    cursor = %{
      "revision" => event["revision"],
      "state_schema_version" => event["schema_version"],
      "state_digest" => event["resulting_state_digest"]
    }

    _closed = Client.close_tcp(client)

    assert {:ok, authoritative} = Postgres.recover(fixture.identity, nil)
    assert authoritative.head.revision == 2
    assert hd(authoritative.snapshot["participants"])["hand_raised"]

    assert {:ok, lower} = Command.new("postgres-wire-cmd2", :lower_hand, %{})

    assert {:ok, %{result: :committed, revision: 3}} =
             Postgres.decide_command(fixture.identity, lower)

    {:ok, reconnected} = Client.connect(port, "/v2/sync")
    reconnected = Client.send_json(reconnected, hello(fixture, cursor))
    {:json, second_welcome, reconnected} = Client.recv(reconnected)
    assert second_welcome["mode"] == "replay"
    assert second_welcome["head"]["revision"] == 3

    assert {:json,
            %{"type" => "replay_page", "first_revision" => 3, "last_revision" => 3} =
              replay_page, reconnected} = Client.recv(reconnected)

    reconnected = Client.acknowledge_recovery(reconnected, replay_page)

    assert {:json, %{"type" => "recovery_complete", "head" => %{"revision" => 3}}, _reconnected} =
             Client.recv(reconnected)

    assert [["active", 1]] =
             fixture.session
             |> ChalkSync.Database.connection()
             |> Postgrex.query!(
               "select status, generation from participants where tenant_id = $1 and id = $2",
               [
                 ChalkSync.UUID.dump!(fixture.session.tenant_id),
                 ChalkSync.UUID.dump!(fixture.identity.participant_session_id)
               ]
             )
             |> Map.fetch!(:rows)
  end

  test "background consumer applies removal without any socket", %{
    fixture: fixture,
    connections: connections
  } do
    consumer_name = Module.concat(__MODULE__, "Consumer#{System.unique_integer([:positive])}")

    start_supervised!(
      {LifecycleConsumer, name: consumer_name, poll_interval_ms: 10, page_size: 8},
      id: consumer_name
    )

    eventually(fn -> participant_status(fixture) == "active" end)
    fixture = SyncPostgres.request_pending_leave(hd(connections), fixture)
    eventually(fn -> participant_status(fixture) == "left" end)

    assert {:ok, terminal} = Postgres.recover(fixture.identity, nil)
    assert terminal.mode == :terminal
    assert terminal.terminal_reason == :participant_inactive
    assert terminal.head.revision == 2

    health = LifecycleConsumer.health(consumer_name)
    assert health.applied_count >= 2
    assert health.consecutive_failures == 0
  end

  test "database notification repairs a coordinator that did not publish locally", %{
    fixture: fixture,
    connections: connections
  } do
    assert {:ok, %{result: :applied, revision: 1}} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert {:ok, recovery} = Postgres.recover(fixture.identity, nil)
    assert recovery.head.revision == 1
    assert {:ok, coordinator} = Coordinator.subscribe(fixture.identity, recovery.head, self())

    listener_name = Module.concat(__MODULE__, "Fanout#{System.unique_integer([:positive])}")

    start_supervised!(
      {PostgresNotifications, name: listener_name, url: @database_url},
      id: listener_name
    )

    assert {:ok, command} = Command.new("remote_node_cmd01", :raise_hand, %{})

    assert {:ok, %{result: :committed, revision: 2}} =
             Postgres.decide_command(fixture.identity, command)

    assert_receive {:sync_outbound_ready, ^coordinator}, 2_000
    assert {:ok, encoded, false} = Coordinator.pop(coordinator, self())

    assert %{"type" => "event", "revision" => 2, "command_id" => "remote_node_cmd01"} =
             JSON.decode!(encoded)

    Postgrex.query!(
      hd(connections),
      "select pg_notify('chalk_sync_heads', 'malformed-head')",
      []
    )

    eventually(fn -> PostgresNotifications.health(listener_name).received_count >= 1 end)
    eventually(fn -> PostgresNotifications.health(listener_name).malformed_count >= 1 end)
  end

  test "a real TCP peer that stops reading is bounded while a healthy peer advances", %{
    fixture: fixture
  } do
    listener =
      start_supervised!(
        {Bandit,
         plug: ChalkSync.Transport.Router,
         ip: {127, 0, 0, 1},
         port: 0,
         thousand_island_options: [
           transport_options: [sndbuf: 1_024, send_timeout: 10, send_timeout_close: true]
         ]},
        id: {:slow_tcp_listener, System.unique_integer([:positive])}
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(listener)
    {:ok, fast} = Client.connect(port, "/v2/sync")

    {:ok, slow} =
      Client.connect(port, "/v2/sync", transport_opts: [recbuf: 1_024, buffer: 1_024])

    on_exit(fn -> close_tcp(fast) end)
    on_exit(fn -> close_tcp(slow) end)

    fast = complete_hello(fast, fixture)
    slow = complete_hello(slow, fixture)
    :ok = :inet.setopts(Mint.HTTP.get_socket(slow.conn), active: false, recbuf: 1_024)

    coordinator = Coordinator.whereis(fixture.session)
    assert is_pid(coordinator)
    eventually(fn -> coordinator_socket_count(coordinator) == 2 end)

    {fast, dropped_at} =
      drive_fast_until_slow_peer_drops(fast, coordinator, fixture, 2, 258)

    assert dropped_at == 258

    {fast, final_revision} =
      Enum.reduce(1..20, {fast, dropped_at}, fn _offset, {client, revision} ->
        next_revision = revision + 1
        {publish_and_receive(client, fixture, next_revision), next_revision}
      end)

    assert coordinator_socket_count(coordinator) == 1
    assert final_revision == dropped_at + 20
    eventually(fn -> acknowledged_revision(coordinator) == final_revision end)
    _closed = Client.close_tcp(fast)
  end

  defp hello(fixture, cursor) do
    identity = fixture.identity

    token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.session.tenant_id,
        "room_id" => identity.session.room_id,
        "session_id" => identity.session.session_id,
        "participant_id" => identity.participant_session_id,
        "participant_session_id" => identity.participant_session_id,
        "participant_session_generation" => identity.participant_session_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "capabilities" => identity.capabilities,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    %{
      "type" => "hello",
      "protocol" => 2,
      "token" => token,
      "streams" => %{"control" => %{"cursor" => cursor}}
    }
  end

  defp participant_status(fixture) do
    fixture.session
    |> ChalkSync.Database.connection()
    |> Postgrex.query!(
      "select status from participants where tenant_id = $1 and id = $2",
      [
        ChalkSync.UUID.dump!(fixture.session.tenant_id),
        ChalkSync.UUID.dump!(fixture.identity.participant_session_id)
      ]
    )
    |> Map.fetch!(:rows)
    |> case do
      [[status]] -> status
      [] -> nil
    end
  end

  defp complete_hello(client, fixture) do
    client = Client.send_json(client, hello(fixture, nil))
    {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    client
  end

  defp drive_fast_until_slow_peer_drops(_client, _coordinator, _fixture, revision, maximum)
       when revision > maximum,
       do: flunk("slow TCP peer remained subscribed through revision #{maximum}")

  defp drive_fast_until_slow_peer_drops(client, coordinator, fixture, revision, maximum) do
    last_revision = min(revision + 127, maximum)

    Enum.each(revision..last_revision, fn next_revision ->
      assert :ok =
               Coordinator.publish(
                 fixture.session,
                 synthetic_large_event(fixture, next_revision)
               )
    end)

    client =
      Enum.reduce(revision..last_revision, client, fn expected_revision, current_client ->
        receive_event(current_client, expected_revision)
      end)

    eventually(fn -> acknowledged_revision(coordinator) == last_revision end)

    if coordinator_socket_count(coordinator) == 1 do
      {client, last_revision}
    else
      drive_fast_until_slow_peer_drops(
        client,
        coordinator,
        fixture,
        last_revision + 1,
        maximum
      )
    end
  end

  defp publish_and_receive(client, fixture, expected_revision) do
    assert :ok =
             Coordinator.publish(
               fixture.session,
               synthetic_large_event(fixture, expected_revision)
             )

    receive_event(client, expected_revision)
  end

  defp receive_event(client, expected_revision) do
    {:json,
     %{
       "type" => "event",
       "revision" => ^expected_revision,
       "resulting_state_digest" => state_digest
     }, client} =
      Client.recv(client, 5_000)

    Client.send_json(client, %{
      "type" => "delivery_ack",
      "stream" => "control",
      "revision" => expected_revision,
      "state_digest" => state_digest
    })
  end

  defp synthetic_large_event(fixture, revision) do
    %{
      event_id: ChalkSync.UUID.generate(),
      base_revision: revision - 1,
      revision: revision,
      name: "participant_joined",
      payload: %{
        "participant_session_id" => fixture.identity.participant_session_id,
        "display_name" => String.duplicate("x", 256)
      },
      command_id: nil,
      lifecycle_intent_id: ChalkSync.UUID.generate(),
      schema_version: 1,
      resulting_state_digest: :crypto.hash(:sha256, <<revision::unsigned-64>>)
    }
  end

  defp coordinator_socket_count(coordinator) do
    coordinator |> :sys.get_state() |> Map.fetch!(:sockets) |> map_size()
  catch
    :exit, _reason -> 0
  end

  defp acknowledged_revision(coordinator) do
    coordinator
    |> :sys.get_state()
    |> Map.fetch!(:sockets)
    |> Map.values()
    |> Enum.map(& &1.acknowledged_revision)
    |> Enum.max(fn -> 0 end)
  catch
    :exit, _reason -> 0
  end

  defp close_tcp(client) do
    _closed = Client.close_tcp(client)
    :ok
  rescue
    _exception -> :ok
  end

  defp eventually(assertion, attempts \\ 100)

  defp eventually(assertion, attempts) when attempts > 0 do
    if assertion.() do
      :ok
    else
      Process.sleep(10)
      eventually(assertion, attempts - 1)
    end
  end

  defp eventually(_assertion, 0), do: flunk("condition did not become true")

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
