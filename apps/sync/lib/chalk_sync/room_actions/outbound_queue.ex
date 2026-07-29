defmodule ChalkSync.RoomActions.OutboundQueue do
  @moduledoc """
  Bounded logical queue for room-action frames on a Sync v3 socket.

  The owning socket process calls this queue directly. `take/2` enforces the
  frozen room-action burst before yielding back to pending control traffic.
  """

  @frame_limit 32_768
  @page_limit 131_072
  @event_limit 256
  @byte_limit 8_388_608
  @burst_limit 8

  @enforce_keys [:entries, :state, :owner]
  defstruct [:entries, :state, :owner]

  @type kind :: :frame | :chat_page
  @type entry :: %{sequence: pos_integer(), encoded: binary(), kind: kind()}
  @opaque t :: %__MODULE__{entries: :ets.tid(), state: :ets.tid(), owner: pid()}

  @spec new() :: t()
  def new do
    entries = :ets.new(__MODULE__, [:ordered_set, :private])
    state = :ets.new(__MODULE__, [:set, :private])

    :ets.insert(
      state,
      {:state, %{frames: 0, bytes: 0, next_sequence: 1, room_action_burst: 0}}
    )

    %__MODULE__{entries: entries, state: state, owner: self()}
  end

  @spec push(t(), binary(), keyword()) ::
          :ok | {:error, :not_owner | :closed | {:overflow, atom()}}
  def push(queue, encoded, options \\ []) when is_binary(encoded) do
    kind = Keyword.get(options, :kind, :frame)

    with :ok <- owner_open?(queue),
         {:ok, state} <- queue_state(queue),
         :ok <- within_entry_limit(encoded, kind),
         :ok <- within_queue_limit(state, byte_size(encoded)) do
      sequence = state.next_sequence
      :ets.insert(queue.entries, {sequence, encoded, kind})

      put_state(queue, %{
        state
        | frames: state.frames + 1,
          bytes: state.bytes + byte_size(encoded),
          next_sequence: sequence + 1
      })

      :ok
    end
  end

  @spec take(t(), boolean()) ::
          {:ok, entry()}
          | :empty
          | :control_required
          | {:error, :not_owner | :closed}
  def take(queue, control_pending? \\ false) when is_boolean(control_pending?) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- queue_state(queue) do
      cond do
        state.frames == 0 ->
          :empty

        control_pending? and state.room_action_burst >= @burst_limit ->
          :control_required

        true ->
          sequence = :ets.first(queue.entries)
          [{^sequence, encoded, kind}] = :ets.take(queue.entries, sequence)

          put_state(queue, %{
            state
            | frames: state.frames - 1,
              bytes: state.bytes - byte_size(encoded),
              room_action_burst: min(state.room_action_burst + 1, @burst_limit)
          })

          {:ok, %{sequence: sequence, encoded: encoded, kind: kind}}
      end
    end
  end

  @spec control_checked(t()) :: :ok | {:error, :not_owner | :closed}
  def control_checked(queue) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- queue_state(queue) do
      put_state(queue, %{state | room_action_burst: 0})
      :ok
    end
  end

  @spec stats(t()) ::
          {:ok, %{queued_frames: non_neg_integer(), queued_bytes: non_neg_integer(), burst: 0..8}}
          | {:error, :not_owner | :closed}
  def stats(queue) do
    with :ok <- owner_open?(queue),
         {:ok, state} <- queue_state(queue) do
      {:ok,
       %{
         queued_frames: state.frames,
         queued_bytes: state.bytes,
         burst: min(state.room_action_burst, @burst_limit)
       }}
    end
  end

  @spec close(t()) :: :ok | {:error, :not_owner | :closed}
  def close(queue) do
    with :ok <- owner_open?(queue),
         {:ok, _state} <- queue_state(queue) do
      :ets.delete(queue.entries)
      :ets.delete(queue.state)
      :ok
    end
  end

  defp within_entry_limit(encoded, :frame) when byte_size(encoded) <= @frame_limit, do: :ok
  defp within_entry_limit(encoded, :chat_page) when byte_size(encoded) <= @page_limit, do: :ok
  defp within_entry_limit(_encoded, :frame), do: {:error, {:overflow, :frame_bytes}}
  defp within_entry_limit(_encoded, :chat_page), do: {:error, {:overflow, :page_bytes}}
  defp within_entry_limit(_encoded, _kind), do: {:error, {:overflow, :invalid_kind}}

  defp within_queue_limit(state, bytes) do
    cond do
      state.frames >= @event_limit -> {:error, {:overflow, :frame_count}}
      state.bytes + bytes > @byte_limit -> {:error, {:overflow, :queue_bytes}}
      true -> :ok
    end
  end

  defp owner_open?(%__MODULE__{owner: owner}) when owner != self(), do: {:error, :not_owner}

  defp owner_open?(%__MODULE__{state: state}) do
    if :ets.info(state) == :undefined, do: {:error, :closed}, else: :ok
  end

  defp queue_state(queue) do
    case :ets.lookup(queue.state, :state) do
      [{:state, state}] -> {:ok, state}
      [] -> {:error, :closed}
    end
  end

  defp put_state(queue, state), do: :ets.insert(queue.state, {:state, state})
end
