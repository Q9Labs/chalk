defmodule ChalkSync.WhiteboardV1.SocketRecoveryTest do
  use ChalkSync.WhiteboardV1.SocketCase, async: false

  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.ViewOwner

  test "recovery delivers Bring before an already queued newer owner view" do
    owner = UUID.generate()
    state = %{recovering_state() | extensions: extensions(view: :owner)}

    bring =
      Map.merge(server_view(UUID.generate()), %{
        "owner_id" => owner,
        "owner_sequence" => 1,
        "x" => 10
      })

    newest = Map.merge(bring, %{"bring" => false, "owner_sequence" => 2, "x" => 20})
    assert {:ok, queued} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, bring}, state)
    send(self(), {:whiteboard_v1_frame, newest})
    assert {:ok, live} = receive_frame(snapshot_ack(queued), queued)
    assert_receive {:whiteboard_v1_frame, ^newest}

    assert {:push, {:text, first}, next} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, newest}, live)

    assert_receive :whiteboard_drain
    assert {:push, {:text, second}, _} = SocketWhiteboardV1.handle_info(:whiteboard_drain, next)
    frames = Enum.map([first, second], &JSON.decode!/1)
    assert Enum.map(frames, & &1["owner_sequence"]) == [1, 2]
    assert Enum.map(frames, & &1["bring"]) == [true, false]
    assert Enum.map(frames, & &1["x"]) == [10, 20]

    if path = System.get_env("CHALK_FOLLOW_RECOVERY_WIRE_FIXTURE"),
      do: File.write!(path, JSON.encode!(frames))
  end

  test "coalesces recovering Bring commands and delivers the latest after the final snapshot ACK" do
    count = GeneratedWhiteboardV1.limits()["snapshotPageMaxItems"] + 1
    elements = Enum.map(1..count, fn index -> Map.put(element(), "id", "element-#{index}") end)
    Process.put(:whiteboard_snapshot_elements, elements)
    state = %{recovering_state() | extensions: extensions(view: :basic)}
    Process.delete(:whiteboard_snapshot_elements)
    assert length(state.snapshot.remaining) == 1

    bring = %{
      "type" => "view",
      "participant_id" => "20000000-0000-4000-8000-000000000003",
      "display_name" => "Host",
      "x" => 10,
      "y" => 20,
      "width" => 300,
      "height" => 200,
      "bring" => true,
      "occurred_at" => "2026-10-21T11:00:00.000Z"
    }

    assert {:ok, first} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, bring}, state)
    latest = %{bring | "x" => 40}
    assert {:ok, queued} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, latest}, first)

    assert {:ok, queued} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_frame, %{bring | "bring" => false}},
               queued
             )

    assert {:push, {:text, _page}, recovering} = receive_frame(snapshot_ack(queued), queued)
    refute_received {:whiteboard_v1_frame, _}
    assert {:ok, live} = receive_frame(snapshot_ack(recovering), recovering)
    assert live.phase == :live
    assert_receive :whiteboard_drain

    assert {:push, {:text, encoded}, delivered} =
             SocketWhiteboardV1.handle_info(:whiteboard_drain, live)

    assert JSON.decode!(encoded) == latest
    assert delivered.pending_bring == nil
    ordinary = %{bring | "bring" => false}
    assert_received {:whiteboard_v1_frame, ^ordinary}
    refute_received {:whiteboard_v1_frame, _}
  end

  test "sends a drawing access change that arrives during recovery after the final ACK" do
    state = recovering_state()

    assert {:ok, deferred} = SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, state)
    assert deferred.access_stale
    refute_received :whiteboard_v1_access_changed

    assert {:ok, live} = receive_frame(snapshot_ack(deferred), deferred)
    assert live.phase == :live
    assert_received :whiteboard_v1_access_changed

    assert {:push, {:text, encoded}, _state} =
             SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, %{
               live
               | can_draw: true
             })

    assert %{"type" => "permission_updated", "can_draw" => false} = JSON.decode!(encoded)
  end

  test "recovery replays only the latest person's Bring, with ordinary cached views" do
    state = %{recovering_state() | extensions: extensions(view: :basic)}
    first = server_view("30000000-0000-4000-8000-000000000003")

    latest =
      Map.merge(first, %{"participant_id" => "40000000-0000-4000-8000-000000000004", "x" => 40})

    assert {:ok, queued} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, first}, state)
    assert {:ok, queued} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, latest}, queued)
    assert {:ok, live} = receive_frame(snapshot_ack(queued), queued)
    assert live.phase == :live
    assert_receive :whiteboard_drain

    assert {:push, {:text, encoded}, _next} =
             SocketWhiteboardV1.handle_info(:whiteboard_drain, live)

    assert JSON.decode!(encoded) == latest

    assert_receive {:whiteboard_v1_frame,
                    %{
                      "participant_id" => "30000000-0000-4000-8000-000000000003",
                      "bring" => false
                    }}

    assert_receive {:whiteboard_v1_frame,
                    %{
                      "participant_id" => "40000000-0000-4000-8000-000000000004",
                      "bring" => false
                    }}

    refute_received {:whiteboard_v1_frame, _}
  end

  test "owner overload closes explicitly and accepted retries echo the same input id" do
    state = %{live_view_state() | extensions: extensions(view: :owner)}
    {:ok, owner, _, _} = ViewOwner.join(state.identity.episode, state.identity.participant_id)
    state = %{state | view_owner: owner}
    frame = Map.merge(view_frame(false), %{"input_id" => "#{UUID.generate()}:1", "move" => true})

    for _ <- 1..2 do
      assert {:push, {:text, encoded}, _} = receive_frame(frame, state)
      assert JSON.decode!(encoded) == %{"type" => "view_ack", "input_id" => frame["input_id"]}
    end

    assert :sys.get_state(owner).views[state.identity.participant_id]["owner_sequence"] == 1

    :sys.replace_state(owner, fn current ->
      %{current | admitted: MapSet.new(1..1024)}
    end)

    fresh = %{frame | "input_id" => "#{UUID.generate()}:1"}
    assert {:stop, :normal, {1013, "view capacity exhausted"}, _} = receive_frame(fresh, state)
  end

  test "legacy peers do not receive their own Bring, while owner-capable peers do" do
    state = live_view_state()
    frame = server_view(state.identity.participant_id)
    assert {:ok, ^state} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, state)
    owner = %{state | extensions: extensions(view: :owner)}

    assert {:push, {:text, encoded}, ^owner} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, owner)

    assert JSON.decode!(encoded) == frame
  end

  test "serializes overlapping snapshot requests without interrupting recovery" do
    state = recovering_state()
    request = %{"type" => "request_snapshot", "request_id" => "snapshot-request-0002"}
    assert {:ok, pending} = receive_frame(request, state)
    assert pending.snapshot == state.snapshot
    assert {:ok, duplicate} = receive_frame(request, pending)
    assert duplicate == pending

    assert {:ok, live} = receive_frame(snapshot_ack(state), pending)
    assert live.phase == :live
    assert_received :whiteboard_snapshot_next

    assert {:push, {:text, encoded}, recovering} =
             SocketWhiteboardV1.handle_info(:whiteboard_snapshot_next, live)

    assert JSON.decode!(encoded)["request_id"] == request["request_id"]
    assert recovering.phase == :recovering
    assert {:ok, finished} = receive_frame(snapshot_ack(recovering), recovering)
    assert finished.phase == :live
  end

  test "drops ephemeral cursors during recovery and still answers ping" do
    state = recovering_state()
    assert {:ok, ^state} = receive_frame(%{"type" => "cursor", "x" => 1, "y" => 2}, state)
    assert {:push, {:text, encoded}, pinged} = receive_frame(%{"type" => "ping"}, state)
    assert is_integer(pinged.last_heartbeat_at_ms)
    assert JSON.decode!(encoded) == %{"type" => "pong"}
  end

  defp server_view(participant_id) do
    Map.merge(view_frame(true), %{
      "participant_id" => participant_id,
      "display_name" => "Host",
      "occurred_at" => "2026-10-21T11:00:00.000Z"
    })
  end
end
