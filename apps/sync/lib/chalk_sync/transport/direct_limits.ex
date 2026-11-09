defmodule ChalkSync.Transport.DirectLimits do
  @moduledoc """
  Node-local abuse bounds for sockets that reach Sync through the direct proxy.

  The Cloudflare edge absorbs abuse on the Tunnel path. A direct connection has
  no such edge, so the node's TLS proxy marks it with `x-chalk-ingress: direct`
  and overwrites `cf-connecting-ip` with the TCP peer. Only marked requests pass
  through this module, so Tunnel behaviour is unchanged.

  The state is disposable. It bounds concurrent sockets per IP and per tenant,
  upgrade attempts per IP over a window, and unauthenticated sockets per IP. The
  limiter fails closed: if it cannot answer in time, the upgrade is refused.
  Socket processes are monitored, so a crash releases its slots.
  """

  use GenServer

  alias ChalkSync.Telemetry

  @marker_header "x-chalk-ingress"
  @marker_value "direct"
  @call_timeout_ms 500
  @defaults [
    window_ms: 10_000,
    upgrades_per_ip_window: 20,
    max_sockets_per_ip: 64,
    max_unauthenticated_per_ip: 8,
    max_sockets_per_tenant: 512,
    tracked_ip_limit: 8_192,
    max_frame_bytes: 65_536
  ]

  @type denial :: :rate_limited | :ip_limit | :tenant_limit | :overloaded

  def start_link(options \\ []) do
    GenServer.start_link(__MODULE__, options, name: Keyword.get(options, :name, __MODULE__))
  end

  @doc "True when the node's trusted proxy marked this request as a direct connection."
  @spec direct?(Plug.Conn.t()) :: boolean()
  def direct?(conn), do: Plug.Conn.get_req_header(conn, @marker_header) == [@marker_value]

  @doc "Largest WebSocket frame a direct socket may send."
  @spec max_frame_bytes() :: pos_integer()
  def max_frame_bytes, do: config()[:max_frame_bytes]

  @doc "Counts an upgrade attempt and refuses it before the upgrade when the IP is over a bound."
  @spec admit_upgrade(GenServer.server(), String.t(), integer()) :: :ok | {:error, denial()}
  def admit_upgrade(server \\ __MODULE__, ip, now_ms \\ System.monotonic_time(:millisecond)) do
    server |> call({:admit_upgrade, ip, now_ms}) |> observe(:upgrade)
  end

  @doc "Reserves a socket slot for the calling socket process, released when it exits."
  @spec register(GenServer.server(), String.t()) :: :ok | {:error, denial()}
  def register(server \\ __MODULE__, ip) do
    server |> call({:register, self(), ip}) |> observe(:register)
  end

  @doc "Moves the calling socket from the unauthenticated bound to its tenant's bound."
  @spec authenticated(GenServer.server(), String.t()) :: :ok | {:error, denial()}
  def authenticated(server \\ __MODULE__, tenant_id) do
    server |> call({:authenticated, self(), tenant_id}) |> observe(:authenticated)
  end

  @spec stats(GenServer.server()) :: map()
  def stats(server \\ __MODULE__), do: GenServer.call(server, :stats)

  @impl true
  def init(options) do
    {:ok,
     %{
       config: Keyword.merge(config(), Keyword.delete(options, :name)),
       upgrades: %{},
       sockets: %{},
       by_ip: %{},
       unauthenticated_by_ip: %{},
       by_tenant: %{}
     }}
  end

  @impl true
  def handle_call({:admit_upgrade, ip, now_ms}, _from, state) do
    cutoff = now_ms - state.config[:window_ms]
    upgrades = prune(state.upgrades, cutoff)
    recent = upgrades |> Map.get(ip, []) |> Enum.filter(&(&1 > cutoff))

    cond do
      length(recent) >= state.config[:upgrades_per_ip_window] ->
        {:reply, {:error, :rate_limited}, %{state | upgrades: Map.put(upgrades, ip, recent)}}

      recent == [] and map_size(upgrades) >= state.config[:tracked_ip_limit] ->
        {:reply, {:error, :overloaded}, %{state | upgrades: upgrades}}

      Map.get(state.by_ip, ip, 0) >= state.config[:max_sockets_per_ip] or
          Map.get(state.unauthenticated_by_ip, ip, 0) >= state.config[:max_unauthenticated_per_ip] ->
        {:reply, {:error, :ip_limit}, %{state | upgrades: upgrades}}

      true ->
        {:reply, :ok, %{state | upgrades: Map.put(upgrades, ip, [now_ms | recent])}}
    end
  end

  def handle_call({:register, pid, ip}, _from, state) do
    cond do
      Map.get(state.by_ip, ip, 0) >= state.config[:max_sockets_per_ip] or
          Map.get(state.unauthenticated_by_ip, ip, 0) >= state.config[:max_unauthenticated_per_ip] ->
        {:reply, {:error, :ip_limit}, state}

      true ->
        monitor = Process.monitor(pid)

        {:reply, :ok,
         %{
           state
           | sockets: Map.put(state.sockets, pid, %{monitor: monitor, ip: ip, tenant_id: nil}),
             by_ip: increment(state.by_ip, ip),
             unauthenticated_by_ip: increment(state.unauthenticated_by_ip, ip)
         }}
    end
  end

  def handle_call({:authenticated, pid, tenant_id}, _from, state) do
    case state.sockets do
      %{^pid => %{tenant_id: nil} = socket} ->
        if Map.get(state.by_tenant, tenant_id, 0) >= state.config[:max_sockets_per_tenant] do
          {:reply, {:error, :tenant_limit}, state}
        else
          {:reply, :ok,
           %{
             state
             | sockets: Map.put(state.sockets, pid, %{socket | tenant_id: tenant_id}),
               unauthenticated_by_ip: decrement(state.unauthenticated_by_ip, socket.ip),
               by_tenant: increment(state.by_tenant, tenant_id)
           }}
        end

      _unregistered_or_already_bound ->
        {:reply, :ok, state}
    end
  end

  def handle_call(:stats, _from, state) do
    {:reply,
     %{
       sockets: map_size(state.sockets),
       ips: map_size(state.by_ip),
       tenants: map_size(state.by_tenant),
       tracked_upgrade_ips: map_size(state.upgrades)
     }, state}
  end

  @impl true
  def handle_info({:DOWN, _monitor, :process, pid, _reason}, state) do
    case Map.pop(state.sockets, pid) do
      {nil, _sockets} ->
        {:noreply, state}

      {socket, sockets} ->
        {:noreply, release(%{state | sockets: sockets}, socket)}
    end
  end

  defp release(state, %{ip: ip, tenant_id: nil}) do
    %{
      state
      | by_ip: decrement(state.by_ip, ip),
        unauthenticated_by_ip: decrement(state.unauthenticated_by_ip, ip)
    }
  end

  defp release(state, %{ip: ip, tenant_id: tenant_id}) do
    %{
      state
      | by_ip: decrement(state.by_ip, ip),
        by_tenant: decrement(state.by_tenant, tenant_id)
    }
  end

  defp prune(upgrades, cutoff) do
    upgrades
    |> Map.new(fn {ip, timestamps} -> {ip, Enum.filter(timestamps, &(&1 > cutoff))} end)
    |> Map.reject(fn {_ip, timestamps} -> timestamps == [] end)
  end

  defp increment(counts, key), do: Map.update(counts, key, 1, &(&1 + 1))

  defp decrement(counts, key) do
    case Map.fetch(counts, key) do
      {:ok, count} when count > 1 -> Map.put(counts, key, count - 1)
      _last_or_missing -> Map.delete(counts, key)
    end
  end

  defp config, do: Keyword.merge(@defaults, Application.get_env(:chalk_sync, :direct_limits, []))

  defp call(server, message) do
    GenServer.call(server, message, @call_timeout_ms)
  catch
    :exit, _reason -> {:error, :overloaded}
  end

  defp observe(result, stage) do
    outcome =
      case result do
        :ok -> :accepted
        {:error, denial} -> denial
      end

    Telemetry.execute([:direct, :admission], %{count: 1}, %{outcome: outcome, stage: stage})
    result
  end
end
