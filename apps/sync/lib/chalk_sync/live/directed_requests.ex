defmodule ChalkSync.Live.DirectedRequests do
  @moduledoc "Bounded, expiring, non-replayable delivery for directed media requests."

  @ttl_ms 30_000
  @per_actor_target_limit 4
  @max_pending 1_024
  @max_recent 2_048
  @max_connections 2_000
  @max_connections_per_participant 8
  @max_bytes 1_048_576

  alias ChalkSync.UUID

  @enforce_keys [:connections, :pending, :recent, :rates]
  defstruct connections: %{}, pending: %{}, recent: %{}, rates: %{}

  @type t :: %__MODULE__{}
  @type result :: :delivered | :target_unavailable | :expired | :rejected | :rate_limited

  @spec new() :: t()
  def new, do: %__MODULE__{connections: %{}, pending: %{}, recent: %{}, rates: %{}}

  @spec register(t(), String.t(), pid()) :: {:ok, t()} | {:error, atom()}
  def register(%__MODULE__{} = state, participant_session_id, connection)
      when is_binary(participant_session_id) and is_pid(connection) do
    if canonical_uuid?(participant_session_id) do
      register_connection(prune_connections(state), participant_session_id, connection)
    else
      {:error, :invalid_participant}
    end
  end

  defp register_connection(state, participant_session_id, connection) do
    existing = Map.get(state.connections, participant_session_id, MapSet.new())

    cond do
      connection_count(state) >= @max_connections and not MapSet.member?(existing, connection) ->
        {:error, :connection_limit}

      MapSet.size(existing) >= @max_connections_per_participant and
          not MapSet.member?(existing, connection) ->
        {:error, :participant_connection_limit}

      true ->
        {:ok, put_in(state.connections[participant_session_id], MapSet.put(existing, connection))}
    end
  end

  @spec unregister(t(), String.t(), pid()) :: t()
  def unregister(%__MODULE__{} = state, participant_session_id, connection) do
    remaining =
      state.connections
      |> Map.get(participant_session_id, MapSet.new())
      |> MapSet.delete(connection)

    if MapSet.size(remaining) == 0,
      do: %{state | connections: Map.delete(state.connections, participant_session_id)},
      else: put_in(state.connections[participant_session_id], remaining)
  end

  @spec deliver(t(), map(), integer()) :: {t(), result()}
  def deliver(%__MODULE__{} = state, request, now_ms) do
    state = state |> prune(now_ms) |> prune_connections()

    with :ok <- validate_request(request),
         :new <- duplicate(state, request),
         :ok <- rate_available(state, request),
         true <- map_size(state.pending) < @max_pending,
         true <- map_size(state.recent) < @max_recent do
      deliver_new(state, request, now_ms)
    else
      {:duplicate, result} -> {state, result}
      {:conflict, _result} -> {state, :rejected}
      {:error, :rate_limited} -> remember(state, request, :rate_limited, now_ms)
      {:error, _reason} -> {state, :rejected}
      false -> {state, :rejected}
    end
  end

  @spec acknowledge(t(), String.t(), String.t(), integer()) :: {:ok, t()} | {:error, atom(), t()}
  def acknowledge(%__MODULE__{} = state, participant_session_id, request_id, now_ms) do
    state = prune(state, now_ms)

    case Map.get(state.pending, request_id) do
      %{target: ^participant_session_id} ->
        {:ok, %{state | pending: Map.delete(state.pending, request_id)}}

      nil ->
        {:error, :unknown_request, state}

      _pending ->
        {:error, :wrong_target, state}
    end
  end

  @spec expire(t(), integer()) :: {t(), [map()]}
  def expire(%__MODULE__{} = state, now_ms) do
    {expired, retained} =
      Enum.split_with(state.pending, fn {_id, item} -> item.expires_at_ms <= now_ms end)

    next = %{state | pending: Map.new(retained)}

    Enum.reduce(expired, {prune(next, now_ms), []}, fn {request_id, item}, {current, results} ->
      recent =
        Map.put(current.recent, request_id, %{item.recent | result: :expired, at_ms: now_ms})

      result = %{
        request_id: request_id,
        actor_participant_session_id: item.actor,
        result: :expired
      }

      {%{current | recent: recent}, [result | results]}
    end)
  end

  @spec stats(t()) :: map()
  def stats(%__MODULE__{} = state) do
    %{
      connections: connection_count(state),
      pending: map_size(state.pending),
      recent: map_size(state.recent),
      rate_pairs: map_size(state.rates),
      retained_bytes: retained_bytes(state)
    }
  end

  defp deliver_new(state, request, now_ms) do
    state = record_rate(state, request, now_ms)
    connections = active_connections(state, request.target_participant_session_id)

    if connections == [] do
      remember(state, request, :target_unavailable, now_ms)
    else
      expires_at_ms = now_ms + @ttl_ms

      frame = %{
        "type" => "directed_request",
        "request_id" => request.request_id,
        "name" => Atom.to_string(request.name),
        "actor_participant_session_id" => request.actor_participant_session_id,
        "expires_at_ms" => expires_at_ms
      }

      Enum.each(connections, &send(&1, {:directed_request, frame}))
      {state, :delivered} = remember(state, request, :delivered, now_ms)
      recent = Map.fetch!(state.recent, request.request_id)

      pending =
        Map.put(state.pending, request.request_id, pending(request, expires_at_ms, recent))

      bounded(%{state | pending: pending}, request, now_ms)
    end
  end

  defp remember(state, request, result, now_ms) do
    recent = %{
      fingerprint: fingerprint(request),
      result: result,
      at_ms: now_ms,
      expires_at_ms: now_ms + @ttl_ms
    }

    bounded(%{state | recent: Map.put(state.recent, request.request_id, recent)}, request, now_ms)
  end

  defp bounded(state, request, now_ms) do
    if retained_bytes(state) <= @max_bytes,
      do: {state, Map.fetch!(state.recent, request.request_id).result},
      else: remember_without_payload(state, request, now_ms)
  end

  defp remember_without_payload(state, request, now_ms) do
    recent = %{
      fingerprint: fingerprint(request),
      result: :rejected,
      at_ms: now_ms,
      expires_at_ms: now_ms + @ttl_ms
    }

    {%{
       state
       | pending: Map.delete(state.pending, request.request_id),
         recent: %{request.request_id => recent}
     }, :rejected}
  end

  defp prune(state, now_ms) do
    recent = Map.reject(state.recent, fn {_id, item} -> item.expires_at_ms <= now_ms end)

    rates =
      state.rates
      |> Map.new(fn {pair, times} ->
        {pair, Enum.reject(times, &(&1 + @ttl_ms <= now_ms))}
      end)
      |> Map.reject(fn {_pair, times} -> times == [] end)

    %{state | recent: recent, rates: rates}
  end

  defp active_connections(state, participant_session_id) do
    state.connections
    |> Map.get(participant_session_id, MapSet.new())
    |> Enum.filter(&Process.alive?/1)
  end

  defp prune_connections(state) do
    connections =
      state.connections
      |> Map.new(fn {participant, registered} ->
        {participant, MapSet.filter(registered, &Process.alive?/1)}
      end)
      |> Map.reject(fn {_participant, registered} -> MapSet.size(registered) == 0 end)

    %{state | connections: connections}
  end

  defp duplicate(state, request) do
    case Map.get(state.recent, request.request_id) do
      nil ->
        :new

      %{fingerprint: fingerprint, result: result} ->
        if fingerprint == fingerprint(request),
          do: {:duplicate, result},
          else: {:conflict, result}
    end
  end

  defp rate_available(state, request) do
    count = state.rates |> Map.get(pair(request), []) |> length()
    if count < @per_actor_target_limit, do: :ok, else: {:error, :rate_limited}
  end

  defp record_rate(state, request, now_ms) do
    Map.update!(
      state,
      :rates,
      &Map.update(&1, pair(request), [now_ms], fn times -> [now_ms | times] end)
    )
  end

  defp pair(request),
    do: {request.actor_participant_session_id, request.target_participant_session_id}

  defp fingerprint(request),
    do:
      {request.name, request.actor_participant_session_id, request.target_participant_session_id}

  defp pending(request, expires_at_ms, recent) do
    %{
      actor: request.actor_participant_session_id,
      target: request.target_participant_session_id,
      expires_at_ms: expires_at_ms,
      recent: recent
    }
  end

  defp validate_request(request) when is_map(request) do
    cond do
      not request_id?(request[:request_id]) -> {:error, :invalid_request_id}
      request[:name] not in [:request_unmute, :request_start_camera] -> {:error, :invalid_name}
      not canonical_uuid?(request[:actor_participant_session_id]) -> {:error, :invalid_actor}
      not canonical_uuid?(request[:target_participant_session_id]) -> {:error, :invalid_target}
      true -> :ok
    end
  end

  defp validate_request(_request), do: {:error, :invalid_request}

  defp request_id?(value) when is_binary(value),
    do: byte_size(value) in 16..64 and value =~ ~r/\A[A-Za-z0-9_-]+\z/

  defp request_id?(_value), do: false

  defp canonical_uuid?(value), do: match?({:ok, _bytes}, UUID.dump(value))

  defp connection_count(state),
    do:
      Enum.sum(
        Enum.map(state.connections, fn {_participant, connections} -> MapSet.size(connections) end)
      )

  defp retained_bytes(state) do
    state.pending
    |> :erlang.term_to_binary()
    |> byte_size()
    |> Kernel.+(byte_size(:erlang.term_to_binary(state.recent)))
    |> Kernel.+(byte_size(:erlang.term_to_binary(state.rates)))
  end
end
