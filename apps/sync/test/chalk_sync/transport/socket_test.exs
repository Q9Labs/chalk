defmodule ChalkSync.Transport.SocketTest do
  use ChalkSync.ServerCase, async: true

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Rooms.RoomServer
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.Transport.Router

  @observability_event [:chalk_sync, :observability, :event]

  test "healthz responds unversioned", %{port: port} do
    conn = Plug.Test.conn(:get, "/healthz")
    conn = Router.call(conn, [])
    assert conn.status == 200
    assert port > 0
  end

  test "readyz refuses the development in-memory authority", %{port: port} do
    conn = Plug.Test.conn(:get, "/readyz")
    conn = Router.call(conn, [])

    assert conn.status == 503
    assert %{"status" => status, "draining" => false} = JSON.decode!(conn.resp_body)
    assert status in ["initializing", "unready"]
    assert port > 0
  end

  test "metrics exposes bounded aggregate resources", %{port: port} do
    conn = Plug.Test.conn(:get, "/metrics")
    conn = Router.call(conn, [])

    assert conn.status == 200

    assert %{
             "metrics" => metrics,
             "resources" => %{
               "admitted_commands" => admitted,
               "local_session_coordinators" => coordinators
             }
           } = JSON.decode!(conn.resp_body)

    assert is_map(metrics)
    assert is_integer(admitted)
    assert is_integer(coordinators)
    assert port > 0
  end

  test "development lab is served by the sync server", %{port: port} do
    conn = Plug.Test.conn(:get, "/dev/lab")
    conn = Router.call(conn, [])

    assert conn.status == 200
    assert conn.resp_body =~ "Chalk Sync Lab"
    assert port > 0
  end

  test "development lab starts without seeded participants", %{port: port} do
    conn = Plug.Test.conn(:get, "/dev/lab/app.js")
    conn = Router.call(conn, [])

    assert conn.status == 200
    assert conn.resp_body =~ "participants: []"
    refute conn.resp_body =~ ~S|["Ada", "Bo", "Cora"].forEach(addParticipant)|
    assert port > 0
  end

  test "development trace socket streams server activity", %{port: port} do
    {:ok, trace_client} = Client.connect(port, "/dev/traces")
    {:json, %{"type" => "history"}, trace_client} = Client.recv(trace_client)

    room_id = unique_room_id()
    {:ok, sync_client} = Client.connect(port)
    sync_client = Client.send_json(sync_client, hello(room_id, "p1", "Trace Participant"))
    {:json, %{"type" => "welcome"}, sync_client} = Client.recv(sync_client)

    assert_trace_event(trace_client, "participant_joined", %{"room_id" => room_id})
    assert %Client{} = sync_client
  end

  test "development room restart stops the writer and its sockets", %{port: port} do
    room_id = unique_room_id()
    {:ok, room_pid, _reply} = RoomServer.join(room_id, "p1", "Ada", self())
    monitor_ref = Process.monitor(room_pid)

    conn = Plug.Test.conn(:post, "/dev/rooms/#{room_id}/restart")
    conn = Router.call(conn, [])

    assert conn.status == 202
    assert_receive {:DOWN, ^monitor_ref, :process, ^room_pid, :shutdown}
    assert port > 0
  end

  test "hello -> welcome snapshot -> command -> ack + fanout", %{port: port} do
    room_id = unique_room_id()

    {:ok, ada} = Client.connect(port)
    ada = Client.send_json(ada, hello(room_id, "p1", "Ada"))
    {:json, welcome, ada} = Client.recv(ada)

    assert %{"type" => "welcome", "mode" => "snapshot", "participant_id" => "p1"} = welcome
    assert welcome["snapshot"]["control_revision"] == 1
    ada_journey_id = welcome["journey_id"]

    {:ok, bo} = Client.connect(port)
    bo = Client.send_json(bo, hello(room_id, "p2", "Bo"))
    {:json, %{"type" => "welcome"} = bo_welcome, bo} = Client.recv(bo)
    bo_journey_id = bo_welcome["journey_id"]

    {:json, joined, ada} = Client.recv(ada)
    assert %{"type" => "event", "name" => "participant_joined", "revision" => 2} = joined
    assert joined["journey_id"] == bo_journey_id
    refute joined["journey_id"] == ada_journey_id

    bo =
      Client.send_json(bo, %{
        "type" => "command",
        "command_id" => "c-1",
        "name" => "raise_hand"
      })

    {:json, ack, _bo} = Client.recv(bo)
    assert %{"type" => "ack", "result" => "committed", "revision" => 3} = ack

    {:json, raised, _ada} = Client.recv(ada)

    assert %{
             "type" => "event",
             "name" => "hand_raised",
             "base_revision" => 2,
             "revision" => 3,
             "payload" => %{"participant_id" => "p2"}
           } = raised

    assert raised["journey_id"] == bo_journey_id
  end

  test "reconnect with a cursor gets replay, not snapshot", %{port: port} do
    room_id = unique_room_id()

    {:ok, first} = Client.connect(port)
    first = Client.send_json(first, hello(room_id, "p1", "Ada"))
    {:json, _welcome, first} = Client.recv(first)

    first =
      Client.send_json(first, %{
        "type" => "command",
        "command_id" => "c-1",
        "name" => "raise_hand"
      })

    {:json, %{"result" => "committed", "revision" => 2}, _first} = Client.recv(first)

    {:ok, again} = Client.connect(port)
    again = Client.send_json(again, hello(room_id, "p1", "Ada", cursor: 1))
    {:json, welcome, _again} = Client.recv(again)

    assert %{"mode" => "replay", "control_revision" => 2} = welcome
    assert [%{"name" => "hand_raised", "revision" => 2}] = welcome["events"]
  end

  test "invalid token closes with 1008", %{port: port} do
    journey_id = "20000000-0000-4000-8000-000000000001"
    handler_id = "socket-observability-#{System.unique_integer([:positive])}"
    parent = self()

    :ok =
      :telemetry.attach(
        handler_id,
        @observability_event,
        fn event, measurements, metadata, _config ->
          if metadata.journey_id == journey_id do
            send(parent, {:telemetry_event, event, measurements, metadata})
          end
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    {:ok, client} = Client.connect(port)

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => "garbage",
        "journey_id" => journey_id
      })

    assert {:closed, 1008, _reason, _client} = Client.recv(client)
    assert_observability_event("sync.auth.rejected", journey_id, "phase")
    assert_observability_event("sync.connection.closed", journey_id, "terminal")
  end

  test "hello carries journey and W3C trace context through welcome", %{port: port} do
    room_id = unique_room_id()
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    {:ok, client} = Client.connect(port)

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(room_id, "p1", "Ada"),
        "journey_id" => "20000000-0000-4000-8000-000000000002",
        "traceparent" => traceparent,
        "tracestate" => "acme=1"
      })

    {:json, welcome, _client} = Client.recv(client)
    assert welcome["journey_id"] == "20000000-0000-4000-8000-000000000002"
    assert welcome["traceparent"] == traceparent
    assert welcome["tracestate"] == "acme=1"
  end

  test "upgrade correlation wins over conflicting hello and later frames", %{port: port} do
    room_id = unique_room_id()
    upgrade_journey_id = "20000000-0000-4000-8000-000000000003"
    hello_journey_id = "20000000-0000-4000-8000-000000000004"
    later_journey_id = "20000000-0000-4000-8000-000000000005"
    upgrade_traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    hello_traceparent = "00-5bf92f3577b34da6a3ce929d0e0e4736-10f067aa0ba902b7-01"
    later_traceparent = "00-6bf92f3577b34da6a3ce929d0e0e4736-20f067aa0ba902b7-01"

    {:ok, client} =
      Client.connect(port, "/v1/sync", [
        {"x-chalk-journey-id", upgrade_journey_id},
        {"traceparent", upgrade_traceparent},
        {"tracestate", "acme=upgrade"}
      ])

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(room_id, "p1", "Ada"),
        "journey_id" => hello_journey_id,
        "traceparent" => hello_traceparent,
        "tracestate" => "acme=hello"
      })

    {:json, welcome, client} = Client.recv(client)
    assert welcome["journey_id"] == upgrade_journey_id
    assert welcome["traceparent"] == upgrade_traceparent
    assert welcome["tracestate"] == "acme=upgrade"

    client =
      Client.send_json(client, %{
        "type" => "ping",
        "journey_id" => later_journey_id,
        "traceparent" => later_traceparent,
        "tracestate" => "acme=later"
      })

    {:json, pong, _client} = Client.recv(client)
    assert pong["journey_id"] == upgrade_journey_id
    assert pong["traceparent"] == upgrade_traceparent
    assert pong["tracestate"] == "acme=upgrade"
  end

  test "hello correlation wins over a conflicting later frame", %{port: port} do
    room_id = unique_room_id()
    hello_journey_id = "20000000-0000-4000-8000-000000000006"
    later_journey_id = "20000000-0000-4000-8000-000000000007"
    hello_traceparent = "00-7bf92f3577b34da6a3ce929d0e0e4736-30f067aa0ba902b7-01"
    later_traceparent = "00-8bf92f3577b34da6a3ce929d0e0e4736-40f067aa0ba902b7-01"

    {:ok, client} = Client.connect(port)

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(room_id, "p1", "Ada"),
        "journey_id" => hello_journey_id,
        "traceparent" => hello_traceparent,
        "tracestate" => "acme=hello"
      })

    {:json, welcome, client} = Client.recv(client)
    assert welcome["journey_id"] == hello_journey_id
    assert welcome["traceparent"] == hello_traceparent
    assert welcome["tracestate"] == "acme=hello"

    client =
      Client.send_json(client, %{
        "type" => "ping",
        "journey_id" => later_journey_id,
        "traceparent" => later_traceparent,
        "tracestate" => "acme=later"
      })

    {:json, pong, _client} = Client.recv(client)
    assert pong["journey_id"] == hello_journey_id
    assert pong["traceparent"] == hello_traceparent
    assert pong["tracestate"] == "acme=hello"
  end

  test "command before hello closes with 1002", %{port: port} do
    {:ok, client} = Client.connect(port)

    client =
      Client.send_json(client, %{"type" => "command", "command_id" => "c", "name" => "raise_hand"})

    assert {:closed, 1002, _reason, _client} = Client.recv(client)
  end

  test "ping pongs and malformed frames answer with an error frame", %{port: port} do
    room_id = unique_room_id()

    {:ok, client} = Client.connect(port)
    client = Client.send_json(client, hello(room_id, "p1", "Ada"))
    {:json, %{"type" => "welcome"}, client} = Client.recv(client)

    client = Client.send_json(client, %{"type" => "ping"})
    {:json, %{"type" => "pong"}, client} = Client.recv(client)

    client = Client.send_json(client, %{"type" => "mystery"})
    {:json, %{"type" => "error", "code" => "protocol_error"}, _client} = Client.recv(client)
  end

  defp hello(room_id, participant_id, display_name, opts \\ []) do
    token = token(room_id, participant_id, display_name)

    frame = %{"type" => "hello", "protocol" => 1, "token" => token}

    case opts[:cursor] do
      nil -> frame
      cursor -> Map.put(frame, "streams", %{"control" => %{"cursor" => cursor}})
    end
  end

  defp token(room_id, participant_id, display_name) do
    DevTokenVerifier.token(%{
      "tenant_id" => "t1",
      "room_id" => room_id,
      "participant_id" => participant_id,
      "display_name" => display_name
    })
  end

  defp assert_trace_event(client, action, expected_details) do
    deadline = System.monotonic_time(:millisecond) + 2_000
    assert_trace_event_until(client, action, expected_details, deadline)
  end

  defp assert_trace_event_until(client, action, expected_details, deadline) do
    timeout = max(deadline - System.monotonic_time(:millisecond), 0)

    case Client.recv(client, timeout) do
      {:json, %{"type" => "trace", "event" => event}, client} ->
        if event["action"] == action and
             Map.take(event["details"], Map.keys(expected_details)) ==
               expected_details do
          :ok
        else
          assert_trace_event_until(client, action, expected_details, deadline)
        end

      {:json, _message, client} ->
        assert_trace_event_until(client, action, expected_details, deadline)

      {:error, :timeout} ->
        flunk("trace event #{inspect(action)} with #{inspect(expected_details)} was not received")

      other ->
        flunk("unexpected trace response: #{inspect(other)}")
    end
  end

  defp assert_observability_event(event_name, journey_id, stage, attempts \\ 20)

  defp assert_observability_event(_event_name, _journey_id, _stage, 0) do
    flunk("expected observability event was not emitted")
  end

  defp assert_observability_event(event_name, journey_id, stage, attempts) do
    receive do
      {:telemetry_event, @observability_event, %{count: 1}, metadata} ->
        if metadata.event == event_name and metadata.journey_id == journey_id and
             metadata.stage == stage do
          :ok
        else
          assert_observability_event(event_name, journey_id, stage, attempts - 1)
        end
    after
      500 -> flunk("timed out waiting for observability event #{event_name}")
    end
  end
end
