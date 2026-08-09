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
      case WebSockAdapter.UpgradeValidation.validate_upgrade(conn) do
        :ok ->
          observability = ChalkSync.Observability.context(conn.req_headers)

          conn
          |> WebSockAdapter.upgrade(
            ChalkSync.Transport.SocketV1,
            %{observability: observability},
            timeout: 60_000
          )
          |> halt()

        {:error, _reason} ->
          send_upgrade_error(conn)
      end
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

  defp send_upgrade_error(conn) do
    {status, error} =
      if upgrade_requested?(conn) do
        {400, "invalid_upgrade"}
      else
        {426, "upgrade_required"}
      end

    context =
      conn.req_headers
      |> ChalkSync.Observability.context()
      |> ChalkSync.Observability.root("sync.http.upgrade_rejected", %{
        protocol: "websocket",
        status: status,
        error: error
      })

    conn
    |> maybe_put_context_headers(context)
    |> maybe_put_upgrade_header(status)
    |> send_json(status, %{"error" => error})
  end

  defp upgrade_requested?(conn) do
    conn
    |> get_req_header("connection")
    |> Enum.any?(&connection_upgrade?/1)
  end

  defp connection_upgrade?(value) do
    value
    |> String.split(",")
    |> Enum.any?(fn token -> String.downcase(String.trim(token), :ascii) == "upgrade" end)
  end

  defp maybe_put_context_headers(conn, context) do
    context
    |> ChalkSync.Observability.frame_fields()
    |> Enum.reduce(conn, fn
      {"journey_id", value}, conn when is_binary(value) ->
        put_resp_header(conn, "x-chalk-journey-id", value)

      {key, value}, conn when key in ["traceparent", "tracestate"] and is_binary(value) ->
        put_resp_header(conn, key, value)

      _entry, conn ->
        conn
    end)
  end

  defp maybe_put_upgrade_header(conn, 426), do: put_resp_header(conn, "upgrade", "websocket")
  defp maybe_put_upgrade_header(conn, _status), do: conn

  defp send_json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, JSON.encode!(body))
  end
end
