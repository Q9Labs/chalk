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
  def load(room_id), do: impl().load(room_id)

  @spec commit(String.t(), non_neg_integer(), Room.event(), Room.t()) ::
          :ok | {:error, {:revision_conflict, non_neg_integer()}}
  def commit(room_id, expected_revision, event, state),
    do: impl().commit(room_id, expected_revision, event, state)

  @spec events_since(String.t(), non_neg_integer()) ::
          {:ok, [Room.event()]} | {:error, :cursor_unavailable}
  def events_since(room_id, cursor), do: impl().events_since(room_id, cursor)
end
