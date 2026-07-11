defmodule ChalkSync.SyncBreaker.WireActorTest do
  use ChalkSync.ServerCase, async: true

  alias ChalkSync.Rooms.RoomServer
  alias ChalkSync.SyncBreaker.WireActor

  test "tracks a real snapshot, event, acknowledgement, and cursor replay", %{port: port} do
    actor = WireActor.new("t1", unique_room_id(), "p1", "Ada")
    assert {:ok, actor, %{"mode" => "snapshot"}} = WireActor.connect(actor, port)
    assert WireActor.revision(actor) == 1

    actor = WireActor.send_command(actor, "c1", :raise_hand)

    assert {:ok, actor, %{"result" => "committed", "revision" => 2}} =
             WireActor.await_ack(actor, "c1")

    assert {:ok, actor, _observed} = WireActor.await_revision(actor, 2)
    assert WireActor.revision(actor) == 2

    writer = RoomServer.whereis(actor.room_id)
    writer_ref = Process.monitor(writer)
    actor = WireActor.close_tcp(actor)
    assert_receive {:DOWN, ^writer_ref, :process, ^writer, :normal}

    assert {:ok, actor, %{"mode" => "replay", "control_revision" => 4}} =
             WireActor.connect(actor, port, 2)

    assert WireActor.revision(actor) == 4
  end
end
