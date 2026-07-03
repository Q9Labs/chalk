defmodule ChalkSync.Transport.SocketTest do
  use ChalkSync.ServerCase, async: true

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.Transport.Router

  test "healthz responds unversioned", %{port: port} do
    conn = Plug.Test.conn(:get, "/healthz")
    conn = Router.call(conn, [])
    assert conn.status == 200
    assert port > 0
  end

  test "hello -> welcome snapshot -> command -> ack + fanout", %{port: port} do
    room_id = unique_room_id()

    {:ok, ada} = Client.connect(port)
    ada = Client.send_json(ada, hello(room_id, "p1", "Ada"))
    {:json, welcome, ada} = Client.recv(ada)

    assert %{"type" => "welcome", "mode" => "snapshot", "participant_id" => "p1"} = welcome
    assert welcome["snapshot"]["control_revision"] == 1

    {:ok, bo} = Client.connect(port)
    bo = Client.send_json(bo, hello(room_id, "p2", "Bo"))
    {:json, %{"type" => "welcome"}, bo} = Client.recv(bo)

    {:json, joined, ada} = Client.recv(ada)
    assert %{"type" => "event", "name" => "participant_joined", "revision" => 2} = joined

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
    {:ok, client} = Client.connect(port)
    client = Client.send_json(client, %{"type" => "hello", "protocol" => 1, "token" => "garbage"})

    assert {:closed, 1008, _reason, _client} = Client.recv(client)
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
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => "t1",
        "room_id" => room_id,
        "participant_id" => participant_id,
        "display_name" => display_name
      })

    frame = %{"type" => "hello", "protocol" => 1, "token" => token}

    case opts[:cursor] do
      nil -> frame
      cursor -> Map.put(frame, "streams", %{"control" => %{"cursor" => cursor}})
    end
  end
end
