defmodule ChalkSync.Stateholder.MemoryTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Rooms.Room
  alias ChalkSync.Stateholder.Memory

  test "commit then load roundtrips room state" do
    room_id = room_id()
    {event, room} = advance(Room.new(room_id), "p1")

    assert :ok = Memory.commit(room_id, 0, event, room)
    assert {:ok, ^room} = Memory.load(room_id)
  end

  test "compare-and-set rejects a stale writer" do
    room_id = room_id()
    {event, room} = advance(Room.new(room_id), "p1")
    assert :ok = Memory.commit(room_id, 0, event, room)

    {conflicting_event, conflicting_room} = advance(Room.new(room_id), "p2")

    assert {:error, {:revision_conflict, 1}} =
             Memory.commit(room_id, 0, conflicting_event, conflicting_room)

    assert {:ok, ^room} = Memory.load(room_id)
  end

  test "events_since replays in order from a cursor" do
    room_id = room_id()

    room =
      Enum.reduce(1..3, Room.new(room_id), fn i, room ->
        {event, room} = advance(room, "p#{i}")
        :ok = Memory.commit(room_id, event.base_revision, event, room)
        room
      end)

    assert room.revision == 3
    assert {:ok, events} = Memory.events_since(room_id, 1)
    assert Enum.map(events, & &1.revision) == [2, 3]
    assert {:ok, []} = Memory.events_since(room_id, 3)
  end

  test "cursor zero on an unknown room replays nothing" do
    assert {:ok, []} = Memory.events_since(room_id(), 0)
  end

  test "nonzero cursor on an unknown room is unavailable" do
    assert {:error, :cursor_unavailable} = Memory.events_since(room_id(), 3)
  end

  test "cursors older than retention are unavailable" do
    room_id = room_id()

    Enum.reduce(1..502, Room.new(room_id), fn i, room ->
      {event, room} = advance(room, "p#{i}")
      :ok = Memory.commit(room_id, event.base_revision, event, room)
      room
    end)

    assert {:error, :cursor_unavailable} = Memory.events_since(room_id, 1)
    assert {:ok, events} = Memory.events_since(room_id, 500)
    assert Enum.map(events, & &1.revision) == [501, 502]
  end

  defp advance(room, participant_id) do
    {:ok, event, room} = Room.apply_command(room, participant_id, :join, %{display_name: "x"})
    {event, room}
  end

  defp room_id, do: "room-#{System.unique_integer([:positive])}"
end
