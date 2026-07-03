defmodule ChalkSync.Transport.Router do
  @moduledoc """
  HTTP surface. Operational routes stay unversioned; the sync WebSocket lives
  under the `/v1` boundary (north star: one versioned public boundary).
  """

  use Plug.Router

  plug(:match)
  plug(:dispatch)

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

  match _ do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(404, JSON.encode!(%{"error" => "not_found"}))
  end
end
