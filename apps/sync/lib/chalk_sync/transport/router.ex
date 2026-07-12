defmodule ChalkSync.Transport.Router do
  @moduledoc """
  HTTP surface. Operational routes stay unversioned; the sync WebSocket lives
  under the `/v1` boundary (north star: one versioned public boundary).
  """

  use Plug.Router

  plug(:match)
  plug(:dispatch)

  alias ChalkSync.DevTools
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
    if Application.fetch_env!(:chalk_sync, :enable_v1) and Operations.accepting_connections?() do
      conn
      |> WebSockAdapter.upgrade(ChalkSync.Transport.Socket, [], timeout: 60_000)
      |> halt()
    else
      not_found(conn)
    end
  end

  get "/v2/sync" do
    if Operations.accepting_connections?() do
      conn
      |> WebSockAdapter.upgrade(ChalkSync.Transport.SocketV2, [], timeout: 60_000)
      |> halt()
    else
      send_json(conn, 503, %{"error" => "server_draining"})
    end
  end

  get "/dev/lab" do
    serve_dev_asset(conn, "index.html", "text/html")
  end

  get "/dev/lab/app.js" do
    serve_dev_asset(conn, "app.js", "text/javascript")
  end

  get "/dev/lab/view.js" do
    serve_dev_asset(conn, "view.js", "text/javascript")
  end

  get "/dev/lab/styles.css" do
    serve_dev_asset(conn, "styles.css", "text/css")
  end

  get "/dev/traces" do
    if DevTools.enabled?() do
      conn
      |> WebSockAdapter.upgrade(ChalkSync.DevTools.TraceSocket, [], timeout: 60_000)
      |> halt()
    else
      not_found(conn)
    end
  end

  post "/dev/rooms/:room_id/restart" do
    if DevTools.enabled?() do
      case DevTools.restart_room(room_id) do
        :ok -> send_json(conn, 202, %{"status" => "restarting"})
        :not_found -> send_json(conn, 404, %{"error" => "room_not_found"})
      end
    else
      not_found(conn)
    end
  end

  match _ do
    not_found(conn)
  end

  defp serve_dev_asset(conn, filename, content_type) do
    if DevTools.enabled?() do
      path = Path.join([:code.priv_dir(:chalk_sync), "lab", filename])

      conn
      |> put_resp_content_type(content_type)
      |> send_file(200, path)
    else
      not_found(conn)
    end
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
