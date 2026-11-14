defmodule ChalkSync.ExternalOperationConsumer do
  @moduledoc """
  Bounded executor for durable provider-neutral external operations.

  PostgreSQL claims are the multi-node exclusion barrier. Adapter calls happen
  after the claim transaction and retain the stable external operation id.
  Ambiguous and retryable outcomes remain pending for the durable claim
  schedule; only confirmed or terminal outcomes are finalized.

  A node runs two lanes (see `child_specs/1`). The local lane claims operations
  that only change Sync's database, such as admission, so they never wait for a
  provider call. The provider lane claims the rest and runs a page of them with
  bounded concurrency, so one slow provider call delays only itself. Finalizers
  lock the Episode and the operation row in one transaction, so rows may run in
  any order and in parallel, as they already do across nodes.
  """

  use GenServer

  require Logger

  alias ChalkSync.ExternalOperationConsumer.Execution
  alias ChalkSync.ExternalOperationConsumer.Health
  alias ChalkSync.ProviderCall
  alias ChalkSync.Stateholder
  alias ChalkSync.Telemetry

  @local_page_size 32
  @default_max_backoff_ms 5_000
  @health_timeout_ms 500
  # A page of provider calls must finish inside the claim lease, so those lanes
  # claim one wave at a time. Local operations make no provider call.
  @lanes %{
    all: %{
      claim: :claim_operations,
      concurrency: 1,
      page_size: 1,
      provider_calls: true
    },
    local: %{
      claim: :claim_local_operations,
      concurrency: 4,
      page_size: @local_page_size,
      provider_calls: false
    },
    provider: %{
      claim: :claim_provider_operations,
      concurrency: 8,
      page_size: 8,
      provider_calls: true
    }
  }

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @doc "The two production lanes and their process names, for health checks."
  @spec lane_names() :: [local: atom(), provider: atom()]
  def lane_names, do: [local: lane_name(:local), provider: lane_name(:provider)]

  @doc false
  def lane_specs, do: @lanes

  @doc "Child specs for the local and provider lanes. `options` apply to both."
  @spec child_specs(keyword()) :: [Supervisor.child_spec()]
  def child_specs(options) do
    for lane <- [:local, :provider] do
      Supervisor.child_spec(
        {__MODULE__, Keyword.merge(options, lane: lane, name: lane_name(lane))},
        id: lane_name(lane)
      )
    end
  end

  defp lane_name(lane),
    do: Module.concat(__MODULE__, lane |> Atom.to_string() |> Macro.camelize())

  @spec health(GenServer.server()) :: map()
  def health(server \\ __MODULE__), do: GenServer.call(server, :health, @health_timeout_ms)

  @impl GenServer
  def init(options) do
    poll_interval_ms = Keyword.fetch!(options, :poll_interval_ms)
    lane = Map.fetch!(@lanes, Keyword.get(options, :lane, :all))

    state = %{
      page_size: Keyword.get(options, :page_size, lane.page_size),
      concurrency: lane.concurrency,
      adapter_timeout_ms:
        Keyword.get(options, :adapter_timeout_ms, ProviderCall.default_timeout_ms()),
      poll_interval_ms: poll_interval_ms,
      max_backoff_ms: Keyword.get(options, :max_backoff_ms, @default_max_backoff_ms),
      claim_operations:
        Keyword.get(options, :claim_operations, Function.capture(Stateholder, lane.claim, 1)),
      media_plane: Keyword.get(options, :media_plane),
      recording_plane: Keyword.get(options, :recording_plane),
      last_success_at_ms: nil,
      consecutive_failures: 0,
      confirmed_count: 0,
      terminal_failure_count: 0,
      retained_pending_count: 0,
      active_work: nil
    }

    send(self(), :poll)
    {:ok, state}
  end

  @impl GenServer
  def handle_call(:health, _from, state), do: {:reply, Health.health_snapshot(state), state}

  @impl GenServer
  def handle_info(:poll, %{active_work: nil} = state) do
    owner = self()
    work_id = make_ref()
    worker_state = %{state | active_work: nil}

    {pid, monitor_ref} =
      spawn_monitor(fn ->
        send(owner, {:poll_result, work_id, self(), poll(worker_state)})
      end)

    active_work = %{
      id: work_id,
      pid: pid,
      monitor_ref: monitor_ref,
      started_at_ms: System.monotonic_time(:millisecond)
    }

    {:noreply, %{state | active_work: active_work}}
  end

  def handle_info(:poll, state), do: {:noreply, state}

  def handle_info(
        {:poll_result, work_id, pid, {delay, next}},
        %{active_work: %{id: work_id, pid: pid, monitor_ref: monitor_ref}}
      ) do
    Process.demonitor(monitor_ref, [:flush])
    Process.send_after(self(), :poll, delay)
    {:noreply, %{next | active_work: nil}}
  end

  def handle_info(
        {:DOWN, monitor_ref, :process, pid, reason},
        %{active_work: %{pid: pid, monitor_ref: monitor_ref}} = state
      ) do
    Telemetry.execute([:external_operation, :poll], %{}, %{outcome: :failure})
    Logger.warning("sync external operation worker stopped: reason=#{inspect(reason)}")

    next = %{state | active_work: nil, consecutive_failures: state.consecutive_failures + 1}
    Process.send_after(self(), :poll, backoff(next))
    {:noreply, next}
  end

  def handle_info({:poll_result, _work_id, _pid, _result}, state), do: {:noreply, state}
  def handle_info({:DOWN, _monitor_ref, :process, _pid, _reason}, state), do: {:noreply, state}

  @impl GenServer
  def terminate(_reason, %{active_work: nil}), do: :ok

  def terminate(_reason, %{active_work: %{pid: pid, monitor_ref: monitor_ref}}) do
    Process.demonitor(monitor_ref, [:flush])
    Process.exit(pid, :shutdown)
    :ok
  end

  defp poll(state) do
    case state.claim_operations.(state.page_size) do
      {:ok, operations} ->
        {counts, failures} = execute_page(operations, state)

        Telemetry.execute(
          [:external_operation, :poll],
          %{count: length(operations)},
          %{outcome: if(failures == 0, do: :success, else: :operation_failure)}
        )

        consecutive_failures = if failures == 0, do: 0, else: state.consecutive_failures + 1

        next =
          state
          |> Map.put(:last_success_at_ms, System.monotonic_time(:millisecond))
          |> Map.put(:consecutive_failures, consecutive_failures)
          |> increment_counts(counts)

        delay =
          if length(operations) == state.page_size and failures == 0,
            do: 0,
            else: backoff(next)

        {delay, next}

      {:retryable, reason} ->
        Telemetry.execute([:external_operation, :poll], %{}, %{outcome: :failure})
        Logger.warning("sync external operation discovery unavailable: reason=#{reason}")
        next = %{state | consecutive_failures: state.consecutive_failures + 1}
        {backoff(next), next}
    end
  end

  defp execute_page(operations, state) do
    operations
    |> Task.async_stream(&execute_claimed(&1, state),
      max_concurrency: state.concurrency,
      ordered: false,
      timeout: :infinity
    )
    |> Enum.reduce({%{confirmed: 0, terminal_failure: 0, pending: 0}, 0}, fn
      {:ok, :confirmed}, {counts, failures} ->
        {%{counts | confirmed: counts.confirmed + 1}, failures}

      {:ok, :terminal_failure}, {counts, failures} ->
        {%{counts | terminal_failure: counts.terminal_failure + 1}, failures}

      {:ok, :pending}, {counts, failures} ->
        {%{counts | pending: counts.pending + 1}, failures}

      {:ok, :finalization_failure}, {counts, failures} ->
        {counts, failures + 1}
    end)
  end

  defp execute_claimed({episode, operation}, state) do
    started_at = System.monotonic_time()

    result =
      Execution.execute_operation(
        episode,
        operation,
        state.media_plane,
        state.recording_plane,
        &Stateholder.finalize_operation/3,
        state.adapter_timeout_ms
      )

    report_result(operation.name, result, started_at)
    result
  end

  defp report_result(operation, result, started_at) do
    Telemetry.execute(
      [:external_operation, :execution],
      %{
        count: 1,
        duration_us:
          System.convert_time_unit(
            System.monotonic_time() - started_at,
            :native,
            :microsecond
          )
      },
      %{operation: operation, outcome: result}
    )
  end

  defp increment_counts(state, counts) do
    %{
      state
      | confirmed_count: state.confirmed_count + counts.confirmed,
        terminal_failure_count: state.terminal_failure_count + counts.terminal_failure,
        retained_pending_count: state.retained_pending_count + counts.pending
    }
  end

  defp backoff(state) do
    backoff_delay(
      state.poll_interval_ms,
      state.max_backoff_ms,
      state.consecutive_failures
    )
  end

  @doc false
  @spec backoff_delay(pos_integer(), pos_integer(), non_neg_integer()) :: pos_integer()
  def backoff_delay(poll_interval_ms, _max_backoff_ms, 0), do: poll_interval_ms

  def backoff_delay(poll_interval_ms, max_backoff_ms, consecutive_failures) do
    multiplier = Integer.pow(2, min(consecutive_failures - 1, 6))
    min(poll_interval_ms * multiplier, max_backoff_ms)
  end
end
