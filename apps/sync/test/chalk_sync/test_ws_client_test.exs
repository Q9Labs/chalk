defmodule ChalkSync.TestWSClientTest do
  use ChalkSync.ServerCase, async: true

  alias ChalkSync.TestWSClient, as: Client
  alias Mint.HTTP

  @attempts 20
  @timeout 100

  test "initiates a graceful close handshake", %{port: port} do
    {:ok, client} = Client.connect(port)
    client = Client.close(client, 1_000, "test complete")

    assert {nil, nil, _client} = eventually_closed(client)
  end

  test "closes the underlying TCP socket without a WebSocket close frame", %{port: port} do
    {:ok, client} = Client.connect(port)
    client = Client.close_tcp(client)

    refute HTTP.open?(client.conn)
  end

  defp eventually_closed(client, attempts \\ @attempts)

  defp eventually_closed(_client, 0) do
    flunk("expected TCP close was not received")
  end

  defp eventually_closed(client, attempts) do
    case Client.recv_frame(client, @timeout) do
      {:closed, code, reason, client} -> {code, reason, client}
      {:frame, _frame, client} -> eventually_closed(client, attempts - 1)
      {:error, :timeout, client} -> eventually_closed(client, attempts - 1)
      {:error, error, _client} -> flunk("socket receive failed: #{inspect(error)}")
    end
  end
end
