defmodule ChalkSync.WhiteboardV1.SocketTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.WhiteboardV1.Episode

  @participant_id "20000000-0000-4000-8000-000000000002"
  @scene_id "10000000-0000-4000-8000-000000000001"

  defmodule Repository do
    def commit_update(_identity, operation) do
      send(self(), {:committed_update, operation})

      {:ok,
       %{
         operation_id: operation.operation_id,
         scene_id: operation.scene_id,
         revision: 5,
         outcome: Process.get(:whiteboard_commit_outcome, :committed),
         elements: Process.get(:whiteboard_committed_elements, operation.elements)
       }}
    end

    def snapshot(_identity) do
      Process.get(:whiteboard_snapshot_failure) ||
        {:ok,
         %{
           scene_id: "10000000-0000-4000-8000-000000000001",
           revision: 4,
           elements: [],
           app_state: nil
         }}
    end

    def read_after(_identity, scene_id, 4) do
      {:ok,
       Process.get(:whiteboard_events_after_four) ||
         [
           %{
             type: :presentation,
             operation_id: "whiteboard-presentation-0001",
             scene_id: scene_id,
             revision: 5,
             presenting: true
           }
         ]}
    end
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
    assert {:push, {:text, encoded}, ^state} = receive_frame(%{"type" => "ping"}, state)
    assert JSON.decode!(encoded) == %{"type" => "pong"}
  end

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

  defp recovering_state do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)

    live = %{
      initial
      | phase: :live,
        identity: identity(),
        scene_id: @scene_id,
        revision: 4
    }

    assert {:push, {:text, _first_page}, state} =
             receive_frame(
               %{"type" => "request_snapshot", "request_id" => "snapshot-request-0001"},
               live
             )

    assert state.phase == :recovering
    state
  end

  defp receive_frame(frame, state),
    do: SocketWhiteboardV1.handle_in({JSON.encode!(frame), [opcode: :text]}, state)

  defp snapshot_ack(state),
    do: %{
      "type" => "snapshot_ack",
      "request_id" => state.snapshot.request_id,
      "scene_id" => state.snapshot.scene_id,
      "revision" => state.snapshot.revision,
      "page" => state.snapshot.acknowledged_page + 1
    }

  defp element,
    do: %{
      "id" => "element-1",
      "type" => "rectangle",
      "version" => 1,
      "version_nonce" => 1,
      "index" => "a0",
      "is_deleted" => false,
      "payload" => %{}
    }

  setup do
    previous = Application.get_env(:chalk_sync, :whiteboard_v1_repository)
    Application.put_env(:chalk_sync, :whiteboard_v1_repository, Repository)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :whiteboard_v1_repository, previous),
        else: Application.delete_env(:chalk_sync, :whiteboard_v1_repository)
    end)
  end

  test "enforces the hello deadline and strict text framing" do
    assert {:ok, state} = SocketWhiteboardV1.init(%{})

    assert {:stop, :normal, {1008, "hello timeout"}, timeout_state} =
             SocketWhiteboardV1.handle_info(:hello_timeout, state)

    assert timeout_state.terminal == %{close_code: 1008, reason: :hello_timeout}

    assert {:stop, :normal, {1009, "text frames only"}, frame_state} =
             SocketWhiteboardV1.handle_in({<<1, 2>>, [opcode: :binary]}, state)

    assert frame_state.terminal == %{close_code: 1009, reason: :protocol_error}

    assert {:push, {:text, ~s({"type":"pong"})}, ^state} =
             SocketWhiteboardV1.handle_in(
               {~s({"type":"ping"}), [opcode: :text]},
               state
             )
  end

  test "retains transport close reasons without guessing unavailable close codes" do
    handler = "whiteboard-terminal-#{System.unique_integer([:positive])}"
    test_pid = self()

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _event, _measure, metadata, _config -> send(test_pid, {:observed, metadata}) end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)

    assert {:ok, initial} = SocketWhiteboardV1.init(%{})
    state = %{initial | phase: :live, scene_id: @scene_id}

    for {terminate_reason, reason} <- [
          {:remote, :client_closed},
          {:timeout, :timeout},
          {:shutdown, :server_shutdown},
          {{:error, :closed}, :transport_error}
        ] do
      assert :ok = SocketWhiteboardV1.terminate(terminate_reason, state)

      assert_received {:observed,
                       %{
                         event: "sync.websocket.closed",
                         attributes: %{reason: ^reason, scene_id: @scene_id} = attributes
                       }}

      refute Map.has_key?(attributes, :close_code)
    end

    assert :ok =
             SocketWhiteboardV1.terminate(:normal, %{
               state
               | terminal: %{close_code: 1008, reason: :permission_denied}
             })

    assert_received {:observed,
                     %{
                       event: "sync.websocket.closed",
                       attributes: %{
                         close_code: 1008,
                         reason: :permission_denied,
                         scene_id: @scene_id
                       }
                     }}
  end

  test "does not echo a participant cursor or replay an applied update" do
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    identity = %Identity{
      episode: %EpisodeKey{
        tenant_id: "30000000-0000-4000-8000-000000000003",
        space_id: "40000000-0000-4000-8000-000000000004",
        episode_id: "50000000-0000-4000-8000-000000000005"
      },
      participant_id: @participant_id,
      participant_generation: 1
    }

    state = %{
      initial
      | phase: :live,
        identity: identity,
        scene_id: @scene_id,
        revision: 4
    }

    assert {:ok, ^state} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_frame,
                %{
                  "type" => "cursor",
                  "participant_id" => @participant_id,
                  "display_name" => "Ada",
                  "x" => 1,
                  "y" => 2,
                  "occurred_at" => "2026-07-29T12:00:00Z"
                }},
               state
             )

    assert {:ok, ^state} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_frame,
                %{
                  "type" => "update",
                  "operation_id" => "operation-0000000001",
                  "scene_id" => @scene_id,
                  "revision" => "4",
                  "elements" => []
                }},
               state
             )
  end

  test "repairs a missed presentation notification from the durable head" do
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    state = %{
      initial
      | phase: :live,
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        presentation_negotiated: true
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

    legacy = %{state | presentation_negotiated: false}

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
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        presentation_negotiated: true
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
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        presentation_negotiated: true
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
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        presentation_negotiated: true
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
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        presentation_negotiated: true
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

  test "a stopping socket does not wait for its outbound queue" do
    Process.put(:whiteboard_events_after_four, [update_event(5), update_event(6)])
    state = recovering_state()
    request = %{"type" => "request_snapshot", "request_id" => "snapshot-request-0006"}
    assert {:ok, queued} = receive_frame(request, state)

    assert {:ok, noted} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_head, @scene_id, 6}, queued)

    assert {:push, {:text, _first}, replaying} = receive_frame(snapshot_ack(noted), noted)
    assert_received :whiteboard_snapshot_next

    stopping = %{replaying | terminal: %{close_code: 1012, reason: :delivery_unavailable}}

    assert {:ok, ^stopping} =
             SocketWhiteboardV1.handle_info(:whiteboard_snapshot_next, stopping)

    refute_received :whiteboard_snapshot_next
  end

  test "resets a legacy socket when its replay passes the notified head" do
    Process.put(:whiteboard_events_after_four, [update_event(5), update_event(6)])
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    legacy = %{
      initial
      | phase: :live,
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        presentation_negotiated: false
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

  defp update_event(revision) do
    %{
      type: :update,
      operation_id: "whiteboard-replay-000#{revision}",
      scene_id: @scene_id,
      revision: revision,
      elements: [element()]
    }
  end

  defp identity do
    %Identity{
      episode: %EpisodeKey{
        tenant_id: "30000000-0000-4000-8000-000000000003",
        space_id: "40000000-0000-4000-8000-000000000004",
        episode_id: "50000000-0000-4000-8000-000000000005"
      },
      participant_id: @participant_id,
      participant_generation: 1
    }
  end
end
