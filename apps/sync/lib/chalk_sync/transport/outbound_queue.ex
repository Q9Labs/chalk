defmodule ChalkSync.Transport.OutboundQueue do
  @moduledoc """
  A bounded, single-writer queue for one socket's encoded outbound frames.

  The process that creates the queue is its only caller. This mirrors the socket
  coordinator's serialized control path and prevents ETS counter races. The
  queue stores encoded payloads in private ETS tables and never sends process
  messages; callers decide whether to send a coalesced wake-up signal.

  `push/3` accepts a binary that is already encoded for the WebSocket transport.
  Optional revision, digest, and replay-page metadata travel with an entry.
  `pop/1` marks the next entry as transport in-flight without releasing its
  reservation. `ack/3` releases a cumulative prefix only after the client
  reports that it applied the matching revision and state digest. This keeps
  hidden kernel and WebSocket buffers inside the declared event, byte, and age
  bounds. `ack_recovery/3` releases exactly the oldest in-flight recovery frame,
  including a revision-zero snapshot, without touching live reservations.
  """

  @event_limit 256
  @byte_limit 1_048_576
  @max_age_ms 5_000
  @replay_page_limit 5

  @enforce_keys [:entries, :state, :owner, :clock]
  defstruct [:entries, :state, :owner, :clock]

  @typedoc "An encoded queued or in-flight frame and its transport metadata."
  @type entry :: %{
          sequence: pos_integer(),
          encoded: binary(),
          revision: non_neg_integer() | nil,
          state_digest: String.t() | nil,
          replay_page?: boolean(),
          enqueued_at_ms: integer()
        }

  @type stats :: %{
          queued_events: non_neg_integer(),
          queued_bytes: non_neg_integer(),
          queued_replay_pages: non_neg_integer(),
          unsent_events: non_neg_integer(),
          in_flight_events: non_neg_integer(),
          oldest_age_ms: non_neg_integer() | nil
        }

  @opaque t :: %__MODULE__{
            entries: :ets.tid(),
            state: :ets.tid(),
            owner: pid(),
            clock: (-> integer())
          }

  @spec new(keyword()) :: t()
  def new(options \\ []) do
    clock = Keyword.get(options, :clock, fn -> System.monotonic_time(:millisecond) end)
    entries = :ets.new(__MODULE__, [:ordered_set, :private])
    state = :ets.new(__MODULE__, [:set, :private])

    :ets.insert(
      state,
      {:state,
       %{
         events: 0,
         bytes: 0,
         replay_pages: 0,
         next_sequence: 0,
         next_unsent_sequence: 1
       }}
    )

    %__MODULE__{entries: entries, state: state, owner: self(), clock: clock}
  end

  @spec push(t(), binary(), keyword()) ::
          :ok | {:error, :not_owner | :closed | {:overflow, atom()}}
  def push(queue, encoded, options \\ []) when is_binary(encoded) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- state(queue),
         :ok <- expire_if_needed(queue, state),
         {:ok, current} <- state(queue) do
      reserve(queue, current, encoded, options)
    end
  end

  @spec peek(t()) ::
          {:ok, entry()} | :empty | {:error, :not_owner | :closed | {:overflow, atom()}}
  def peek(queue) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- state(queue),
         :ok <- expire_if_needed(queue, state) do
      case :ets.first(queue.entries) do
        :"$end_of_table" -> :empty
        sequence -> {:ok, entry(sequence, queue)}
      end
    end
  end

  @spec pop(t()) ::
          {:ok, entry()} | :empty | {:error, :not_owner | :closed | {:overflow, atom()}}
  def pop(queue) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- state(queue),
         :ok <- expire_if_needed(queue, state) do
      if state.next_unsent_sequence > state.next_sequence do
        :empty
      else
        sequence = state.next_unsent_sequence
        queued = entry(sequence, queue)
        put_state(queue, %{state | next_unsent_sequence: sequence + 1})
        {:ok, queued}
      end
    end
  end

  @doc "Removes the next unsent frame when transport delivery needs no client acknowledgment."
  @spec take(t()) ::
          {:ok, entry()} | :empty | {:error, :not_owner | :closed | {:overflow, atom()}}
  def take(queue) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- state(queue),
         :ok <- expire_if_needed(queue, state) do
      if state.next_unsent_sequence > state.next_sequence do
        :empty
      else
        sequence = state.next_unsent_sequence
        queued = entry(sequence, queue)
        :ets.delete(queue.entries, sequence)

        put_state(queue, %{
          state
          | events: state.events - 1,
            bytes: state.bytes - byte_size(queued.encoded),
            replay_pages: state.replay_pages - replay_page_count(queued.replay_page?),
            next_unsent_sequence: sequence + 1
        })

        {:ok, queued}
      end
    end
  end

  @spec ack(t(), pos_integer(), String.t()) ::
          {:ok, stats()}
          | {:error, :not_owner | :closed | :unknown_ack | :digest_mismatch | {:overflow, atom()}}
  def ack(queue, revision, state_digest)
      when is_integer(revision) and revision >= 1 and is_binary(state_digest) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- state(queue),
         :ok <- expire_if_needed(queue, state),
         {:ok, sequence, acknowledged} <- find_sent_revision(queue, state, revision),
         :ok <- matching_digest(acknowledged, state_digest) do
      released = entries_through(queue, sequence)
      Enum.each(released, &:ets.delete(queue.entries, &1.sequence))

      next = %{
        state
        | events: state.events - length(released),
          bytes: state.bytes - Enum.sum(Enum.map(released, &byte_size(&1.encoded))),
          replay_pages:
            state.replay_pages -
              Enum.sum(Enum.map(released, &replay_page_count(&1.replay_page?)))
      }

      put_state(queue, next)
      {:ok, stats(queue, next)}
    end
  end

  def ack(_queue, _revision, _state_digest), do: {:error, :unknown_ack}

  @spec ack_recovery(t(), non_neg_integer(), String.t()) ::
          {:ok, stats()}
          | {:error, :not_owner | :closed | :unknown_ack | :digest_mismatch | {:overflow, atom()}}
  def ack_recovery(queue, revision, state_digest)
      when is_integer(revision) and revision >= 0 and is_binary(state_digest) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- state(queue),
         :ok <- expire_if_needed(queue, state),
         sequence when sequence != :"$end_of_table" <- :ets.first(queue.entries),
         true <- sequence < state.next_unsent_sequence,
         acknowledged = entry(sequence, queue),
         true <- acknowledged.revision == revision,
         :ok <- matching_digest(acknowledged, state_digest) do
      :ets.delete(queue.entries, sequence)

      next = %{
        state
        | events: state.events - 1,
          bytes: state.bytes - byte_size(acknowledged.encoded),
          replay_pages: state.replay_pages - replay_page_count(acknowledged.replay_page?)
      }

      put_state(queue, next)
      {:ok, stats(queue, next)}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :unknown_ack}
    end
  end

  def ack_recovery(_queue, _revision, _state_digest), do: {:error, :unknown_ack}

  @spec unsent?(t()) ::
          {:ok, boolean()} | {:error, :not_owner | :closed | {:overflow, atom()}}
  def unsent?(queue) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- state(queue),
         :ok <- expire_if_needed(queue, state) do
      {:ok, state.next_unsent_sequence <= state.next_sequence}
    end
  end

  @spec outstanding?(t()) ::
          {:ok, boolean()} | {:error, :not_owner | :closed | {:overflow, atom()}}
  def outstanding?(queue) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- state(queue),
         :ok <- expire_if_needed(queue, state) do
      {:ok, state.events > 0}
    end
  end

  @spec stats(t()) :: {:ok, stats()} | {:error, :not_owner | :closed | {:overflow, atom()}}
  def stats(queue) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- state(queue),
         :ok <- expire_if_needed(queue, state) do
      {:ok, stats(queue, state)}
    end
  end

  @spec close(t()) :: {:ok, stats()} | {:error, :not_owner | :closed}
  def close(queue) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- state(queue) do
      snapshot = stats(queue, state)
      :ets.delete(queue.entries)
      :ets.delete(queue.state)
      {:ok, snapshot}
    end
  end

  defp reserve(queue, state, encoded, options) do
    replay_page? = Keyword.get(options, :replay_page?, false)
    bytes = byte_size(encoded)

    case overflow_reason(state, bytes, replay_page?) do
      nil ->
        sequence = state.next_sequence + 1
        enqueued_at_ms = now(queue)
        revision = Keyword.get(options, :revision)
        state_digest = Keyword.get(options, :state_digest)

        :ets.insert(
          queue.entries,
          {sequence, encoded, revision, state_digest, replay_page?, enqueued_at_ms}
        )

        put_state(queue, %{
          state
          | events: state.events + 1,
            bytes: state.bytes + bytes,
            replay_pages: state.replay_pages + replay_page_count(replay_page?),
            next_sequence: sequence
        })

        :ok

      limit ->
        close_tables(queue)
        {:error, {:overflow, limit}}
    end
  end

  defp expire_if_needed(queue, state) do
    case oldest_age_ms(queue, state) do
      age_ms when is_integer(age_ms) and age_ms >= @max_age_ms ->
        close_tables(queue)
        {:error, {:overflow, :age_limit}}

      _ ->
        :ok
    end
  end

  defp overflow_reason(state, bytes, replay_page?) do
    cond do
      state.events + 1 > @event_limit ->
        :event_limit

      state.bytes + bytes > @byte_limit ->
        :byte_limit

      state.replay_pages + replay_page_count(replay_page?) > @replay_page_limit ->
        :replay_page_limit

      true ->
        nil
    end
  end

  defp entry(sequence, queue) do
    [{^sequence, encoded, revision, state_digest, replay_page?, enqueued_at_ms}] =
      :ets.lookup(queue.entries, sequence)

    %{
      sequence: sequence,
      encoded: encoded,
      revision: revision,
      state_digest: state_digest,
      replay_page?: replay_page?,
      enqueued_at_ms: enqueued_at_ms
    }
  end

  defp stats(queue, state) do
    unsent_events = max(state.next_sequence - state.next_unsent_sequence + 1, 0)

    %{
      queued_events: state.events,
      queued_bytes: state.bytes,
      queued_replay_pages: state.replay_pages,
      unsent_events: unsent_events,
      in_flight_events: state.events - unsent_events,
      oldest_age_ms: oldest_age_ms(queue, state)
    }
  end

  defp oldest_age_ms(_queue, %{events: 0}), do: nil

  defp oldest_age_ms(queue, _state) do
    sequence = :ets.first(queue.entries)
    %{enqueued_at_ms: enqueued_at_ms} = entry(sequence, queue)
    max(now(queue) - enqueued_at_ms, 0)
  end

  defp find_sent_revision(queue, state, revision) do
    find_sent_revision(queue, :ets.first(queue.entries), state.next_unsent_sequence, revision)
  end

  defp find_sent_revision(_queue, :"$end_of_table", _next_unsent, _revision),
    do: {:error, :unknown_ack}

  defp find_sent_revision(_queue, sequence, next_unsent, _revision)
       when sequence >= next_unsent,
       do: {:error, :unknown_ack}

  defp find_sent_revision(queue, sequence, next_unsent, revision) do
    queued = entry(sequence, queue)

    cond do
      queued.revision == revision ->
        {:ok, sequence, queued}

      is_integer(queued.revision) and queued.revision > revision ->
        {:error, :unknown_ack}

      true ->
        find_sent_revision(queue, :ets.next(queue.entries, sequence), next_unsent, revision)
    end
  end

  defp matching_digest(%{state_digest: expected}, actual)
       when is_binary(actual) and expected == actual,
       do: :ok

  defp matching_digest(_entry, _digest), do: {:error, :digest_mismatch}

  defp entries_through(queue, target_sequence) do
    entries_through(queue, :ets.first(queue.entries), target_sequence, [])
  end

  defp entries_through(_queue, :"$end_of_table", _target_sequence, entries),
    do: Enum.reverse(entries)

  defp entries_through(queue, sequence, target_sequence, entries) do
    queued = entry(sequence, queue)
    next_entries = [queued | entries]

    if sequence == target_sequence do
      Enum.reverse(next_entries)
    else
      entries_through(
        queue,
        :ets.next(queue.entries, sequence),
        target_sequence,
        next_entries
      )
    end
  end

  defp state(queue) do
    case safe_lookup(queue.state, :state) do
      [{:state, state}] -> {:ok, state}
      [] -> {:error, :closed}
      :closed -> {:error, :closed}
    end
  end

  defp put_state(queue, state), do: :ets.insert(queue.state, {:state, state})

  defp owner_open?(%__MODULE__{owner: owner} = queue) do
    cond do
      owner != self() -> {:error, :not_owner}
      tables_open?(queue) -> :ok
      true -> {:error, :closed}
    end
  end

  defp tables_open?(queue),
    do: :ets.info(queue.entries) != :undefined and :ets.info(queue.state) != :undefined

  defp close_tables(queue) do
    safe_delete(queue.entries)
    safe_delete(queue.state)
  end

  defp safe_lookup(table, key) do
    :ets.lookup(table, key)
  catch
    :error, :badarg -> :closed
  end

  defp safe_delete(table) do
    :ets.delete(table)
  catch
    :error, :badarg -> :ok
  end

  defp replay_page_count(true), do: 1
  defp replay_page_count(false), do: 0
  defp now(queue), do: queue.clock.()
end
