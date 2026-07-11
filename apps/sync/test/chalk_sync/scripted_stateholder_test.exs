defmodule ChalkSync.ScriptedStateholderTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Rooms.Room
  alias ChalkSync.ScriptedStateholder

  setup do
    start_supervised!(ScriptedStateholder)
    :ok
  end

  test "blocks at the exact point after a successful commit" do
    room_id = room_id()
    {event, room} = join(Room.new(room_id), "p1")
    :ok = ScriptedStateholder.arm(:commit, {:block_after, self(), :committed})

    task = Task.async(fn -> ScriptedStateholder.commit(room_id, 0, event, room) end)

    assert_receive {:sync_breaker_checkpoint, :committed, :commit, :after, server, caller}
    assert caller == task.pid

    :ok = ScriptedStateholder.release(server, :committed)
    assert :ok = Task.await(task)
    assert {:ok, ^room} = ScriptedStateholder.load(room_id)
  end

  test "blocks before commit without exposing uncommitted state" do
    room_id = room_id()
    {event, room} = join(Room.new(room_id), "p1")
    :ok = ScriptedStateholder.arm(:commit, {:block_before, self(), :pending})

    task = Task.async(fn -> ScriptedStateholder.commit(room_id, 0, event, room) end)

    assert_receive {:sync_breaker_checkpoint, :pending, :commit, :before, server, caller}
    assert caller == task.pid

    :ok = ScriptedStateholder.release(server, :pending)
    assert :ok = Task.await(task)
    assert {:ok, ^room} = ScriptedStateholder.load(room_id)
  end

  test "injects a compare-and-set conflict without mutating state" do
    room_id = room_id()
    {event, room} = join(Room.new(room_id), "p1")
    :ok = ScriptedStateholder.arm(:commit, :revision_conflict)

    assert {:error, {:revision_conflict, 0}} =
             ScriptedStateholder.commit(room_id, 0, event, room)

    assert :not_found = ScriptedStateholder.load(room_id)
  end

  defp join(room, participant_id) do
    {:ok, event, room} =
      Room.apply_command(room, participant_id, :join, %{display_name: participant_id})

    {event, room}
  end

  defp room_id, do: "scripted-room-#{System.unique_integer([:positive])}"
end
