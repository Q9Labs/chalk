defmodule ChalkSync.Rooms.RoomTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Rooms.Room

  test "join produces an exact revision chain from zero" do
    room = Room.new("r1")

    assert {:ok, event, room} = Room.apply_command(room, "p1", :join, %{display_name: "Ada"})
    assert %{name: "participant_joined", base_revision: 0, revision: 1} = event
    assert room.revision == 1
    assert Room.joined?(room, "p1")
  end

  test "commands from non-joined actors are rejected" do
    room = Room.new("r1")

    assert {:error, :not_joined} = Room.apply_command(room, "p1", :raise_hand)
    assert {:error, :not_joined} = Room.apply_command(room, "p1", :leave)
  end

  test "double join and no-op hand changes are rejected" do
    {room, _} = joined_room()

    assert {:error, :already_joined} =
             Room.apply_command(room, "p1", :join, %{display_name: "Ada"})

    assert {:error, :no_change} = Room.apply_command(room, "p1", :lower_hand)

    {:ok, _, room} = Room.apply_command(room, "p1", :raise_hand)
    assert {:error, :no_change} = Room.apply_command(room, "p1", :raise_hand)
  end

  test "unknown commands are rejected" do
    {room, _} = joined_room()
    assert {:error, :unknown_command} = Room.apply_command(room, "p1", :self_destruct)
  end

  test "replaying the event log reproduces the exact state" do
    room = Room.new("r1")

    {events, final} =
      [
        {"p1", :join, %{display_name: "Ada"}},
        {"p2", :join, %{display_name: "Bo"}},
        {"p1", :raise_hand, %{}},
        {"p2", :raise_hand, %{}},
        {"p1", :lower_hand, %{}},
        {"p2", :leave, %{}}
      ]
      |> Enum.reduce({[], room}, fn {actor, command, payload}, {events, room} ->
        {:ok, event, room} = Room.apply_command(room, actor, command, payload)
        {[event | events], room}
      end)

    replayed = events |> Enum.reverse() |> Enum.reduce(Room.new("r1"), &Room.apply_event(&2, &1))

    assert replayed == final
    assert replayed.revision == 6
    assert replayed.participants == %{"p1" => %{display_name: "Ada", hand_raised: false}}
  end

  test "apply_event refuses a broken revision chain" do
    {room, _} = joined_room()
    stale_event = %{name: "hand_raised", base_revision: 5, revision: 6, payload: %{}}

    assert_raise FunctionClauseError, fn -> Room.apply_event(room, stale_event) end
  end

  test "snapshot carries the control revision and participants" do
    {room, _} = joined_room()
    {:ok, _, room} = Room.apply_command(room, "p1", :raise_hand)

    assert Room.snapshot(room) == %{
             "control_revision" => 2,
             "participants" => [
               %{"participant_id" => "p1", "display_name" => "Ada", "hand_raised" => true}
             ]
           }
  end

  defp joined_room do
    {:ok, event, room} =
      Room.apply_command(Room.new("r1"), "p1", :join, %{display_name: "Ada"})

    {room, event}
  end
end
