defmodule ChalkSync.Transport.RouterTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.Transport.Router

  @journey_id "10000000-0000-4000-8000-000000000001"
  @traceparent "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  @tracestate "acme=router"

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

  test "plain HTTP/1.1 GET is handled at the Bandit boundary", %{port: port} do
    response = http_get(port, [{"connection", "keep-alive"}])

    assert response.status == 426
    assert response.headers["upgrade"] == "websocket"
    assert JSON.decode!(response.body) == %{"error" => "upgrade_required"}
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

  test "upgrade errors preserve request journey and W3C context" do
    conn =
      Plug.Test.conn(:get, "/v1/sync")
      |> Plug.Conn.put_req_header("connection", "keep-alive")
      |> Plug.Conn.put_req_header("x-chalk-journey-id", @journey_id)
      |> Plug.Conn.put_req_header("traceparent", @traceparent)
      |> Plug.Conn.put_req_header("tracestate", @tracestate)

    conn = Router.call(conn, [])
    {426, headers, _body} = Plug.Test.sent_resp(conn)

    assert header(headers, "x-chalk-journey-id") == @journey_id
    assert header(headers, "traceparent") == @traceparent
    assert header(headers, "tracestate") == @tracestate
  end

  test "valid WebSocket upgrade remains accepted", %{port: port} do
    assert {:ok, client} = Client.connect(port)
    Client.close_tcp(client)
  end

  defp header(headers, key), do: headers |> Map.new() |> Map.fetch!(key)

  defp http_get(port, headers) do
    {:ok, _applications} = Application.ensure_all_started(:inets)
    url = String.to_charlist("http://127.0.0.1:#{port}/v1/sync")

    request_headers =
      Enum.map(headers, fn {key, value} -> {to_charlist(key), to_charlist(value)} end)

    {:ok, {{_http_version, status, _reason}, response_headers, body}} =
      :httpc.request(:get, {url, request_headers}, [], [{:body_format, :binary}])

    %{
      status: status,
      headers:
        Map.new(response_headers, fn {key, value} -> {to_string(key), to_string(value)} end),
      body: body
    }
  end
end
