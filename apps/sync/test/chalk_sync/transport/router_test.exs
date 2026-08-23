defmodule ChalkSync.Transport.RouterTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.Transport.Router

  test "plain GET returns a bounded upgrade-required response" do
    conn =
      Plug.Test.conn(:get, "/v1/sync")
      |> Plug.Conn.put_req_header("connection", "keep-alive")

    conn = Router.call(conn, [])

    assert {426, headers, body} = Plug.Test.sent_resp(conn)
    assert {"content-type", "application/json; charset=utf-8"} in headers
    assert {"upgrade", "websocket"} in headers
    assert JSON.decode!(body) == %{"error" => "upgrade_required"}

    assert String.match?(
             header(headers, "x-chalk-journey-id"),
             ~r/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
           )
  end

  test "malformed upgrade returns a safe invalid-upgrade response" do
    conn =
      Plug.Test.conn(:get, "/v1/sync")
      |> Plug.Conn.put_req_header("connection", "Upgrade")
      |> Plug.Conn.put_req_header("upgrade", "websocket")
      |> Plug.Conn.put_req_header("sec-websocket-version", "13")

    conn = Router.call(conn, [])

    assert {400, headers, body} = Plug.Test.sent_resp(conn)
    refute Enum.any?(headers, fn {key, _value} -> key == "upgrade" end)
    assert JSON.decode!(body) == %{"error" => "invalid_upgrade"}
  end

  test "valid WebSocket upgrade remains accepted", %{port: port} do
    assert {:ok, client} = Client.connect(port)
    Client.close_tcp(client)
  end

  defp header(headers, key), do: headers |> Map.new() |> Map.fetch!(key)
end
