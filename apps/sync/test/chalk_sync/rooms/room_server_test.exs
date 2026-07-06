defmodule ChalkSync.Rooms.RoomServerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Rooms.RoomServer

  test "join returns a snapshot including the joiner" do
    room_id = room_id()

    assert {:ok, _pid, %{snapshot: snapshot}} = RoomServer.join(room_id, "p1", "Ada", self())
    assert snapshot["control_revision"] == 1
    assert [%{"participant_id" => "p1", "hand_raised" => false}] = snapshot["participants"]
  end

  test "existing subscribers see later joins and committed commands" do
    room_id = room_id()
    {:ok, _pid, _} = RoomServer.join(room_id, "p1", "Ada", self())

    other = joiner(room_id, "p2", "Bo")

    assert_receive {:sync_event, %{name: "participant_joined", base_revision: 1, revision: 2}}

    assert {:committed, 3} = RoomServer.command(room_id, "p2", "c-1", :raise_hand, %{})
    assert_receive {:sync_event, %{name: "hand_raised", base_revision: 2, revision: 3} = event}
    assert event.payload == %{"participant_id" => "p2"}

    send(other, :done)
  end

  test "a replayed command_id acks duplicate with the original revision" do
    room_id = room_id()
    {:ok, _pid, _} = RoomServer.join(room_id, "p1", "Ada", self())

    assert {:committed, 2} = RoomServer.command(room_id, "p1", "c-1", :raise_hand, %{})
    assert {:duplicate, 2} = RoomServer.command(room_id, "p1", "c-1", :raise_hand, %{})
    assert {:rejected, :no_change} = RoomServer.command(room_id, "p1", "c-2", :raise_hand, %{})
  end

  test "reconnect with a valid cursor replays instead of snapshotting" do
    room_id = room_id()
    {:ok, _pid, _} = RoomServer.join(room_id, "p1", "Ada", self())
    {:committed, 2} = RoomServer.command(room_id, "p1", "c-1", :raise_hand, %{})

    assert {:ok, _pid, %{replay: events, control_revision: 2, snapshot: nil}} =
             RoomServer.join(room_id, "p1", "Ada", self(), 1)

    assert Enum.map(events, & &1.revision) == [2]
  end

  test "a future cursor is rejected and forces a snapshot" do
    room_id = room_id()

    assert {:ok, _pid, %{replay: nil, snapshot: %{}}} =
             RoomServer.join(room_id, "p1", "Ada", self(), 99)
  end

  test "reconnecting participant does not emit a second join event" do
    room_id = room_id()
    {:ok, _pid, _} = RoomServer.join(room_id, "p1", "Ada", self())

    assert {:ok, _pid, %{snapshot: snapshot}} = RoomServer.join(room_id, "p1", "Ada", self())
    assert snapshot["control_revision"] == 1
  end

  test "subscriber death emits participant_left; empty room stops its server" do
    room_id = room_id()
    {:ok, pid, _} = RoomServer.join(room_id, "p1", "Ada", self())

    other = joiner(room_id, "p2", "Bo")
    assert_receive {:sync_event, %{name: "participant_joined"}}

    ref = Process.monitor(other)
    send(other, :done)
    assert_receive {:DOWN, ^ref, :process, ^other, :normal}

    assert_receive {:sync_event,
                    %{name: "participant_left", payload: %{"participant_id" => "p2"}}}

    # While we are still subscribed the server must stay up.
    server_ref = Process.monitor(pid)
    refute_receive {:DOWN, ^server_ref, :process, ^pid, _}, 100
  end

  test "server stops when its last subscriber dies and rehydrates on rejoin" do
    room_id = room_id()
    subscriber = joiner(room_id, "p1", "Ada")
    pid = RoomServer.whereis(room_id)
    server_ref = Process.monitor(pid)

    send(subscriber, :done)
    assert_receive {:DOWN, ^server_ref, :process, ^pid, :normal}

    # Rejoin hydrates from the stateholder: revision continues, no reset.
    assert {:ok, _new_pid, %{snapshot: snapshot}} = RoomServer.join(room_id, "p2", "Bo", self())
    assert snapshot["control_revision"] == 3
    assert [%{"participant_id" => "p2"}] = snapshot["participants"]
  end

  defp joiner(room_id, participant_id, display_name) do
    parent = self()

    pid =
      spawn(fn ->
        receive do
          :done -> :ok
        end
      end)

    {:ok, _server, _} = RoomServer.join(room_id, participant_id, display_name, pid)
    send(parent, {:joined, participant_id})
    pid
  end

  defp room_id, do: "room-#{System.unique_integer([:positive])}"
end
