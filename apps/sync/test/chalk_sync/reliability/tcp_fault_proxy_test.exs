defmodule ChalkSync.Reliability.TcpFaultProxyTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Reliability.TcpFaultProxy

  test "partitions active connections and accepts fresh traffic after healing" do
    {listener, upstream_port} = echo_server()
    on_exit(fn -> :gen_tcp.close(listener) end)

    proxy = start_supervised!({TcpFaultProxy, upstream_port: upstream_port})
    proxy_port = TcpFaultProxy.port(proxy)
    {:ok, client} = connect(proxy_port)

    assert :ok = :gen_tcp.send(client, "before")
    assert {:ok, "before"} = :gen_tcp.recv(client, 0, 1_000)

    assert :ok = TcpFaultProxy.partition(proxy)
    assert {:error, :closed} = :gen_tcp.recv(client, 0, 1_000)
    assert_partitioned(connect(proxy_port))

    assert :ok = TcpFaultProxy.heal(proxy)
    {:ok, healed} = connect(proxy_port)
    assert :ok = :gen_tcp.send(healed, "after")
    assert {:ok, "after"} = :gen_tcp.recv(healed, 0, 1_000)
    assert %{accepted: 2, partitions: 1} = TcpFaultProxy.stats(proxy)
  end

  defp echo_server do
    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, packet: :raw, active: false, ip: {127, 0, 0, 1}])

    {:ok, {_address, port}} = :inet.sockname(listener)
    spawn_link(fn -> accept_echo(listener) end)
    {listener, port}
  end

  defp accept_echo(listener) do
    case :gen_tcp.accept(listener) do
      {:ok, socket} ->
        echo = spawn(fn -> echo(socket) end)
        :ok = :gen_tcp.controlling_process(socket, echo)
        send(echo, :start)
        accept_echo(listener)

      {:error, :closed} ->
        :ok
    end
  end

  defp echo(socket) do
    receive do
      :start -> echo_loop(socket)
    end
  end

  defp echo_loop(socket) do
    case :gen_tcp.recv(socket, 0) do
      {:ok, data} ->
        :ok = :gen_tcp.send(socket, data)
        echo_loop(socket)

      {:error, _reason} ->
        :ok
    end
  end

  defp connect(port),
    do: :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, packet: :raw, active: false], 500)

  defp assert_partitioned({:error, _reason}), do: :ok

  defp assert_partitioned({:ok, socket}) do
    assert {:error, :closed} = :gen_tcp.recv(socket, 0, 1_000)
  end
end
