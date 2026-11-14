defmodule ChalkSync.WhiteboardV1.SocketRecoverySnapshotsTest do
  use ChalkSync.WhiteboardV1.SocketCase, async: false

  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.WhiteboardV1.Episode

  @participant_id "20000000-0000-4000-8000-000000000002"
  @scene_id "10000000-0000-4000-8000-000000000001"

  test "does not serve a queued request twice if it arrives before the drain message" do
    state = recovering_state()
    request = %{"type" => "request_snapshot", "request_id" => "snapshot-request-0002"}
    assert {:ok, queued} = receive_frame(request, state)
    assert {:ok, between} = receive_frame(snapshot_ack(state), queued)
    assert_received :whiteboard_snapshot_next
    assert {:push, {:text, _page}, active} = receive_frame(request, between)
    assert active.pending_snapshot_requests == []
    assert {:ok, ^active} = SocketWhiteboardV1.handle_info(:whiteboard_snapshot_next, active)
    assert {:ok, finished} = receive_frame(snapshot_ack(active), active)
    assert finished.phase == :live
    assert {:ok, ^finished} = SocketWhiteboardV1.handle_info(:whiteboard_snapshot_next, finished)
    refute_received :whiteboard_snapshot_next
  end

  test "does not retry a queued request whose live-phase copy already failed" do
    state = recovering_state()
    request = %{"type" => "request_snapshot", "request_id" => "snapshot-request-0002"}
    assert {:ok, queued} = receive_frame(request, state)
    assert {:ok, between} = receive_frame(snapshot_ack(state), queued)
    assert_received :whiteboard_snapshot_next
    Process.put(:whiteboard_snapshot_failure, {:retryable, :storage_unavailable})
    assert {:push, {:text, encoded}, failed} = receive_frame(request, between)
    assert JSON.decode!(encoded)["code"] == "storage_unavailable"
    Process.delete(:whiteboard_snapshot_failure)
    assert failed.pending_snapshot_requests == []
    assert {:ok, ^failed} = SocketWhiteboardV1.handle_info(:whiteboard_snapshot_next, failed)
  end

  test "bounds deferred snapshots and keeps the active transfer intact at capacity" do
    state = recovering_state()

    assert {:ok, ^state} =
             receive_frame(
               %{"type" => "request_snapshot", "request_id" => state.snapshot.request_id},
               state
             )

    full =
      Enum.reduce(1..128, state, fn i, current ->
        {:ok, next} =
          receive_frame(
            %{"type" => "request_snapshot", "request_id" => "snapshot-pending-#{i}"},
            current
          )

        next
      end)

    assert length(full.pending_snapshot_requests) == 128

    assert {:push, {:text, encoded}, unchanged} =
             receive_frame(
               %{"type" => "request_snapshot", "request_id" => "snapshot-overflow-0001"},
               full
             )

    assert unchanged.snapshot == state.snapshot
    assert unchanged.pending_snapshot_requests == full.pending_snapshot_requests

    assert %{"operation" => "request_snapshot", "code" => "overloaded", "recoverable" => true} =
             JSON.decode!(encoded)
  end

  test "a stroke rejected during recovery commits when retried after the final acknowledgement" do
    state = recovering_state()

    stroke = %{
      "type" => "submit_update",
      "operation_id" => "whiteboard-stroke-0001",
      "scene_id" => @scene_id,
      "sync_all" => false,
      "elements" => [element()]
    }

    assert {:push, {:text, _retryable_error}, recovering} = receive_frame(stroke, state)
    refute_received {:committed_update, _}
    assert {:ok, live} = receive_frame(snapshot_ack(state), recovering)
    assert {:push, {:text, commit}, _} = receive_frame(stroke, live)

    assert %{"type" => "commit", "operation_id" => "whiteboard-stroke-0001"} =
             JSON.decode!(commit)

    assert_received {:committed_update, %{elements: [stored]}}
    assert stored["id"] == "element-1"
  end

  test "a contiguous ACK prevents replaying the sender's older stroke payload" do
    state = recovering_state()
    assert {:ok, live} = receive_frame(snapshot_ack(state), state)

    stroke = %{
      "type" => "submit_update",
      "operation_id" => "whiteboard-own-stroke-0001",
      "scene_id" => @scene_id,
      "sync_all" => false,
      "elements" => [element()]
    }

    assert {:push, {:text, _commit}, acknowledged} = receive_frame(stroke, live)
    assert acknowledged.revision == 5

    echo = %{
      "type" => "update",
      "operation_id" => stroke["operation_id"],
      "scene_id" => @scene_id,
      "revision" => "5",
      "elements" => [element()]
    }

    assert {:ok, ^acknowledged} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, echo}, acknowledged)

    assert {:ok, ^acknowledged} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 5}, acknowledged)
  end

  test "an ACK leaves intervening revisions available for replay" do
    state = recovering_state()
    assert {:ok, live} = receive_frame(snapshot_ack(state), state)

    stroke = %{
      "type" => "submit_update",
      "operation_id" => "whiteboard-gap-stroke-0001",
      "scene_id" => @scene_id,
      "sync_all" => false,
      "elements" => [element()]
    }

    assert {:push, {:text, _commit}, acknowledged} = receive_frame(stroke, %{live | revision: 2})
    assert acknowledged.revision == 2
  end

  test "a duplicate stroke only acknowledges its receipt without broadcasting an empty revision" do
    Process.put(:whiteboard_commit_outcome, :duplicate)
    Process.put(:whiteboard_committed_elements, [])

    operation = %{
      operation_id: "whiteboard-duplicate-0001",
      scene_id: @scene_id,
      elements: [element()]
    }

    assert {:ok, %{"type" => "commit", "outcome" => "duplicate"}, []} =
             Episode.submit_update(identity(), operation)
  end

  test "returns retryable errors for mutations during recovery without discarding the snapshot" do
    state = recovering_state()
    operation_id = "whiteboard-operation-0001"

    frames = [
      %{
        "type" => "submit_update",
        "operation_id" => operation_id,
        "scene_id" => @scene_id,
        "sync_all" => false,
        "elements" => []
      },
      %{
        "type" => "submit_update_part",
        "operation_id" => operation_id,
        "scene_id" => @scene_id,
        "sync_all" => false,
        "part" => 0,
        "part_count" => 2,
        "element_count" => 2,
        "elements" => [element()]
      },
      %{"type" => "clear", "operation_id" => operation_id, "scene_id" => @scene_id},
      %{
        "type" => "set_draw_permission",
        "operation_id" => operation_id,
        "participant_id" => @participant_id,
        "can_draw" => true
      },
      %{"type" => "set_draw_policy", "operation_id" => operation_id, "policy" => "hosts"},
      %{"type" => "set_presentation", "operation_id" => operation_id, "presenting" => true}
    ]

    for frame <- frames do
      assert {:push, {:text, encoded}, unchanged} = receive_frame(frame, state)
      assert unchanged.snapshot == state.snapshot
      assert unchanged.phase == :recovering
      assert unchanged.multipart == nil

      expected_operation =
        if frame["type"] == "submit_update_part", do: "submit_update", else: frame["type"]

      assert %{
               "type" => "operation_error",
               "correlation_id" => ^operation_id,
               "operation" => ^expected_operation,
               "code" => "overloaded",
               "recoverable" => true
             } = JSON.decode!(encoded)
    end
  end

  test "keeps invalid frames and incorrect snapshot acknowledgements fatal" do
    state = recovering_state()

    assert {:stop, :normal, {1009, _}, _} =
             receive_frame(%{"type" => "cursor", "x" => "bad", "y" => 2}, state)

    assert {:stop, :normal, {1008, _}, _} =
             receive_frame(
               %{
                 "type" => "snapshot_ack",
                 "request_id" => "wrong-request-0001",
                 "scene_id" => @scene_id,
                 "revision" => "4",
                 "page" => 0
               },
               state
             )

    assert {:stop, :normal, {1008, _}, _} =
             receive_frame(
               %{
                 "type" => "hello",
                 "protocol" => "whiteboard-v1",
                 "token" => String.duplicate("t", 32),
                 "cursor" => nil
               },
               state
             )
  end
end
