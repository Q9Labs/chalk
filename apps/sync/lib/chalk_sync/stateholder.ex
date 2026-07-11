defmodule ChalkSync.Stateholder do
  @moduledoc """
  Port for the sync stateholder — the single source of truth for durable room
  state (north star: "Stateholder = single source of truth").

  Adapters: `ChalkSync.Stateholder.Memory` (ETS, single-node dev/test) today;
  Redis is the named next adapter and must be a drop-in behind this behaviour.
  Vendor specifics never leak past it.

  `commit/4` is compare-and-set on the revision: it fails on mismatch rather
  than overwriting, so a split-brain writer loses instead of corrupting state.
  Adapters retain a bounded tail of events per room for reconnect replay;
  `events_since/2` returns `{:error, :cursor_unavailable}` once a cursor falls
  out of retention, which forces a snapshot.
  """

  alias ChalkSync.Rooms.Room

  @callback load(room_id :: String.t()) :: {:ok, Room.t()} | :not_found
  @callback commit(
              room_id :: String.t(),
              expected_revision :: non_neg_integer(),
              event :: Room.event(),
              state :: Room.t()
            ) :: :ok | {:error, {:revision_conflict, non_neg_integer()}}
  @callback events_since(room_id :: String.t(), cursor :: non_neg_integer()) ::
              {:ok, [Room.event()]} | {:error, :cursor_unavailable}

  @spec impl() :: module()
  def impl, do: Application.fetch_env!(:chalk_sync, :stateholder)

  @spec load(String.t()) :: {:ok, Room.t()} | :not_found
  def load(room_id, observability \\ nil) do
    result = impl().load(room_id)

    ChalkSync.Observability.linked_phase(observability, "sync.stateholder.load", %{
      result: load_result(result)
    })

    result
  end

  @spec commit(String.t(), non_neg_integer(), Room.event(), Room.t()) ::
          :ok | {:error, {:revision_conflict, non_neg_integer()}}
  def commit(room_id, expected_revision, event, state, observability \\ nil) do
    result = impl().commit(room_id, expected_revision, event, state)

    ChalkSync.Observability.linked_phase(observability, "sync.stateholder.commit", %{
      result: commit_result(result)
    })

    result
  end

  @spec events_since(String.t(), non_neg_integer()) ::
          {:ok, [Room.event()]} | {:error, :cursor_unavailable}
  def events_since(room_id, cursor, observability \\ nil) do
    result = impl().events_since(room_id, cursor)

    ChalkSync.Observability.linked_phase(observability, "sync.stateholder.replay", %{
      result: replay_result(result)
    })

    result
  end

  defp load_result({:ok, _room}), do: "found"
  defp load_result(:not_found), do: "not_found"
  defp commit_result(:ok), do: "committed"
  defp commit_result({:error, {:revision_conflict, _current}}), do: "revision_conflict"
  defp replay_result({:ok, _events}), do: "available"
  defp replay_result({:error, :cursor_unavailable}), do: "cursor_unavailable"
end
