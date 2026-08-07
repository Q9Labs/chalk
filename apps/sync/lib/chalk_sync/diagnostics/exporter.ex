defmodule ChalkSync.Diagnostics.Exporter do
  @moduledoc "Finite-batch, finite-retry Episode Diagnostic exporter."

  use GenServer

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
      failures: 0,
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
       failures: state.failures,
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
    Buffer.drop_batch(state.buffer, terminal, :conflict)

    if missing != [] do
      Buffer.drop_batch(state.buffer, missing, :malformed_response)
      summarize_gap(scope, entries, missing, :malformed_response)
    end

    Telemetry.execute(
      [:diagnostics, :export],
      %{count: length(durable), bytes: Enum.sum(Enum.map(entries, & &1.bytes))},
      %{outcome: :success}
    )

    %{
      state
      | retries: 0,
        failures: 0,
        exported: state.exported + length(durable),
        dropped: state.dropped + length(terminal) + length(missing)
    }
  end

  defp apply_result(state, scope, entries, {:terminal, reason}) do
    ids = Enum.map(entries, & &1.event_id)
    Buffer.drop_batch(state.buffer, ids, reason)
    summarize_gap(scope, entries, ids, reason)
    Telemetry.execute([:diagnostics, :export], %{count: length(ids)}, %{outcome: :dropped})
    %{state | retries: 0, dropped: state.dropped + length(ids), failures: state.failures + 1}
  end

  defp apply_result(state, scope, entries, {:retryable, reason}) do
    if state.retries + 1 >= state.max_retries do
      ids = Enum.map(entries, & &1.event_id)
      Buffer.drop_batch(state.buffer, ids, :retry_exhausted)
      summarize_gap(scope, entries, ids, :retry_exhausted)

      Telemetry.execute(
        [:diagnostics, :export],
        %{count: length(ids)},
        %{outcome: :retry_exhausted}
      )

      %{
        state
        | retries: 0,
          dropped: state.dropped + length(ids),
          failures: state.failures + 1
      }
    else
      failure(state, reason)
    end
  end

  defp failure(state, reason) do
    Telemetry.execute([:diagnostics, :export], %{count: 1}, %{outcome: :retryable})
    _reason = reason
    %{state | retries: state.retries + 1, failures: state.failures + 1}
  end

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
end
