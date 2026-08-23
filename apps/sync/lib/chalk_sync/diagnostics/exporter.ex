defmodule ChalkSync.Diagnostics.Exporter do
  @moduledoc "Finite-batch, finite-retry Episode Diagnostic exporter."

  use GenServer

  require Logger

  alias ChalkSync.Diagnostics
  alias ChalkSync.Diagnostics.Buffer
  alias ChalkSync.Diagnostics.Transport
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Telemetry

  @default_interval_ms 100
  @default_max_batch_events 200
  @default_max_batch_bytes 256 * 1024
  @default_max_retries 5
  @default_max_backoff_ms 5_000

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @spec health(GenServer.server()) :: map()
  def health(server \\ __MODULE__) do
    GenServer.call(server, :health, 250)
  catch
    :exit, _reason -> %{status: :unavailable}
  end

  @impl GenServer
  def init(options) do
    config = Keyword.fetch!(options, :config)
    :ok = Transport.validate_config(config)

    state = %{
      buffer: Keyword.get(options, :buffer, Buffer),
      transport: Keyword.get(options, :transport, Transport),
      config: config,
      interval_ms: positive(options, :interval_ms, @default_interval_ms),
      max_batch_events: positive(options, :max_batch_events, @default_max_batch_events),
      max_batch_bytes: positive(options, :max_batch_bytes, @default_max_batch_bytes),
      max_retries: positive(options, :max_retries, @default_max_retries),
      max_backoff_ms: positive(options, :max_backoff_ms, @default_max_backoff_ms),
      retries: 0,
      exported: 0,
      dropped: 0,
      dropped_batches: 0,
      failures: 0,
      total_failures: 0,
      last_failure_reason: nil,
      last_failure_at_ms: nil,
      last_success_at_ms: nil,
      active: nil
    }

    send(self(), :export)
    {:ok, state}
  end

  @impl GenServer
  def handle_call(:health, _from, state) do
    status = if state.failures == 0, do: :healthy, else: :degraded

    {:reply,
     %{
       status: status,
       retries: state.retries,
       exported: state.exported,
       dropped: state.dropped,
       dropped_batches: state.dropped_batches,
       failures: state.failures,
       total_failures: state.total_failures,
       last_failure_reason: state.last_failure_reason,
       last_failure_age_ms: age_ms(state.last_failure_at_ms),
       last_success_age_ms: age_ms(state.last_success_at_ms),
       active: not is_nil(state.active)
     }, state}
  end

  @impl GenServer
  def handle_info(:export, %{active: nil} = state) do
    case Buffer.take_batch(state.buffer, state.max_batch_events, state.max_batch_bytes) do
      :empty ->
        schedule(state.interval_ms)
        {:noreply, state}

      {:ok, scope, entries} ->
        owner = self()
        work_id = make_ref()
        transport = state.transport
        config = state.config
        events = Enum.map(entries, & &1.event)

        {pid, monitor} =
          spawn_monitor(fn ->
            result = transport.append(config, scope, events)
            send(owner, {:export_result, work_id, self(), scope, entries, result})
          end)

        {:noreply, %{state | active: %{id: work_id, pid: pid, monitor: monitor}}}
    end
  end

  def handle_info(:export, state), do: {:noreply, state}

  def handle_info(
        {:export_result, work_id, pid, scope, entries, result},
        %{active: %{id: work_id, pid: pid, monitor: monitor}} = state
      ) do
    Process.demonitor(monitor, [:flush])
    next = %{state | active: nil} |> apply_result(scope, entries, result)
    schedule(delay(next, result))
    {:noreply, next}
  end

  def handle_info(
        {:DOWN, monitor, :process, pid, _reason},
        %{active: %{pid: pid, monitor: monitor}} = state
      ) do
    next = failure(%{state | active: nil}, :transport_error)
    schedule(delay(next, {:retryable, :transport_error}))
    {:noreply, next}
  end

  def handle_info({:export_result, _id, _pid, _scope, _entries, _result}, state),
    do: {:noreply, state}

  def handle_info({:DOWN, _monitor, :process, _pid, _reason}, state), do: {:noreply, state}

  @impl GenServer
  def terminate(_reason, %{active: nil}), do: :ok

  def terminate(_reason, %{active: %{pid: pid, monitor: monitor}}) do
    Process.demonitor(monitor, [:flush])
    Process.exit(pid, :shutdown)
    :ok
  end

  defp apply_result(state, scope, entries, {:ok, response}) do
    batch_ids = Enum.map(entries, & &1.event_id)
    durable = response.accepted ++ response.duplicates
    terminal = response.conflicts
    returned = MapSet.new(durable ++ terminal)
    missing = Enum.reject(batch_ids, &MapSet.member?(returned, &1))

    Buffer.acknowledge(state.buffer, durable)
    Buffer.drop_batch(state.buffer, terminal, :fingerprint_conflict)

    if terminal != [] do
      summarize_gap(scope, entries, terminal, :fingerprint_conflict)
    end

    if missing != [] do
      Buffer.drop_batch(state.buffer, missing, :malformed_response)
      summarize_gap(scope, entries, missing, :malformed_response)
    end

    Telemetry.execute(
      [:diagnostics, :export],
      %{count: length(durable), bytes: Enum.sum(Enum.map(entries, & &1.bytes))},
      %{outcome: :success}
    )

    next = %{
      state
      | retries: 0,
        failures: 0,
        last_failure_reason: nil,
        last_success_at_ms: now_ms(),
        exported: state.exported + length(durable),
        dropped: state.dropped + length(terminal) + length(missing)
    }

    apply_partial_drop(next, terminal, missing)
  end

  defp apply_result(state, scope, entries, {:terminal, reason}) do
    ids = Enum.map(entries, & &1.event_id)
    Buffer.drop_batch(state.buffer, ids, reason)
    summarize_gap(scope, entries, ids, reason)
    observe_failure(:dropped, reason, length(ids))

    state
    |> record_failure(reason)
    |> Map.merge(%{
      retries: 0,
      dropped: state.dropped + length(ids),
      dropped_batches: state.dropped_batches + 1
    })
  end

  defp apply_result(state, scope, entries, {:retryable, reason}) do
    if state.retries + 1 >= state.max_retries do
      ids = Enum.map(entries, & &1.event_id)
      Buffer.drop_batch(state.buffer, ids, :retry_exhausted)
      summarize_gap(scope, entries, ids, :retry_exhausted)

      observe_failure(:retry_exhausted, reason, length(ids))

      state
      |> record_failure(reason)
      |> Map.merge(%{
        retries: 0,
        dropped: state.dropped + length(ids),
        dropped_batches: state.dropped_batches + 1
      })
    else
      failure(state, reason)
    end
  end

  defp apply_partial_drop(state, [], []), do: state

  defp apply_partial_drop(state, terminal, missing) do
    reason = if missing == [], do: :fingerprint_conflict, else: :malformed_response
    count = length(terminal) + length(missing)
    observe_failure(:dropped, reason, count)
    next = record_failure(state, reason)
    %{next | dropped_batches: state.dropped_batches + 1}
  end

  defp failure(state, reason) do
    observe_failure(:retryable, reason, 1)
    next = record_failure(state, reason)
    %{next | retries: state.retries + 1}
  end

  defp record_failure(state, reason) do
    reason = bounded_reason(reason)

    %{
      state
      | failures: state.failures + 1,
        total_failures: state.total_failures + 1,
        last_failure_reason: reason,
        last_failure_at_ms: now_ms()
    }
  end

  defp observe_failure(outcome, reason, count) do
    reason = bounded_reason(reason)

    Telemetry.execute(
      [:diagnostics, :export],
      %{count: count},
      %{outcome: outcome, reason: reason}
    )

    Logger.warning(
      "Episode Diagnostic export failed: outcome=#{outcome} reason=#{reason} event_count=#{count}"
    )
  end

  defp bounded_reason(reason) when is_atom(reason) do
    if Transport.failure_reason?(reason), do: reason, else: :transport_error
  end

  defp bounded_reason(_reason), do: :transport_error

  defp summarize_gap(scope, entries, dropped_ids, reason) do
    dropped = MapSet.new(dropped_ids)

    count =
      Enum.count(entries, fn entry ->
        MapSet.member?(dropped, entry.event_id) and entry.event["name"] != "coverage.gap"
      end)

    Diagnostics.gap(scope_key(scope), reason, count)
  end

  defp delay(state, {:retryable, _reason}) do
    min(state.interval_ms * Integer.pow(2, min(state.retries, 10)), state.max_backoff_ms)
  end

  defp delay(state, _result), do: state.interval_ms

  defp scope_key(scope) do
    %EpisodeKey{
      tenant_id: scope["tenantId"],
      space_id: scope["spaceId"],
      episode_id: scope["episodeId"]
    }
  end

  defp positive(options, key, default) do
    case Keyword.get(options, key, default) do
      value when is_integer(value) and value > 0 -> value
      _ -> default
    end
  end

  defp schedule(delay), do: Process.send_after(self(), :export, max(delay, 1))

  defp now_ms, do: System.monotonic_time(:millisecond)
  defp age_ms(nil), do: nil
  defp age_ms(timestamp), do: max(now_ms() - timestamp, 0)
end
