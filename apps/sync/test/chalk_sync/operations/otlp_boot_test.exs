defmodule ChalkSync.Operations.OtlpBootTest do
  use ExUnit.Case, async: false

  test "a fresh Sync runtime exports its first span over HTTP" do
    port = System.get_env("CHALK_OTLP_TEST_PORT", "0") |> String.to_integer()

    {:ok, listener} =
      :gen_tcp.listen(port, [:binary, ip: {127, 0, 0, 1}, active: false, packet: :http_bin])

    on_exit(fn -> :gen_tcp.close(listener) end)
    {:ok, {_address, port}} = :inet.sockname(listener)

    paths = Enum.flat_map(:code.get_path(), fn path -> [~c"-pa", path] end)

    {:ok, peer, _node} =
      :peer.start_link(%{connection: :standard_io, args: [~c"+S", ~c"2:2"] ++ paths})

    for {key, value} <- Application.get_all_env(:chalk_sync) do
      :ok = :peer.call(peer, :application, :set_env, [:chalk_sync, key, value])
    end

    :ok = :peer.call(peer, :application, :set_env, [:chalk_sync, :port, :none])
    :ok = :peer.call(peer, :application, :set_env, [:opentelemetry, :traces_exporter, :otlp])
    :ok = :peer.call(peer, :application, :set_env, [:opentelemetry, :span_processor, :batch])

    :ok =
      :peer.call(peer, :application, :set_env, [
        :opentelemetry_exporter,
        :otlp_protocol,
        :http_protobuf
      ])

    :ok =
      :peer.call(peer, :application, :set_env, [
        :opentelemetry_exporter,
        :otlp_endpoint,
        "http://127.0.0.1:#{port}"
      ])

    assert {:ok, _applications} =
             :peer.call(peer, :application, :ensure_all_started, [:chalk_sync])

    tracer = :peer.call(peer, :opentelemetry, :get_tracer, [:otlp_boot_test])
    span = :peer.call(peer, :otel_tracer, :start_span, [tracer, "otlp_boot_probe", %{}])
    :peer.call(peer, :otel_span, :end_span, [span])
    :peer.call(peer, :otel_tracer_provider, :force_flush, [])

    assert {:ok, socket} = :gen_tcp.accept(listener, 5_000)
    on_exit(fn -> :gen_tcp.close(socket) end)

    assert {:ok, {:http_request, :POST, {:abs_path, "/v1/traces"}, _version}} =
             :gen_tcp.recv(socket, 0, 5_000)

    length = content_length(socket)
    :ok = :inet.setopts(socket, packet: :raw)
    assert {:ok, body} = :gen_tcp.recv(socket, length, 5_000)
    assert body =~ "otlp_boot_probe"
    :ok = :gen_tcp.send(socket, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
    :ok = :peer.stop(peer)
  end

  defp content_length(socket, length \\ nil) do
    case :gen_tcp.recv(socket, 0, 5_000) do
      {:ok, {:http_header, _index, :"Content-Length", _reserved, value}} ->
        content_length(socket, String.to_integer(value))

      {:ok, {:http_header, _index, _name, _reserved, _value}} ->
        content_length(socket, length)

      {:ok, :http_eoh} ->
        length
    end
  end
end
