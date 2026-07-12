defmodule ChalkSync.Operations.Readiness do
  @moduledoc """
  Cached dependency readiness with explicit failure and recovery hysteresis.

  Probes run once per second by default. Two consecutive failures make a ready
  node unready; recovery needs at least three successful probes spanning five
  seconds. HTTP requests only read this bounded, identifier-free snapshot.
  """

  use GenServer

  alias ChalkSync.Operations
  alias ChalkSync.Operations.Probe

  @default_interval_ms 1_000
  @default_success_span_ms 5_000

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @spec ready?(GenServer.server()) :: boolean()
  def ready?(server \\ __MODULE__) do
    GenServer.call(server, :ready, 250)
  catch
    :exit, _reason -> false
  end

  @spec health(GenServer.server()) :: map()
  def health(server \\ __MODULE__) do
    GenServer.call(server, :health, 250)
  catch
    :exit, _reason -> %{status: "unready", reason: "readiness_process_unavailable"}
  end

  @doc false
  def probe_now(server \\ __MODULE__), do: GenServer.call(server, :probe_now)

  @impl GenServer
  def init(options) do
    state = %{
      status: :initializing,
      consecutive_failures: 0,
      consecutive_successes: 0,
      first_success_at_ms: nil,
      last_checked_at_ms: nil,
      details: %{},
      interval_ms: Keyword.get(options, :interval_ms, @default_interval_ms),
      success_span_ms: Keyword.get(options, :success_span_ms, @default_success_span_ms),
      probe_fun: Keyword.get(options, :probe_fun, &Probe.run/0),
      clock: Keyword.get(options, :clock, fn -> System.monotonic_time(:millisecond) end),
      auto_probe?: Keyword.get(options, :auto_probe?, true),
      probe_pid: nil,
      probe_ref: nil,
      probe_waiters: []
    }

    if state.auto_probe?, do: send(self(), :probe)
    {:ok, state}
  end

  @impl GenServer
  def handle_call(:ready, _from, state) do
    ready = state.status == :ready and Operations.accepting_connections?()
    {:reply, ready, state}
  end

  def handle_call(:health, _from, state) do
    {:reply, public_health(state), state}
  end

  def handle_call(:probe_now, from, state) do
    next = ensure_probe(state)
    {:noreply, %{next | probe_waiters: [from | next.probe_waiters]}}
  end

  @impl GenServer
  def handle_info(:probe, state) do
    {:noreply, ensure_probe(state)}
  end

  def handle_info({:probe_result, pid, result}, %{probe_pid: pid} = state) do
    {:noreply, finish_probe(state, result)}
  end

  def handle_info({:probe_result, _pid, _result}, state), do: {:noreply, state}

  def handle_info({:DOWN, ref, :process, pid, _reason}, %{probe_pid: pid, probe_ref: ref} = state) do
    {:noreply, finish_probe(state, {:error, :probe_failed})}
  end

  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state), do: {:noreply, state}

  @impl GenServer
  def terminate(_reason, %{probe_pid: pid, probe_ref: ref}) when is_pid(pid) do
    Process.demonitor(ref, [:flush])
    Process.exit(pid, :shutdown)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  defp ensure_probe(%{probe_pid: pid} = state) when is_pid(pid), do: state

  defp ensure_probe(state) do
    owner = self()
    probe_fun = state.probe_fun

    {pid, ref} =
      spawn_monitor(fn ->
        send(owner, {:probe_result, self(), probe_result(probe_fun)})
      end)

    %{state | probe_pid: pid, probe_ref: ref}
  end

  defp probe_result(probe_fun) do
    probe_fun.()
  rescue
    _exception -> {:error, :probe_failed}
  catch
    :exit, _reason -> {:error, :probe_failed}
  end

  defp finish_probe(state, result) do
    Process.demonitor(state.probe_ref, [:flush])
    now = state.clock.()
    next = %{state | probe_pid: nil, probe_ref: nil}
    next = apply_result(next, result, now)
    Enum.each(next.probe_waiters, &GenServer.reply(&1, public_health(next)))
    next = %{next | probe_waiters: []}

    if next.auto_probe?, do: Process.send_after(self(), :probe, next.interval_ms)
    next
  end

  defp apply_result(state, {:ok, details}, now) do
    first_success_at = state.first_success_at_ms || now
    successes = state.consecutive_successes + 1

    ready? =
      state.status == :ready or
        (successes >= 3 and now - first_success_at >= state.success_span_ms)

    %{
      state
      | status: if(ready?, do: :ready, else: :initializing),
        consecutive_failures: 0,
        consecutive_successes: successes,
        first_success_at_ms: first_success_at,
        last_checked_at_ms: now,
        details: details
    }
  end

  defp apply_result(state, {:error, reason}, now) do
    failures = state.consecutive_failures + 1
    still_ready? = state.status == :ready and failures < 2

    %{
      state
      | status: if(still_ready?, do: :ready, else: :unready),
        consecutive_failures: failures,
        consecutive_successes: 0,
        first_success_at_ms: nil,
        last_checked_at_ms: now,
        details: %{reason: Atom.to_string(reason)}
    }
  end

  defp public_health(state) do
    accepting? = Operations.accepting_connections?()

    %{
      status: if(accepting?, do: Atom.to_string(state.status), else: "unready"),
      draining: not accepting?,
      consecutive_failures: state.consecutive_failures,
      consecutive_successes: state.consecutive_successes,
      last_check_age_ms: check_age_ms(state),
      dependencies: state.details
    }
  end

  defp check_age_ms(%{last_checked_at_ms: nil}), do: nil

  defp check_age_ms(state),
    do: max(state.clock.() - state.last_checked_at_ms, 0)
end
