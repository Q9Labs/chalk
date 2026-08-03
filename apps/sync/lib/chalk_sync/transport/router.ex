defmodule ChalkSync.Transport.Router do
  @moduledoc """
  HTTP surface. Operational routes stay unversioned; the sync WebSocket lives
  under the `/v1/sync` boundary. Whiteboard collaboration uses the independent
  `/v1/whiteboard` WebSocket.
  """

  use Plug.Router

  plug(:match)
  plug(:dispatch)

  alias ChalkSync.Operations
  alias ChalkSync.Operations.Metrics
  alias ChalkSync.Operations.Readiness

  get "/healthz" do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, JSON.encode!(%{"status" => "ok"}))
  end

  get "/readyz" do
    health = Readiness.health()
    status = if Readiness.ready?(), do: 200, else: 503
    send_json(conn, status, health)
  end

  get "/metrics" do
    send_json(conn, 200, Metrics.snapshot())
  end

  get "/v1/sync" do
    if Operations.accepting_connections?() do
      observability = ChalkSync.Observability.context(conn.req_headers)

      conn
      |> WebSockAdapter.upgrade(
        ChalkSync.Transport.SocketV1,
        %{observability: observability},
        timeout: 60_000
      )
      |> halt()
    else
      send_json(conn, 503, %{"error" => "server_draining"})
    end
  end

  get "/v1/whiteboard" do
    if Operations.accepting_connections?() do
      observability = ChalkSync.Observability.context(conn.req_headers)

      conn
      |> WebSockAdapter.upgrade(
        ChalkSync.Transport.SocketWhiteboardV1,
        %{observability: observability},
        timeout: 60_000
      )
      |> halt()
    else
      send_json(conn, 503, %{"error" => "server_draining"})
    end
  end

  match _ do
    not_found(conn)
  end

  defp not_found(conn) do
    send_json(conn, 404, %{"error" => "not_found"})
  end

  defp send_json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, JSON.encode!(body))
  end
end
