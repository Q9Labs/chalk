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
    {:ok, websocket, data} = WebSocket.encode(client.websocket, {:text, JSON.encode!(map)})
    {:ok, conn} = WebSocket.stream_request_body(client.conn, client.ref, data)
    %{client | conn: conn, websocket: websocket}
  end

  @doc """
  Pops the next frame: `{:json, map, client}`, `{:closed, code, reason,
  client}`, or `{:error, :timeout}`.
  """
  def recv(client, timeout \\ @timeout)

  def recv(%__MODULE__{buffered: [frame | rest]} = client, _timeout) do
    emit(frame, %{client | buffered: rest})
  end

  def recv(%__MODULE__{buffered: []} = client, timeout) do
    case next_socket_message(client.conn, timeout) do
      {:error, :timeout} ->
        {:error, :timeout}

      {:ok, message} ->
        case WebSocket.stream(client.conn, message) do
          {:ok, conn, entries} ->
            {client, frames} = decode_entries(%{client | conn: conn}, entries)
            recv(%{client | buffered: client.buffered ++ frames}, timeout)

          {:error, _conn, %Mint.TransportError{reason: :closed}, _} ->
            {:closed, nil, nil, client}
        end
    end
  end

  defp emit({:text, text}, client), do: {:json, JSON.decode!(text), client}
  defp emit({:close, code, reason}, client), do: {:closed, code, reason, client}

  defp decode_entries(client, entries) do
    Enum.reduce(entries, {client, []}, fn
      {:data, _ref, data}, {client, frames} ->
        {:ok, websocket, new_frames} = WebSocket.decode(client.websocket, data)
        new_frames = Enum.reject(new_frames, &match?({:ping, _}, &1))
        {%{client | websocket: websocket}, frames ++ new_frames}

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
