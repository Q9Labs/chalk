defmodule ChalkSync.Diagnostics.Deadlines do
  @moduledoc "Bounded direct-write ETS deadlines for delayed diagnostic observations."

  use GenServer

  alias ChalkSync.Diagnostics

  @registry __MODULE__.Registry
  @default_max_entries 2_000
  @default_sweep_interval_ms 100
  @default_sweep_limit 200

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @spec track(term(), atom(), non_neg_integer(), keyword()) :: :ok
  def track(scope, constructor, delay_ms, options \\ []),
    do: track(__MODULE__, scope, constructor, delay_ms, options)

  @spec track(GenServer.server(), term(), atom(), non_neg_integer(), keyword()) :: :ok

  def track(server, scope, constructor, delay_ms, options)
      when is_atom(constructor) and is_integer(delay_ms) and delay_ms >= 0 and is_list(options) do
    case lookup(server) do
      {:ok, config} -> insert(config, scope, constructor, delay_ms, options)
      _unavailable -> :ok
    end

    :ok
  rescue
    _exception -> :ok
  catch
    :exit, _reason -> :ok
  end

  def track(_server, _scope, _constructor, _delay_ms, _options), do: :ok

  @spec stats(GenServer.server()) :: map()
  def stats(server \\ __MODULE__) do
    case lookup(server) do
      {:ok, config} -> %{entries: :ets.info(config.table, :size), max_entries: config.max_entries}
      _unavailable -> %{status: :off}
    end
  end

  @impl GenServer
  def init(options) do
    ensure_registry()
    name = Keyword.get(options, :name, __MODULE__)
    table = :ets.new(__MODULE__, [:ordered_set, :public, write_concurrency: true])

    config = %{
      table: table,
      max_entries: positive(options, :max_entries, @default_max_entries),
      sweep_interval_ms: positive(options, :sweep_interval_ms, @default_sweep_interval_ms),
      sweep_limit: positive(options, :sweep_limit, @default_sweep_limit)
    }

    true = :ets.insert(@registry, {name, config})
    schedule(config.sweep_interval_ms)
    {:ok, Map.put(config, :name, name)}
  end

  @impl GenServer
  def handle_info(:sweep, state) do
    removed = sweep(state, System.monotonic_time(:millisecond), state.sweep_limit, 0)
    schedule(if(removed == state.sweep_limit, do: 1, else: state.sweep_interval_ms))
    {:noreply, state}
  end

  @impl GenServer
  def terminate(_reason, state) do
    if :ets.whereis(@registry) != :undefined, do: :ets.delete(@registry, state.name)
    :ok
  end

  defp insert(config, scope, constructor, delay_ms, options) do
    now_ms = System.monotonic_time(:millisecond)
    deadline_at = DateTime.add(DateTime.utc_now(), delay_ms, :millisecond)
    key = {now_ms + delay_ms, System.unique_integer([:monotonic, :positive])}
    true = :ets.insert(config.table, {key, scope, constructor, deadline_at, options})
    enforce_limit(config)
  end

  defp enforce_limit(config) do
    if :ets.info(config.table, :size) > config.max_entries do
      case :ets.first(config.table) do
        :"$end_of_table" -> :ok
        key -> drop(config, key)
      end
    end
  end

  defp drop(config, key) do
    case :ets.take(config.table, key) do
      [{^key, scope, _constructor, _deadline_at, _options}] ->
        Diagnostics.gap(scope, :overloaded, 1)

      [] ->
        :ok
    end

    enforce_limit(config)
  end

  defp sweep(_state, _now_ms, limit, removed) when removed >= limit, do: removed

  defp sweep(state, now_ms, limit, removed) do
    case :ets.first(state.table) do
      {deadline_ms, _sequence} = key when deadline_ms <= now_ms ->
        case :ets.take(state.table, key) do
          [{^key, scope, constructor, deadline_at, options}] ->
            Diagnostics.record(
              constructor,
              scope,
              Keyword.put(options, :deadline_at, deadline_at)
            )

            sweep(state, now_ms, limit, removed + 1)

          [] ->
            sweep(state, now_ms, limit, removed)
        end

      _not_due ->
        removed
    end
  end

  defp lookup(server) do
    case :ets.whereis(@registry) do
      :undefined -> {:error, :unavailable}
      _table -> registry_entry(server)
    end
  end

  defp registry_entry(server) do
    case :ets.lookup(@registry, server) do
      [{^server, config}] -> {:ok, config}
      [] -> {:error, :unavailable}
    end
  end

  defp ensure_registry do
    case :ets.whereis(@registry) do
      :undefined -> :ets.new(@registry, [:named_table, :public, :set])
      table -> table
    end
  end

  defp positive(options, key, default) do
    case Keyword.get(options, key, default) do
      value when is_integer(value) and value > 0 -> value
      _invalid -> default
    end
  end

  defp schedule(delay_ms), do: Process.send_after(self(), :sweep, delay_ms)
end
