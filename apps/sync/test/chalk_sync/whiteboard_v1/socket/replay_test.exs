defmodule ChalkSync.WhiteboardV1.SocketReplayTest do
  use ChalkSync.WhiteboardV1.SocketCase, async: false

  alias ChalkSync.Transport.SocketWhiteboardV1

  @scene_id "10000000-0000-4000-8000-000000000001"

  test "repairs a missed presentation notification from the durable head" do
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    state = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        extensions: extensions(presentation: :basic)
    }

    assert {:push, {:text, encoded}, repaired} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_head, @scene_id, 5},
               state
             )

    assert JSON.decode!(encoded) == %{
             "type" => "presentation_updated",
             "scene_id" => @scene_id,
             "revision" => "5",
             "presenting" => true
           }

    assert repaired.revision == 5

    legacy = %{state | extensions: extensions()}

    assert {:push, {:text, legacy_encoded}, _legacy_repair} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_head, @scene_id, 5},
               legacy
             )

    assert JSON.decode!(legacy_encoded) == %{
             "type" => "reset_required",
             "scene_id" => @scene_id,
             "reason" => "gap"
           }
  end

  test "replays both changes when a second one commits before the first head notice" do
    Process.put(:whiteboard_events_after_four, [update_event(5), update_event(6)])
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    state = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        extensions: extensions(presentation: :basic)
    }

    assert {:push, {:text, first}, replaying} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 5}, state)

    assert %{"type" => "update", "revision" => "5"} = JSON.decode!(first)
    assert replaying.revision == 6

    assert {:push, {:text, second}, replayed} =
             SocketWhiteboardV1.handle_info(:whiteboard_drain, replaying)

    assert %{"type" => "update", "revision" => "6"} = JSON.decode!(second)

    assert {:ok, ^replayed} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 6}, replayed)
  end

  test "replays the earlier change when a later one arrives first" do
    Process.put(:whiteboard_events_after_four, [update_event(5), update_event(6)])
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    state = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        extensions: extensions(presentation: :basic)
    }

    later = %{
      "type" => "update",
      "operation_id" => "whiteboard-replay-0006",
      "scene_id" => @scene_id,
      "revision" => "6",
      "elements" => [element()]
    }

    assert {:push, {:text, first}, replaying} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, later}, state)

    assert %{"type" => "update", "revision" => "5"} = JSON.decode!(first)
    assert replaying.revision == 6

    assert {:push, {:text, second}, replayed} =
             SocketWhiteboardV1.handle_info(:whiteboard_drain, replaying)

    assert %{"type" => "update", "revision" => "6"} = JSON.decode!(second)

    earlier = %{later | "operation_id" => "whiteboard-replay-0005", "revision" => "5"}

    assert {:ok, ^replayed} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, earlier}, replayed)
  end

  test "sends one reset and reads the log no more until the client asks for a snapshot" do
    Process.put(:whiteboard_events_after_four, [])
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    state = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        extensions: extensions(presentation: :basic)
    }

    assert {:push, {:text, encoded}, waiting} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 5}, state)

    assert %{"type" => "reset_required", "reason" => "gap"} = JSON.decode!(encoded)
    assert waiting.awaiting_snapshot

    Process.put(:whiteboard_events_after_four, [update_event(5), update_event(6)])

    assert {:ok, ^waiting} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 6}, waiting)

    later = %{
      "type" => "update",
      "operation_id" => "whiteboard-replay-0006",
      "scene_id" => @scene_id,
      "revision" => "6",
      "elements" => [element()]
    }

    assert {:ok, ^waiting} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, later}, waiting)

    assert {:push, {:text, _first_page}, recovering} =
             receive_frame(
               %{"type" => "request_snapshot", "request_id" => "snapshot-request-0003"},
               waiting
             )

    refute recovering.awaiting_snapshot
  end

  test "reads the log again after the client's snapshot request is rejected" do
    Process.put(:whiteboard_events_after_four, [])
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    state = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        extensions: extensions(presentation: :basic)
    }

    assert {:push, {:text, _reset}, waiting} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 5}, state)

    assert waiting.awaiting_snapshot

    Process.put(:whiteboard_snapshot_failure, {:retryable, :storage_unavailable})
    request = %{"type" => "request_snapshot", "request_id" => "snapshot-request-0004"}
    assert {:push, {:text, rejected}, retrying} = receive_frame(request, waiting)
    assert JSON.decode!(rejected)["code"] == "storage_unavailable"
    refute retrying.awaiting_snapshot

    Process.put(:whiteboard_events_after_four, [update_event(5), update_event(6)])

    assert {:push, {:text, replayed}, _replaying} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 6}, retrying)

    assert %{"type" => "update", "revision" => "5"} = JSON.decode!(replayed)
  end
end
