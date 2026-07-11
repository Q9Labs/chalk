defmodule ChalkSync.TestWSClient do
  @moduledoc """
  Minimal synchronous WebSocket client for integration tests, built on
  `Mint.WebSocket`. Exercises the real wire: TCP, upgrade, JSON text frames.

  Selectively receives on this connection's socket so several clients can
  live in one test process.
  """

  alias Mint.HTTP
  alias Mint.WebSocket

  defstruct [:conn, :ref, :websocket, buffered: []]

  @timeout 2_000

  def connect(port, path \\ "/v1/sync") do
    {:ok, conn} = HTTP.connect(:http, "127.0.0.1", port)
    {:ok, conn, ref} = WebSocket.upgrade(:ws, conn, path, [])

    with {:ok, conn, status, headers} <- await_upgrade(conn, ref, %{headers: []}),
         {:ok, conn, websocket} <- WebSocket.new(conn, ref, status, headers) do
      {:ok, %__MODULE__{conn: conn, ref: ref, websocket: websocket}}
    end
  end

  def send_json(%__MODULE__{} = client, map) do
    send_frame(client, {:text, JSON.encode!(map)})
  end

  @doc "Initiates a graceful WebSocket close handshake."
  def close(%__MODULE__{} = client, code \\ 1_000, reason \\ "") do
    send_frame(client, {:close, code, reason})
  end

  @doc "Closes the underlying TCP socket without sending a WebSocket close frame."
  def close_tcp(%__MODULE__{} = client) do
    {:ok, conn} = HTTP.close(client.conn)
    %{client | conn: conn}
  end

  @doc """
  Pops the next frame: `{:json, map, client}`, raw text or binary frame
  tuples, `{:closed, code, reason, client}`, or `{:error, :timeout}`.

  Use `recv_frame/2` when the caller must retain the client state on timeout.
  """
  def recv(%__MODULE__{} = client, timeout \\ @timeout) do
    case recv_frame(client, timeout) do
      {:frame, frame, client} -> emit(frame, client)
      {:closed, code, reason, client} -> {:closed, code, reason, client}
      {:error, :timeout, _client} -> {:error, :timeout}
      {:error, error, client} -> {:error, error, client}
    end
  end

  @doc """
  Pops the next decoded WebSocket frame without interpreting its payload.

  Every result includes the latest client state, including timeouts and
  transport errors, so a stress harness can continue reading safely.
  """
  def recv_frame(%__MODULE__{} = client, timeout \\ @timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout
    recv_frame_until(client, deadline)
  end

  @doc "Nonblocking variant of `recv_frame/2`."
  def recv_now(%__MODULE__{} = client), do: recv_frame(client, 0)

  @doc """
  Drains decoded WebSocket frames already buffered or present in this client's
  socket mailbox without waiting for new traffic.
  """
  def drain(%__MODULE__{} = client), do: drain(client, [])

  defp drain(client, frames) do
    case recv_now(client) do
      {:frame, frame, client} -> drain(client, [frame | frames])
      {:closed, _code, _reason, client} -> {:closed, Enum.reverse(frames), client}
      {:error, :timeout, client} -> {:ok, Enum.reverse(frames), client}
      {:error, error, client} -> {:error, error, Enum.reverse(frames), client}
    end
  end

  defp recv_frame_until(%__MODULE__{buffered: [frame | rest]} = client, _deadline) do
    emit_frame(frame, %{client | buffered: rest})
  end

  defp recv_frame_until(%__MODULE__{buffered: []} = client, deadline) do
    timeout = max(deadline - System.monotonic_time(:millisecond), 0)

    case next_socket_message(client.conn, timeout) do
      {:error, :timeout} ->
        {:error, :timeout, client}

      {:ok, message} ->
        case WebSocket.stream(client.conn, message) do
          {:ok, conn, entries} ->
            {client, frames} = decode_entries(%{client | conn: conn}, entries)
            recv_frame_until(%{client | buffered: client.buffered ++ frames}, deadline)

          {:error, conn, %Mint.TransportError{reason: :closed}, entries} ->
            {client, frames} = decode_entries(%{client | conn: conn}, entries)

            recv_frame_until(
              %{client | buffered: client.buffered ++ frames ++ [{:transport_closed, nil, nil}]},
              deadline
            )

          {:error, conn, error, entries} ->
            {client, frames} = decode_entries(%{client | conn: conn}, entries)
            {:error, error, %{client | buffered: client.buffered ++ frames}}
        end
    end
  end

  defp emit({:text, text}, client) do
    case JSON.decode(text) do
      {:ok, map} -> {:json, map, client}
      {:error, _reason} -> {:text, text, client}
    end
  end

  defp emit({:close, code, reason}, client), do: {:closed, code, reason, client}
  defp emit({:binary, data}, client), do: {:binary, data, client}
  defp emit(frame, client), do: {:frame, frame, client}

  defp emit_frame({:transport_closed, code, reason}, client),
    do: {:closed, code, reason, client}

  defp emit_frame(frame, client), do: {:frame, frame, client}

  defp send_frame(client, frame) do
    {:ok, websocket, data} = WebSocket.encode(client.websocket, frame)
    {:ok, conn} = WebSocket.stream_request_body(client.conn, client.ref, data)
    %{client | conn: conn, websocket: websocket}
  end

  defp decode_entries(client, entries) do
    Enum.reduce(entries, {client, []}, fn
      {:data, _ref, data}, {client, frames} ->
        case WebSocket.decode(client.websocket, data) do
          {:ok, websocket, new_frames} ->
            {%{client | websocket: websocket}, frames ++ new_frames}

          {:error, websocket, error} ->
            {%{client | websocket: websocket}, frames ++ [{:decode_error, error}]}
        end

      _other, acc ->
        acc
    end)
  end

  defp await_upgrade(conn, ref, acc) do
    with {:ok, message} <- next_socket_message(conn, @timeout),
         {:ok, conn, entries} <- WebSocket.stream(conn, message) do
      acc = Enum.reduce(entries, acc, &collect_upgrade(&1, &2, ref))

      if acc[:done],
        do: {:ok, conn, acc[:status], acc[:headers]},
        else: await_upgrade(conn, ref, acc)
    else
      {:error, :timeout} -> {:error, :upgrade_timeout}
      error -> error
    end
  end

  defp collect_upgrade({:status, ref, status}, acc, ref), do: Map.put(acc, :status, status)
  defp collect_upgrade({:headers, ref, headers}, acc, ref), do: Map.put(acc, :headers, headers)
  defp collect_upgrade({:done, ref}, acc, ref), do: Map.put(acc, :done, true)
  defp collect_upgrade(_entry, acc, _ref), do: acc

  # Several clients share the test process mailbox; only take this
  # connection's transport messages.
  defp next_socket_message(conn, timeout) do
    socket = HTTP.get_socket(conn)

    receive do
      {_tag, ^socket, _data} = message -> {:ok, message}
      {_tag, ^socket} = message -> {:ok, message}
    after
      timeout -> {:error, :timeout}
    end
  end
end
