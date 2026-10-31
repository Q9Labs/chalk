defmodule ChalkSync.Operations.Readiness do
  @moduledoc """
  Cached dependency readiness with explicit failure and recovery hysteresis.

  Probes run once per second by default. Two consecutive failures make a ready
  node unready; recovery needs at least three successful probes spanning five
  seconds. HTTP requests only read this bounded, identifier-free snapshot.
  """

  use GenServer

  alias ChalkSync.Observability
  alias ChalkSync.Operations
  alias ChalkSync.Operations.Probe

  require Logger

  @default_interval_ms 1_000
  @default_success_span_ms 5_000
  @readiness_reasons ~w(
    database_unavailable database_not_writable_primary incompatible_database_migration
    unsupported_postgres_version unsafe_database_durability synchronous_commit_disabled
    lifecycle_intent_lag synchronous_standby_not_configured synchronous_standby_unavailable
    synchronous_standby_lag required_process_unavailable lifecycle_consumer_unavailable
    lifecycle_consumer_initializing lifecycle_consumer_stale
    external_operation_consumer_unavailable external_operation_consumer_initializing
    external_operation_consumer_stale notification_listener_unavailable
    retention_cleanup_unavailable provider_bridge_not_configured provider_bridge_unavailable
    non_production_stateholder development_token_verifier invalid_token_verifier probe_failed
  )

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
      unready_at_ms: nil,
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
    Probe.record_failure(:probe_worker, :probe_failed, %{observed: "terminated"})
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
    _exception ->
      Probe.record_failure(:probe_worker, :probe_failed, %{observed: "exception"})
      {:error, :probe_failed}
  catch
    :exit, _reason ->
      Probe.record_failure(:probe_worker, :probe_failed, %{observed: "exit"})
      {:error, :probe_failed}
  end

  defp finish_probe(state, result) do
    Process.demonitor(state.probe_ref, [:flush])
    now = state.clock.()
    next = %{state | probe_pid: nil, probe_ref: nil}
    next = apply_result(next, result, now)
    next = record_status_transition(state, next, now)
    Enum.each(next.probe_waiters, &GenServer.reply(&1, public_health(next)))
    next = %{next | probe_waiters: []}

    if next.auto_probe?, do: Process.send_after(self(), :probe, next.interval_ms)
    next
  end

  defp record_status_transition(%{status: status}, %{status: status} = next, _now), do: next

  defp record_status_transition(previous, next, now) do
    attributes = transition_attributes(previous, next, now)
    emit_status_transition(next.status, attributes)

    %{next | unready_at_ms: transition_unready_at(previous, next, now)}
  end

  defp transition_attributes(previous, next, now) do
    attributes = %{
      from: Atom.to_string(previous.status),
      to: Atom.to_string(next.status),
      reason: transition_reason(next),
      consecutive_failures: next.consecutive_failures
    }

    if previous.status == :unready and next.status == :ready do
      Map.put(attributes, :unready_ms, max(now - previous.unready_at_ms, 0))
    else
      attributes
    end
  end

  defp transition_reason(%{status: :ready}), do: "none"

  defp transition_reason(next) do
    case Map.get(next.details, :reason) do
      reason when is_binary(reason) and reason in @readiness_reasons -> reason
      _reason -> "none"
    end
  end

  defp transition_unready_at(_previous, %{status: :unready}, now), do: now
  defp transition_unready_at(%{status: :unready}, %{status: :ready}, _now), do: nil
  defp transition_unready_at(_previous, next, _now), do: next.unready_at_ms

  defp emit_status_transition(status, attributes) do
    context = Observability.root(nil, "sync.readiness.changed", attributes)

    log = fn ->
      attributes
      |> Map.merge(Observability.frame_fields(context))
      |> Map.put(:event, "sync.readiness.changed")
      |> JSON.encode!()
    end

    if status == :ready, do: Logger.info(log), else: Logger.warning(log)
  end

  defp apply_result(state, {:ok, details}, now) do
    first_success_at = state.first_success_at_ms || now
    successes = state.consecutive_successes + 1

    ready? =
      state.status == :ready or
        (successes >= 3 and now - first_success_at >= state.success_span_ms)

    %{
      state
      | status: status_after_success(state.status, ready?),
        consecutive_failures: 0,
        consecutive_successes: successes,
        first_success_at_ms: first_success_at,
        last_checked_at_ms: now,
        details: details
    }
  end

  defp apply_result(state, {:error, reason}, now),
    do: apply_result(state, {:error, reason, %{}}, now)

  defp apply_result(state, {:error, reason, details}, now) do
    failures = state.consecutive_failures + 1
    still_ready? = state.status == :ready and failures < 2

    %{
      state
      | status: if(still_ready?, do: :ready, else: :unready),
        consecutive_failures: failures,
        consecutive_successes: 0,
        first_success_at_ms: nil,
        last_checked_at_ms: now,
        details: Map.put(details, :reason, Atom.to_string(reason))
    }
  end

  defp status_after_success(_status, true), do: :ready
  defp status_after_success(:unready, false), do: :unready
  defp status_after_success(_status, false), do: :initializing

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
