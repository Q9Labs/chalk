defmodule ChalkSync.ProviderBridge.ErlangHTTPTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Live.MediaPlaneCall
  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.Stateholder.EpisodeKey

  @tenant_id "33333333-3333-4333-8333-333333333333"
  @space_id "55555555-5555-4555-8555-555555555555"
  @fast_episode_id "44444444-4444-4444-8444-444444444444"
  @slow_operation_id "operation-slow-remove-participant"
  @slow_ms 2_000

  test "a media-plane observation does not wait behind a slow operation to the same API" do
    port = start_api()
    client = Client.new!(base_url: "http://127.0.0.1:#{port}")

    episode = %EpisodeKey{
      tenant_id: @tenant_id,
      space_id: @space_id,
      episode_id: @fast_episode_id
    }

    # The persistent connection must be warm, as it is after the first call in production.
    assert {:ok, _observation} = Client.observe_episode_publications(client, episode)

    slow =
      Task.async(fn ->
        Client.post_operation(client, @slow_operation_id, %{
          "effect" => "media.remove_participant",
          "tenant_id" => @tenant_id,
          "episode_id" => @fast_episode_id,
          "participant_id" => "66666666-6666-4666-8666-666666666666"
        })
      end)

    Process.sleep(100)

    {elapsed_us, result} =
      :timer.tc(fn ->
        MediaPlaneCall.invoke(fn -> Client.observe_episode_publications(client, episode) end)
      end)

    assert {:ok, %{sequence: 1}} = result
    assert div(elapsed_us, 1_000) < 200

    Task.await(slow, @slow_ms * 2)
  end

  defp start_api do
    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true, ip: {127, 0, 0, 1}])

    {:ok, port} = :inet.port(listener)
    acceptor = spawn_link(fn -> accept_loop(listener) end)

    on_exit(fn ->
      Process.unlink(acceptor)
      Process.exit(acceptor, :kill)
      :gen_tcp.close(listener)
    end)

    port
  end

  defp accept_loop(listener) do
    {:ok, socket} = :gen_tcp.accept(listener)
    handler = spawn(fn -> receive_socket_then_serve() end)
    :ok = :gen_tcp.controlling_process(socket, handler)
    send(handler, {:socket, socket})
    accept_loop(listener)
  end

  defp receive_socket_then_serve do
    receive do
      {:socket, socket} -> serve(socket, <<>>)
    end
  end

  defp serve(socket, buffer) do
    case read_request(socket, buffer) do
      {:ok, request_line, rest} ->
        respond(socket, request_line)
        serve(socket, rest)

      :closed ->
        :gen_tcp.close(socket)
    end
  end

  defp read_request(socket, buffer) do
    case :binary.split(buffer, "\r\n\r\n") do
      [head, rest] ->
        [request_line | headers] = String.split(head, "\r\n")
        length = content_length(headers)
        read_body(socket, request_line, rest, length)

      [_incomplete] ->
        case :gen_tcp.recv(socket, 0, 30_000) do
          {:ok, data} -> read_request(socket, buffer <> data)
          {:error, _reason} -> :closed
        end
    end
  end

  defp read_body(_socket, request_line, rest, length) when byte_size(rest) >= length do
    <<_body::binary-size(^length), remaining::binary>> = rest
    {:ok, request_line, remaining}
  end

  defp read_body(socket, request_line, rest, length) do
    case :gen_tcp.recv(socket, 0, 30_000) do
      {:ok, data} -> read_body(socket, request_line, rest <> data, length)
      {:error, _reason} -> :closed
    end
  end

  defp content_length(headers) do
    Enum.find_value(headers, 0, fn header ->
      case String.split(header, ":", parts: 2) do
        [name, value] ->
          if String.downcase(name) == "content-length", do: String.to_integer(String.trim(value))

        _other ->
          nil
      end
    end)
  end

  defp respond(socket, request_line) do
    if request_line =~ @slow_operation_id, do: Process.sleep(@slow_ms)

    body =
      JSON.encode!(%{
        "observations" => [%{"incarnation" => 1, "sequence" => 1, "publications" => []}],
        "has_more" => false,
        "next_cursor" => nil
      })

    :gen_tcp.send(
      socket,
      "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: #{byte_size(body)}\r\n\r\n" <>
        body
    )
  end
end
