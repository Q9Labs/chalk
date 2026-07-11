defmodule ChalkSync.Transport.Router do
  @moduledoc """
  HTTP surface. Operational routes stay unversioned; the sync WebSocket lives
  under the `/v1` boundary (north star: one versioned public boundary).
  """

  use Plug.Router

  plug(:match)
  plug(:dispatch)

  alias ChalkSync.DevTools

  get "/healthz" do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, JSON.encode!(%{"status" => "ok"}))
  end

  get "/v1/sync" do
    conn
    |> WebSockAdapter.upgrade(ChalkSync.Transport.Socket, [], timeout: 60_000)
    |> halt()
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
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(404, JSON.encode!(%{"error" => "not_found"}))
  end
end
