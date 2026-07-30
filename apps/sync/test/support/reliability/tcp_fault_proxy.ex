defmodule ChalkSync.Reliability.TcpFaultProxy do
  @moduledoc false

  use GenServer

  @connect_timeout_ms 1_000

  def start_link(options), do: GenServer.start_link(__MODULE__, options)

  def port(proxy), do: GenServer.call(proxy, :port)
  def partition(proxy), do: GenServer.call(proxy, :partition)
  def heal(proxy), do: GenServer.call(proxy, :heal)
  def switch_upstream(proxy, host, port), do: GenServer.call(proxy, {:switch, host, port})
  def stats(proxy), do: GenServer.call(proxy, :stats)

  @impl GenServer
  def init(options) do
    host = Keyword.get(options, :upstream_host, {127, 0, 0, 1})
    upstream_port = Keyword.fetch!(options, :upstream_port)

    {:ok, listener} =
      :gen_tcp.listen(Keyword.get(options, :port, 0), [
        :binary,
        packet: :raw,
        active: false,
        ip: {127, 0, 0, 1},
        reuseaddr: true
      ])

    {:ok, {_address, port}} = :inet.sockname(listener)
    server = self()
    acceptor = spawn_link(fn -> accept_loop(listener, server) end)

    {:ok,
     %{
       listener: listener,
       acceptor: acceptor,
       port: port,
       upstream: {host, upstream_port},
       mode: :open,
       relays: %{},
       accepted: 0,
       rejected: 0,
       partitions: 0
     }}
  end

  @impl GenServer
  def handle_call(:port, _from, state), do: {:reply, state.port, state}

  def handle_call(:stats, _from, state) do
    stats = %{
      accepted: state.accepted,
      active_connections: map_size(state.relays),
      mode: state.mode,
      partitions: state.partitions,
      rejected: state.rejected,
      upstream: state.upstream
    }

    {:reply, stats, state}
  end

  def handle_call(:partition, _from, state) do
    close_relays(state.relays)

    {:reply, :ok, %{state | mode: :partitioned, relays: %{}, partitions: state.partitions + 1}}
  end

  def handle_call(:heal, _from, state), do: {:reply, :ok, %{state | mode: :open}}

  def handle_call({:switch, host, port}, _from, state) do
    close_relays(state.relays)
    {:reply, :ok, %{state | upstream: {host, port}, mode: :open, relays: %{}}}
  end

  @impl GenServer
  def handle_info({:accepted, socket}, %{mode: :partitioned} = state) do
    :gen_tcp.close(socket)
    {:noreply, %{state | rejected: state.rejected + 1}}
  end

  def handle_info({:accepted, socket}, %{upstream: {host, port}} = state) do
    case :gen_tcp.connect(host, port, [:binary, packet: :raw, active: false], @connect_timeout_ms) do
      {:ok, upstream} ->
        relay = spawn(&relay_start/0)
        :ok = :gen_tcp.controlling_process(socket, relay)
        :ok = :gen_tcp.controlling_process(upstream, relay)
        monitor = Process.monitor(relay)
        send(relay, {:start, socket, upstream})

        {:noreply,
         %{
           state
           | accepted: state.accepted + 1,
             relays: Map.put(state.relays, relay, monitor)
         }}

      {:error, _reason} ->
        :gen_tcp.close(socket)
        {:noreply, %{state | rejected: state.rejected + 1}}
    end
  end

  def handle_info({:DOWN, monitor, :process, relay, _reason}, state) do
    relays =
      case Map.fetch(state.relays, relay) do
        {:ok, ^monitor} -> Map.delete(state.relays, relay)
        _other -> state.relays
      end

    {:noreply, %{state | relays: relays}}
  end

  @impl GenServer
  def terminate(_reason, state) do
    :gen_tcp.close(state.listener)
    close_relays(state.relays)
    Process.exit(state.acceptor, :normal)
    :ok
  end

  defp accept_loop(listener, server) do
    case :gen_tcp.accept(listener) do
      {:ok, socket} ->
        :ok = :gen_tcp.controlling_process(socket, server)
        send(server, {:accepted, socket})
        accept_loop(listener, server)

      {:error, :closed} ->
        :ok
    end
  end

  defp relay_start do
    receive do
      {:start, client, upstream} ->
        :ok = :inet.setopts(client, active: :once)
        :ok = :inet.setopts(upstream, active: :once)
        relay(client, upstream)
    end
  end

  defp relay(client, upstream) do
    receive do
      {:tcp, ^client, data} ->
        forward(client, upstream, data)

      {:tcp, ^upstream, data} ->
        forward(upstream, client, data)

      {:tcp_closed, socket} when socket in [client, upstream] ->
        close_pair(client, upstream)

      {:tcp_error, socket, _reason} when socket in [client, upstream] ->
        close_pair(client, upstream)

      :close ->
        close_pair(client, upstream)
    end
  end

  defp forward(source, destination, data) do
    case :gen_tcp.send(destination, data) do
      :ok ->
        :ok = :inet.setopts(source, active: :once)
        relay(source, destination)

      {:error, _reason} ->
        close_pair(source, destination)
    end
  end

  defp close_pair(first, second) do
    :gen_tcp.close(first)
    :gen_tcp.close(second)
  end

  defp close_relays(relays), do: Enum.each(Map.keys(relays), &send(&1, :close))
end
