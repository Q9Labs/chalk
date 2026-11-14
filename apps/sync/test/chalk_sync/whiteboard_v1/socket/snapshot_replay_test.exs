defmodule ChalkSync.WhiteboardV1.SocketSnapshotReplayTest do
  use ChalkSync.WhiteboardV1.SocketCase, async: false

  alias ChalkSync.Transport.SocketWhiteboardV1

  @scene_id "10000000-0000-4000-8000-000000000001"

  test "replays a change that commits while a snapshot is being loaded" do
    Process.put(:whiteboard_events_after_four, [update_event(5)])
    state = recovering_state()

    assert {:ok, noted} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 5}, state)

    assert noted.missed_head == {@scene_id, 5}

    assert {:push, {:text, encoded}, caught_up} = receive_frame(snapshot_ack(noted), noted)
    assert %{"type" => "update", "revision" => "5"} = JSON.decode!(encoded)
    assert caught_up.phase == :live
    assert caught_up.revision == 5
    assert caught_up.missed_head == nil
  end

  test "sends the kept revision before a part that was queued during the snapshot" do
    Process.put(:whiteboard_events_after_four, [update_event(5)])
    state = recovering_state()

    part = %{
      "type" => "update_part",
      "operation_id" => "whiteboard-replay-0005",
      "scene_id" => @scene_id,
      "revision" => "5",
      "part" => 0,
      "part_count" => 2,
      "element_count" => 2,
      "elements" => [element()]
    }

    assert {:ok, noted} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, part}, state)

    # The replay comes with the last snapshot page, so the queued last part
    # cannot reach the client without its first part.
    assert {:push, {:text, encoded}, caught_up} = receive_frame(snapshot_ack(noted), noted)
    assert %{"type" => "update", "revision" => "5"} = JSON.decode!(encoded)

    assert {:ok, ^caught_up} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_frame, %{part | "part" => 1}},
               caught_up
             )
  end

  test "keeps the newest revision seen in frames and notices during a snapshot" do
    Process.put(:whiteboard_events_after_four, [update_event(5), update_event(6)])
    state = recovering_state()

    frame = %{
      "type" => "update",
      "operation_id" => "whiteboard-replay-0006",
      "scene_id" => @scene_id,
      "revision" => "6",
      "elements" => [element()]
    }

    assert {:ok, noted} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, state)
    assert noted.missed_head == {@scene_id, 6}

    assert {:ok, ^noted} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 5}, noted)

    assert {:push, {:text, encoded}, caught_up} = receive_frame(snapshot_ack(noted), noted)
    assert %{"type" => "update", "revision" => "5"} = JSON.decode!(encoded)
    assert caught_up.revision == 6
  end

  test "starts a queued snapshot only after the replay has gone out" do
    Process.put(:whiteboard_events_after_four, [update_event(5), update_event(6)])
    state = recovering_state()
    request = %{"type" => "request_snapshot", "request_id" => "snapshot-request-0005"}
    assert {:ok, queued} = receive_frame(request, state)

    assert {:ok, noted} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 6}, queued)

    assert {:push, {:text, first}, replaying} = receive_frame(snapshot_ack(noted), noted)
    assert %{"type" => "update", "revision" => "5"} = JSON.decode!(first)
    assert_received :whiteboard_snapshot_next
    assert_received :whiteboard_drain

    assert {:ok, ^replaying} =
             SocketWhiteboardV1.handle_info(:whiteboard_snapshot_next, replaying)

    assert_received :whiteboard_snapshot_next

    assert {:push, {:text, second}, drained} =
             SocketWhiteboardV1.handle_info(:whiteboard_drain, replaying)

    assert %{"type" => "update", "revision" => "6"} = JSON.decode!(second)

    assert {:push, {:text, page}, recovering} =
             SocketWhiteboardV1.handle_info(:whiteboard_snapshot_next, drained)

    assert JSON.decode!(page)["request_id"] == request["request_id"]
    assert recovering.phase == :recovering
  end

  test "resets a legacy socket when its replay passes the notified head" do
    Process.put(:whiteboard_events_after_four, [update_event(5), update_event(6)])
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    legacy = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        extensions: extensions()
    }

    assert {:push, {:text, encoded}, _reset} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 5}, legacy)

    assert %{"type" => "reset_required", "reason" => "gap"} = JSON.decode!(encoded)
  end

  test "keeps a multipart update private until complete and fails an expired assembly" do
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    state = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        display_name: "Ada",
        scene_id: @scene_id,
        revision: 4
    }

    frame =
      JSON.encode!(%{
        "type" => "submit_update_part",
        "operation_id" => "operation-0000000001",
        "scene_id" => @scene_id,
        "sync_all" => true,
        "part" => 0,
        "part_count" => 2,
        "element_count" => 2,
        "elements" => [
          %{
            "id" => "element-1",
            "type" => "rectangle",
            "version" => 1,
            "version_nonce" => 1,
            "index" => "a0",
            "is_deleted" => false,
            "payload" => %{}
          }
        ]
      })

    assert {:ok, pending} =
             SocketWhiteboardV1.handle_in({frame, [opcode: :text]}, state)

    assert pending.multipart.operation_id == "operation-0000000001"
    assert map_size(pending.multipart.parts) == 1
    Process.cancel_timer(pending.multipart_timer)

    assert {:push, {:text, failure}, expired} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_multipart_timeout, "operation-0000000001"},
               pending
             )

    assert expired.multipart == nil
    assert expired.multipart_timer == nil

    assert JSON.decode!(failure) == %{
             "type" => "operation_error",
             "correlation_id" => "operation-0000000001",
             "operation" => "submit_update",
             "code" => "overloaded",
             "recoverable" => true,
             "message" => "Whiteboard temporarily overloaded"
           }
  end
end
