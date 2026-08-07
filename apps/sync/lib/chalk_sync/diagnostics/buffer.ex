defmodule ChalkSync.Diagnostics.Buffer do
  @moduledoc "Count-, byte-, and age-bounded direct-write ETS diagnostic buffer."

  use GenServer

  alias ChalkSync.Telemetry

  @registry __MODULE__.Registry
  @default_max_events 2_000
  @default_max_bytes 2 * 1024 * 1024
  @default_max_age_ms 60_000
  @default_sweep_limit 200

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @spec insert(GenServer.server(), map(), map(), binary()) ::
          {:ok, [atom()]} | {:error, atom()}
  def insert(server \\ __MODULE__, scope, event, encoded)

  def insert(server, scope, event, encoded)
      when is_map(scope) and is_map(event) and is_binary(encoded) do
    with {:ok, config} <- lookup(server),
         true <- byte_size(encoded) <= config.max_event_bytes do
      sequence = event["producerSequence"]
      event_id = event["eventId"]
      inserted_at = System.monotonic_time(:millisecond)
      row = {sequence, scope_key(scope), scope, event_id, event, byte_size(encoded), inserted_at}

      if :ets.insert_new(config.table, row) do
        increment(config.meta, :events, 1)
        increment(config.meta, :bytes, byte_size(encoded))
        {:ok, enforce_limits(config)}
      else
        {:error, :duplicate_sequence}
      end
    else
      false -> {:error, :event_too_large}
      {:error, reason} -> {:error, reason}
    end
  rescue
    _exception -> {:error, :buffer_unavailable}
  end

  def insert(_server, _scope, _event, _encoded), do: {:error, :invalid_event}

  @spec take_batch(GenServer.server(), pos_integer(), pos_integer()) ::
          :empty | {:ok, map(), [map()]}
  def take_batch(server \\ __MODULE__, max_events \\ 200, max_bytes \\ 256 * 1024)
      when max_events > 0 and max_bytes > 0 do
    with {:ok, config} <- lookup(server),
         first when first != :"$end_of_table" <- :ets.first(config.table),
         [{^first, scope_key, scope, _event_id, _event, _bytes, _inserted_at}] <-
           :ets.lookup(config.table, first) do
      entries = collect(config.table, first, scope_key, max_events, max_bytes, [], 0)
      {:ok, scope, entries}
    else
      _ -> :empty
    end
  rescue
    _exception -> :empty
  end

  @spec acknowledge(GenServer.server(), [binary()]) :: :ok
  def acknowledge(server \\ __MODULE__, event_ids) when is_list(event_ids) do
    case lookup(server) do
      {:ok, config} -> acknowledge_events(config, MapSet.new(event_ids))
      _error -> :ok
    end

    :ok
  rescue
    _exception -> :ok
  end

  @spec drop_batch(GenServer.server(), [binary()], atom()) :: :ok
  def drop_batch(server \\ __MODULE__, event_ids, reason) do
    acknowledge(server, event_ids)
    Telemetry.execute([:diagnostics, :buffer], %{count: length(event_ids)}, %{outcome: reason})
    :ok
  end

  @spec stats(GenServer.server()) :: map()
  def stats(server \\ __MODULE__) do
    case lookup(server) do
      {:ok, config} ->
        %{
          events: counter(config.meta, :events),
          bytes: counter(config.meta, :bytes),
          dropped: counter(config.meta, :dropped),
          max_events: config.max_events,
          max_bytes: config.max_bytes,
          max_age_ms: config.max_age_ms
        }

      _error ->
        %{status: :off}
    end
  end

  @impl GenServer
  def init(options) do
    ensure_registry()
    name = Keyword.get(options, :name, __MODULE__)
    table = :ets.new(__MODULE__, [:ordered_set, :public, read_concurrency: true])
    meta = :ets.new(__MODULE__.Meta, [:set, :public, write_concurrency: true])
    :ets.insert(meta, [{:events, 0}, {:bytes, 0}, {:dropped, 0}])

    config = %{
      table: table,
      meta: meta,
      max_events: positive(options, :max_events, @default_max_events),
      max_bytes: positive(options, :max_bytes, @default_max_bytes),
      max_age_ms: positive(options, :max_age_ms, @default_max_age_ms),
      max_event_bytes: positive(options, :max_event_bytes, 2_048),
      sweep_limit: positive(options, :sweep_limit, @default_sweep_limit)
    }

    true = :ets.insert(@registry, {name, config})
    schedule_sweep(config.max_age_ms)
    {:ok, Map.put(config, :name, name)}
  end

  @impl GenServer
  def handle_info(:sweep, state) do
    {removed, dropped_scopes} = sweep_expired(state, state.sweep_limit)

    dropped_scopes
    |> Enum.frequencies()
    |> Enum.each(fn {scope, count} -> ChalkSync.Diagnostics.gap(scope, :buffer_age, count) end)

    schedule_sweep(if(removed == state.sweep_limit, do: 1, else: state.max_age_ms))
    {:noreply, state}
  end

  @impl GenServer
  def terminate(_reason, state) do
    if :ets.whereis(@registry) != :undefined, do: :ets.delete(@registry, state.name)
    :ok
  end

  defp enforce_limits(config) do
    cond do
      counter(config.meta, :events) > config.max_events ->
        [:buffer_events | evict_oldest(config)]

      counter(config.meta, :bytes) > config.max_bytes ->
        [:buffer_bytes | evict_oldest(config)]

      true ->
        []
    end
  end

  defp evict_oldest(config) do
    case :ets.first(config.table) do
      :"$end_of_table" ->
        []

      sequence ->
        case :ets.take(config.table, sequence) do
          [{^sequence, _scope_key, _scope, _event_id, _event, bytes, _inserted_at}] ->
            increment(config.meta, :events, -1)
            increment(config.meta, :bytes, -bytes)
            increment(config.meta, :dropped, 1)
            enforce_limits(config)

          [] ->
            enforce_limits(config)
        end
    end
  end

  defp sweep_expired(config, limit) do
    cutoff = System.monotonic_time(:millisecond) - config.max_age_ms
    sweep_expired(config, :ets.first(config.table), cutoff, limit, 0, [])
  end

  defp sweep_expired(_config, :"$end_of_table", _cutoff, _limit, removed, scopes),
    do: {removed, scopes}

  defp sweep_expired(_config, _key, _cutoff, limit, removed, scopes) when removed >= limit,
    do: {removed, scopes}

  defp sweep_expired(config, sequence, cutoff, limit, removed, scopes) do
    case :ets.lookup(config.table, sequence) do
      [{^sequence, _scope_key, scope, _event_id, event, bytes, inserted_at}]
      when inserted_at <= cutoff ->
        next = :ets.next(config.table, sequence)

        sweep_expired_row(
          config,
          sequence,
          next,
          %{cutoff: cutoff, limit: limit, removed: removed, scopes: scopes},
          scope,
          event,
          bytes
        )

      _ ->
        {removed, scopes}
    end
  end

  defp sweep_expired_row(
         config,
         sequence,
         next,
         sweep,
         scope,
         event,
         bytes
       ) do
    case :ets.take(config.table, sequence) do
      [_row] ->
        increment(config.meta, :events, -1)
        increment(config.meta, :bytes, -bytes)
        increment(config.meta, :dropped, 1)

        scopes =
          if event["name"] == "coverage.gap", do: sweep.scopes, else: [scope | sweep.scopes]

        sweep_expired(config, next, sweep.cutoff, sweep.limit, sweep.removed + 1, scopes)

      [] ->
        sweep_expired(config, next, sweep.cutoff, sweep.limit, sweep.removed, sweep.scopes)
    end
  end

  defp acknowledge_events(config, accepted) do
    config.table
    |> :ets.tab2list()
    |> Enum.each(fn {sequence, _scope_key, _scope, event_id, _event, bytes, _inserted_at} ->
      if MapSet.member?(accepted, event_id), do: remove(config, sequence, bytes)
    end)
  end

  defp remove(config, sequence, bytes) do
    case :ets.take(config.table, sequence) do
      [_row] ->
        increment(config.meta, :events, -1)
        increment(config.meta, :bytes, -bytes)

      [] ->
        :ok
    end
  end

  defp collect(_table, :"$end_of_table", _scope_key, _max_events, _max_bytes, result, _bytes),
    do: Enum.reverse(result)

  defp collect(_table, _key, _scope_key, 0, _max_bytes, result, _bytes),
    do: Enum.reverse(result)

  defp collect(table, sequence, scope_key, max_events, max_bytes, result, bytes) do
    next = :ets.next(table, sequence)

    case :ets.lookup(table, sequence) do
      [{^sequence, ^scope_key, _scope, event_id, event, event_bytes, _inserted_at}]
      when bytes + event_bytes <= max_bytes ->
        collect(
          table,
          next,
          scope_key,
          max_events - 1,
          max_bytes,
          [%{event_id: event_id, event: event, bytes: event_bytes} | result],
          bytes + event_bytes
        )

      [_other_scope] ->
        collect(table, next, scope_key, max_events, max_bytes, result, bytes)

      [] ->
        collect(table, next, scope_key, max_events, max_bytes, result, bytes)
    end
  end

  defp scope_key(scope) do
    {scope["tenantId"], scope["spaceId"], scope["episodeId"], scope["participantId"]}
  end

  defp lookup(server) do
    case :ets.whereis(@registry) do
      :undefined ->
        {:error, :buffer_unavailable}

      _table ->
        case :ets.lookup(@registry, server) do
          [{^server, config}] -> {:ok, config}
          [] -> {:error, :buffer_unavailable}
        end
    end
  end

  defp ensure_registry do
    case :ets.whereis(@registry) do
      :undefined -> :ets.new(@registry, [:named_table, :public, :set])
      _table -> @registry
    end
  rescue
    ArgumentError -> @registry
  end

  defp increment(table, key, value), do: :ets.update_counter(table, key, {2, value}, {key, 0})

  defp counter(table, key) do
    case :ets.lookup(table, key) do
      [{^key, value}] -> max(value, 0)
      [] -> 0
    end
  end

  defp positive(options, key, default) do
    case Keyword.get(options, key, default) do
      value when is_integer(value) and value > 0 -> value
      _ -> default
    end
  end

  defp schedule_sweep(delay), do: Process.send_after(self(), :sweep, max(div(delay, 2), 1))
end
