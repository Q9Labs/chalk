defmodule ChalkSync.WhiteboardV1.SocketTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.ViewOwner

  @participant_id "20000000-0000-4000-8000-000000000002"
  @scene_id "10000000-0000-4000-8000-000000000001"

  defmodule Repository do
    def connect(identity) do
      if hook = Process.get(:whiteboard_connect_hook), do: hook.()

      {:ok,
       %{
         capabilities: Process.get(:current_capabilities, identity.capabilities),
         participant_capabilities: identity.capabilities,
         scene_id: "10000000-0000-4000-8000-000000000001",
         revision: 4,
         can_draw: true,
         is_presenting: false
       }}
    end

    # The Episode's poller runs this, so the answer and the read log live in app env.
    def episode_access(episode) do
      if test = Application.get_env(:chalk_sync, :whiteboard_test_reads),
        do: send(test, {:episode_access_read, episode})

      Process.sleep(Application.get_env(:chalk_sync, :whiteboard_test_read_delay_ms, 0))

      Application.get_env(
        :chalk_sync,
        :whiteboard_test_access,
        {:ok,
         %{
           status: "active",
           participants: %{
             {"20000000-0000-4000-8000-000000000002", 1} => "active",
             {"60000000-0000-4000-8000-000000000006", 1} => "active"
           }
         }}
      )
    end

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
           elements: Process.get(:whiteboard_snapshot_elements, []),
           app_state: nil
         }}
    end

    def draw_access(_identity) do
      Process.get(:whiteboard_draw_access) ||
        {:ok,
         %{
           draw_policy: "hosts",
           can_draw: false,
           capabilities: ["drawWhiteboard"],
           grants: []
         }}
    end

    def set_draw_policy(_identity, _operation) do
      Process.get(:whiteboard_draw_policy_failure)
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

  test "coalesces recovering Bring commands and delivers the latest after the final snapshot ACK" do
    count = GeneratedWhiteboardV1.limits()["snapshotPageMaxItems"] + 1
    elements = Enum.map(1..count, fn index -> Map.put(element(), "id", "element-#{index}") end)
    Process.put(:whiteboard_snapshot_elements, elements)
    state = %{recovering_state() | view_negotiated: true}
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
    assert_receive {:whiteboard_v1_frame, ^latest}

    assert {:push, {:text, encoded}, delivered} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, latest}, live)

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

  test "reads drawing access again later, so a missed notification is repaired" do
    state = %{live_access_state() | draw_policy_negotiated: true}

    assert {:push, {:text, encoded}, read} =
             SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, state)

    assert %{"type" => "draw_access", "policy" => "hosts"} = JSON.decode!(encoded)
    assert Process.read_timer(read.access_timer) > 25_000

    assert {:ok, unchanged} = SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, read)
    refute Process.read_timer(read.access_timer)

    Process.put(
      :whiteboard_draw_access,
      {:ok,
       %{draw_policy: "everyone", can_draw: true, capabilities: ["drawWhiteboard"], grants: []}}
    )

    assert {:push, {:text, encoded}, _state} =
             SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, unchanged)

    assert %{"type" => "draw_access", "policy" => "everyone", "can_draw" => true} =
             JSON.decode!(encoded)
  end

  test "keeps one access retry however many changes arrive while Sync is unavailable" do
    Process.put(:whiteboard_draw_access, {:retryable, :storage_unavailable})

    assert {:ok, first} =
             SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, live_access_state())

    assert {:ok, second} = SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, first)
    refute Process.read_timer(first.access_timer)
    assert Process.read_timer(second.access_timer) <= 1_000
  end

  test "rejects a policy change from a client that did not negotiate draw_policy_v1" do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)

    state = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        scene_id: @scene_id,
        revision: 4
    }

    frame = %{
      "type" => "set_draw_policy",
      "operation_id" => "whiteboard-policy-00001",
      "policy" => "hosts"
    }

    assert {:push, {:text, encoded}, _state} = receive_frame(frame, state)

    assert %{
             "type" => "operation_error",
             "operation" => "set_draw_policy",
             "code" => "unavailable"
           } =
             JSON.decode!(encoded)
  end

  test "names the policy cap when an Episode has used up its policy changes" do
    Process.put(:whiteboard_draw_policy_failure, {:error, :draw_policy_limit})
    state = %{live_access_state() | draw_policy_negotiated: true}

    frame = %{
      "type" => "set_draw_policy",
      "operation_id" => "whiteboard-policy-00001",
      "policy" => "hosts"
    }

    assert {:push, {:text, encoded}, _state} = receive_frame(frame, state)

    assert %{
             "type" => "operation_error",
             "operation" => "set_draw_policy",
             "code" => "rate_limited",
             "recoverable" => false,
             "message" => "This Episode has reached its limit of drawing policy changes"
           } = JSON.decode!(encoded)
  end

  test "recovery replays only the latest person's Bring, with ordinary cached views" do
    state = %{recovering_state() | view_negotiated: true}
    first = server_view("30000000-0000-4000-8000-000000000003")

    latest =
      Map.merge(first, %{"participant_id" => "40000000-0000-4000-8000-000000000004", "x" => 40})

    assert {:ok, queued} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, first}, state)
    assert {:ok, queued} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, latest}, queued)
    assert {:ok, live} = receive_frame(snapshot_ack(queued), queued)
    assert live.phase == :live
    assert_receive {:whiteboard_v1_frame, ^latest}

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

  test "legacy peers do not receive their own Bring, while owner-capable peers do" do
    state = live_view_state()
    frame = server_view(state.identity.participant_id)
    assert {:ok, ^state} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, state)
    owner = %{state | view_owner_negotiated: true}

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

  defp live_access_state do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)

    %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        can_draw: false,
        scene_id: @scene_id,
        revision: 4
    }
  end

  defp recovering_state do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)

    live = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
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

  defp receive_frame(
         %{"type" => "view"} = frame,
         %{view_owner: nil, identity: %Identity{} = identity} = state
       ) do
    {:ok, owner, _id, _snapshot} =
      ViewOwner.join(identity.episode, identity.participant_id)

    SocketWhiteboardV1.handle_in({JSON.encode!(frame), [opcode: :text]}, %{
      state
      | view_owner: owner
    })
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

  describe "a live socket whose access changes" do
    setup do
      {:ok, initial} = SocketWhiteboardV1.init(%{})
      Process.cancel_timer(initial.hello_timer)
      # Access is read per Episode, so each test gets its own Episode.
      identity = %{identity() | episode: %{identity().episode | episode_id: UUID.generate()}}
      Fanout.subscribe(identity.episode)
      Application.put_env(:chalk_sync, :whiteboard_test_reads, self())
      Application.put_env(:chalk_sync, :whiteboard_authority_poll_ms, 50)

      on_exit(fn ->
        for key <- [
              :whiteboard_test_reads,
              :whiteboard_test_access,
              :whiteboard_authority_poll_ms,
              :whiteboard_authority_stale_ms,
              :whiteboard_test_read_delay_ms
            ],
            do: Application.delete_env(:chalk_sync, key)
      end)

      state = %{
        initial
        | phase: :live,
          connected_at: connected_earlier(),
          identity: identity,
          display_name: "Ada",
          scene_id: @scene_id,
          revision: 4
      }

      update = %{
        "type" => "update",
        "operation_id" => "operation-0000000005",
        "scene_id" => @scene_id,
        "revision" => "5",
        "elements" => [element()]
      }

      {:ok, state: state, update: update}
    end

    test "a read that started while the connect check waited cannot close the new socket", %{
      state: state
    } do
      {:ok, initial} = SocketWhiteboardV1.init(%{})
      Process.cancel_timer(initial.hello_timer)
      identity = state.identity

      # While the connect check waits behind the admission, a read starts and finds no
      # Participant. The admission then commits and the connect check passes.
      Process.put(:whiteboard_connect_hook, fn ->
        Authority.store(
          identity.episode,
          %{status: "active", participants: %{}},
          System.monotonic_time(:millisecond),
          nil
        )

        Process.sleep(5)
      end)

      # The next read is slow, so the stored read is the one the first frame meets.
      Application.put_env(:chalk_sync, :whiteboard_test_read_delay_ms, 500)

      assert {:push, {:text, _welcome}, live} =
               receive_frame(
                 %{
                   "type" => "hello",
                   "protocol" => "whiteboard-v1",
                   "token" => token(identity),
                   "cursor" => nil
                 },
                 initial
               )

      refute match?({:stop, _reason, _close, _state}, receive_frame(cursor(), live))
    end

    test "a hello while the poller supervisor restarts closes with a retry", %{state: state} do
      {:ok, initial} = SocketWhiteboardV1.init(%{})
      Process.cancel_timer(initial.hello_timer)
      supervisor = Authority.Supervisor

      # Stopping the poller supervisor holds open the window after an Authority restart in
      # which Authority is back and the poller supervisor is not yet.
      :ok = Supervisor.terminate_child(supervisor, Authority.Pollers)
      on_exit(fn -> Supervisor.restart_child(supervisor, Authority.Pollers) end)

      assert {:stop, :normal, {1012, "dependency unavailable"}, closed} =
               receive_frame(
                 %{
                   "type" => "hello",
                   "protocol" => "whiteboard-v1",
                   "token" => token(state.identity),
                   "cursor" => nil
                 },
                 initial
               )

      assert closed.terminal == %{
               close_code: 1012,
               reason: :dependency_unavailable,
               failure: "authority"
             }

      {:ok, _pollers} = Supervisor.restart_child(supervisor, Authority.Pollers)
    end

    test "a hello while Authority is down closes with a retry, even when its poller still runs",
         %{
           state: state
         } do
      {:ok, initial} = SocketWhiteboardV1.init(%{})
      Process.cancel_timer(initial.hello_timer)
      supervisor = Authority.Supervisor
      read(state)

      [{poller, _value}] =
        Registry.lookup(
          ChalkSync.Episodes.Registry,
          {:whiteboard_authority, EpisodeKey.authority_key(state.identity.episode)}
        )

      # A suspended supervisor holds open the restart window: Authority is gone, and the
      # Episode's poller is still registered until the supervisor restarts both. The poller is
      # suspended too, so a read that finds no table cannot end it first.
      :ok = :sys.suspend(poller)
      :ok = :sys.suspend(supervisor)

      on_exit(fn ->
        :sys.resume(supervisor)
        # Queued behind the restart, so it returns once Authority and its pollers are back.
        Supervisor.which_children(supervisor)
      end)

      authority = Process.whereis(Authority)
      monitor = Process.monitor(authority)
      Process.exit(authority, :kill)
      assert_receive {:DOWN, ^monitor, :process, ^authority, :killed}
      assert Process.alive?(poller)

      assert {:stop, :normal, {1012, "dependency unavailable"}, closed} =
               receive_frame(
                 %{
                   "type" => "hello",
                   "protocol" => "whiteboard-v1",
                   "token" => token(state.identity),
                   "cursor" => nil
                 },
                 initial
               )

      assert closed.terminal == %{
               close_code: 1012,
               reason: :dependency_unavailable,
               failure: "authority"
             }

      :ok = :sys.resume(poller)
      :ok = :sys.resume(supervisor)
      Supervisor.which_children(supervisor)
      assert Process.whereis(Authority) not in [nil, authority]
    end

    test "closes instead of sending a cursor after the Participant left", %{state: state} do
      access("active", "left")
      read(state)

      assert {:stop, :normal, {1008, "policy violation"}, closed} =
               receive_frame(%{"type" => "cursor", "x" => 1, "y" => 2}, state)

      assert closed.terminal == %{
               close_code: 1008,
               reason: :permission_denied,
               denial: :participant_inactive
             }

      refute_received {:whiteboard_v1_frame, %{"type" => "cursor"}}
    end

    test "closes instead of receiving board updates after the Episode ended", %{
      state: state,
      update: update
    } do
      access("ended", "active")
      read(state)

      assert {:stop, :normal, {1008, "policy violation"}, _closed} =
               SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, update}, state)
    end

    test "an idle board closes on its own tick after the Participant left", %{state: state} do
      access("active", "left")
      read(state)

      assert {:stop, :normal, {1008, "policy violation"}, _closed} =
               SocketWhiteboardV1.handle_info(:whiteboard_authority_tick, state)
    end

    test "a live board keeps ticking while access holds", %{state: state} do
      read(state)
      assert {:ok, ^state} = SocketWhiteboardV1.handle_info(:whiteboard_authority_tick, state)
      assert_receive :whiteboard_authority_tick, 500
    end

    test "stays open while a removal or an Episode end can still be undone", %{
      state: state,
      update: update
    } do
      for {episode_status, participant_status} <- [
            {"active", "leaving"},
            {"ending", "active"},
            {"ending", "leaving"}
          ] do
        access(episode_status, participant_status)
        state = %{state | identity: %{state.identity | episode: new_episode(state)}}
        read(state)

        assert {:push, {:text, _update}, _state} =
                 SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, update}, state)
      end
    end

    test "closes for a retry and records why when access cannot be checked", %{
      state: state,
      update: update
    } do
      Application.put_env(:chalk_sync, :whiteboard_authority_stale_ms, 100)

      Application.put_env(
        :chalk_sync,
        :whiteboard_test_access,
        {:retryable, {:storage_unavailable, "timeout"}}
      )

      read(state)
      Process.sleep(150)

      assert {:stop, :normal, {1012, "dependency unavailable"}, closed} =
               SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, update}, state)

      assert closed.terminal == %{
               close_code: 1012,
               reason: :dependency_unavailable,
               failure: "timeout"
             }
    end

    test "one change to many sockets in an Episode reads access once", %{
      state: state,
      update: update
    } do
      participants =
        for index <- 1..50 do
          "20000000-0000-4000-8000-#{String.pad_leading(Integer.to_string(index), 12, "0")}"
        end

      Application.put_env(:chalk_sync, :whiteboard_authority_poll_ms, 60_000)

      Application.put_env(
        :chalk_sync,
        :whiteboard_test_access,
        {:ok, %{status: "active", participants: Map.new(participants, &{{&1, 1}, "active"})}}
      )

      read(state)

      for participant_id <- participants do
        socket = %{state | identity: %{state.identity | participant_id: participant_id}}

        assert {:push, {:text, _update}, _state} =
                 SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, update}, socket)
      end

      refute_received {:episode_access_read, _episode}
    end
  end

  defp access(episode_status, participant_status) do
    Application.put_env(
      :chalk_sync,
      :whiteboard_test_access,
      {:ok,
       %{status: episode_status, participants: %{{@participant_id, 1} => participant_status}}}
    )
  end

  # Starts the Episode's poller for this test process and waits for its first read.
  defp read(state) do
    Authority.watch(state.identity.episode)
    assert_receive {:episode_access_read, _episode}, 1_000

    wait_for(fn ->
      :ets.member(
        ChalkSync.WhiteboardV1.Authority,
        EpisodeKey.authority_key(state.identity.episode)
      )
    end)
  end

  defp wait_for(condition, attempts \\ 100) do
    cond do
      condition.() -> :ok
      attempts == 0 -> flunk("condition not met")
      true -> Process.sleep(10) && wait_for(condition, attempts - 1)
    end
  end

  defp new_episode(state), do: %{state.identity.episode | episode_id: UUID.generate()}

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

    state = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        scene_id: @scene_id
    }

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

      assert attributes.close_code == nil
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

  test "shares views only over view_v1 and lets only board managers bring everyone" do
    host = %{identity() | capabilities: ["drawWhiteboard", "manageWhiteboard"]}
    guest = %{identity() | capabilities: ["drawWhiteboard"]}
    {:ok, initial} = SocketWhiteboardV1.init(%{})

    live = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        scene_id: @scene_id,
        revision: 4,
        display_name: "Ada"
    }

    Fanout.subscribe(host.episode)

    view = %{
      "type" => "view",
      "x" => 10,
      "y" => 20,
      "width" => 800,
      "height" => 600,
      "bring" => true
    }

    assert {:ok, _state} = receive_frame(view, %{live | identity: guest, view_negotiated: true})
    refute_received {:whiteboard_v1_frame, %{"type" => "view"}}

    assert {:ok, _state} = receive_frame(view, %{live | identity: host, view_negotiated: false})
    refute_received {:whiteboard_v1_frame, %{"type" => "view"}}

    assert {:ok, _state} = receive_frame(view, %{live | identity: host, view_negotiated: true})

    assert_received {:whiteboard_v1_frame,
                     %{"type" => "view", "bring" => true, "width" => 800} = frame}

    other = %{live | identity: %{guest | participant_id: "60000000-0000-4000-8000-000000000006"}}
    assert {:ok, ^other} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, other)

    assert {:push, {:text, pushed}, _state} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, %{
               other
               | view_negotiated: true
             })

    assert JSON.decode!(pushed)["display_name"] == "Ada"
  after
    Fanout.unsubscribe(identity().episode)
  end

  test "rechecks current management authority for bring after role changes" do
    state = live_view_state()
    Fanout.subscribe(state.identity.episode)
    Process.put(:current_capabilities, ["drawWhiteboard"])
    assert {:ok, _} = receive_frame(view_frame(true), state)
    refute_received {:whiteboard_v1_frame, %{"type" => "view"}}
    Process.put(:current_capabilities, ["drawWhiteboard", "manageWhiteboard"])
    assert {:ok, _} = receive_frame(view_frame(true), state)
    assert_received {:whiteboard_v1_frame, %{"type" => "view", "bring" => true}}
  after
    Fanout.unsubscribe(identity().episode)
  end

  test "denied bring attempts still consume their rate-limit capacity" do
    state = live_view_state()
    Fanout.subscribe(state.identity.episode)
    Process.put(:current_capabilities, ["drawWhiteboard"])
    assert {:ok, once} = receive_frame(view_frame(true), state)
    assert {:ok, twice} = receive_frame(view_frame(true), once)
    Process.put(:current_capabilities, ["drawWhiteboard", "manageWhiteboard"])
    assert {:ok, _} = receive_frame(view_frame(true), twice)
    refute_received {:whiteboard_v1_frame, %{"type" => "view"}}
  after
    Fanout.unsubscribe(identity().episode)
  end

  test "bring has bounded capacity independent of continuous cursor traffic" do
    state = live_view_state()
    Fanout.subscribe(state.identity.episode)

    saturated = saturate_cursor_window(state)

    assert {:ok, brought} = receive_frame(view_frame(true), saturated)
    assert_received {:whiteboard_v1_frame, %{"type" => "view", "bring" => true}}
    assert {:ok, limited} = receive_frame(view_frame(true), brought)
    assert_received {:whiteboard_v1_frame, %{"type" => "view", "bring" => true}}
    assert {:ok, _} = receive_frame(view_frame(true), limited)
    refute_received {:whiteboard_v1_frame, %{"type" => "view", "bring" => true}}
  after
    Fanout.unsubscribe(identity().episode)
  end

  test "ordinary views have bounded capacity independent of continuous cursor traffic" do
    state = live_view_state()
    Fanout.subscribe(state.identity.episode)
    saturated = saturate_cursor_window(state)

    limited =
      Enum.reduce(1..10, saturated, fn _, state ->
        assert {:ok, next} =
                 receive_frame(
                   %{
                     view_frame(false)
                     | "x" =>
                         state.presence_windows[:view]
                         |> then(fn window -> if window, do: elem(window, 1), else: 0 end)
                   },
                   state
                 )

        assert_received {:whiteboard_v1_frame, %{"type" => "view", "bring" => false}}
        next
      end)

    assert {:ok, _} = receive_frame(view_frame(false), limited)
    refute_received {:whiteboard_v1_frame, %{"type" => "view"}}
  after
    Fanout.unsubscribe(identity().episode)
  end

  defp saturate_cursor_window(state) do
    Enum.reduce(1..60, state, fn _, state ->
      assert {:ok, next} = receive_frame(%{"type" => "cursor", "x" => 1, "y" => 2}, state)
      next
    end)
  end

  defp live_view_state do
    {:ok, initial} = SocketWhiteboardV1.init(%{})

    %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        scene_id: @scene_id,
        revision: 4,
        display_name: "Ada",
        identity: %{identity() | capabilities: ["drawWhiteboard", "manageWhiteboard"]},
        view_negotiated: true
    }
  end

  defp view_frame(bring),
    do: %{
      "type" => "view",
      "x" => 10,
      "y" => 20,
      "width" => 800,
      "height" => 600,
      "bring" => bring
    }

  defp server_view(participant_id) do
    Map.merge(view_frame(true), %{
      "participant_id" => participant_id,
      "display_name" => "Host",
      "occurred_at" => "2026-10-21T11:00:00.000Z"
    })
  end

  test "stamps canonical views and strips owner fields for published clients" do
    live = live_view_state()
    assert {:ok, _} = receive_frame(view_frame(false), live)
    assert_received {:whiteboard_v1_frame, %{"owner_sequence" => 1} = frame}

    live = %{
      live
      | identity: %{live.identity | participant_id: "60000000-0000-4000-8000-000000000006"}
    }

    peer = %{live | view_origins_negotiated: true}

    assert {:push, {:text, versioned}, _} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, peer)

    assert JSON.decode!(versioned)["origin_sequence"] == 1
    refute Map.has_key?(JSON.decode!(versioned), "owner_sequence")

    assert {:push, {:text, legacy}, _} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, live)

    refute Map.has_key?(JSON.decode!(legacy), "origin_sequence")
    refute Map.has_key?(JSON.decode!(legacy), "owner_id")
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
        connected_at: connected_earlier(),
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
        connected_at: connected_earlier(),
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
        connected_at: connected_earlier(),
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
        connected_at: connected_earlier(),
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
        connected_at: connected_earlier(),
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
        connected_at: connected_earlier(),
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
        connected_at: connected_earlier(),
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

  defp update_event(revision) do
    %{
      type: :update,
      operation_id: "whiteboard-replay-000#{revision}",
      scene_id: @scene_id,
      revision: revision,
      elements: [element()]
    }
  end

  defp token(identity) do
    DevTokenVerifier.token(%{
      "tenant_id" => identity.episode.tenant_id,
      "space_id" => identity.episode.space_id,
      "episode_id" => identity.episode.episode_id,
      "participant_id" => identity.participant_id,
      "participant_generation" => identity.participant_generation,
      "admission_lifecycle_intent_id" => UUID.generate(),
      "display_name" => "Ada",
      "role" => "collaborator",
      "capabilities" => ["drawWhiteboard"],
      "issued_at" => 1,
      "expires_at" => 4_102_444_800
    })
  end

  defp cursor, do: %{"type" => "cursor", "x" => 1, "y" => 2}

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

  # A socket whose connect check passed a second ago, before the reads the test waits for, so
  # those reads decide its access.
  defp connected_earlier, do: System.monotonic_time(:millisecond) - 1_000
end
