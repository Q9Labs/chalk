defmodule ChalkSync.WhiteboardV1.SocketHelloTest do
  use ChalkSync.WhiteboardV1.SocketCase, async: false

  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.WhiteboardV1.ViewOwner

  @participant_id "20000000-0000-4000-8000-000000000002"
  @scene_id "10000000-0000-4000-8000-000000000001"
  @session_id "3f2b8c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c"

  test "hello baggage is propagated to authenticated and closed observability events" do
    owner = self()
    handler = "whiteboard-session-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _, _, metadata, _ ->
        if metadata.event in ["sync.websocket.authenticated", "sync.websocket.closed"] do
          send(owner, {:whiteboard_observed, metadata.event, metadata.session_id})
        end
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)

    assert Task.async(fn -> authenticate_hello("session.id=#{@session_id}") end)
           |> Task.await() == :live

    assert_receive {:whiteboard_observed, "sync.websocket.authenticated", @session_id}
    assert_receive {:whiteboard_observed, "sync.websocket.closed", @session_id}
  end

  test "invalid hello baggage does not prevent authentication" do
    owner = self()
    handler = "whiteboard-invalid-session-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _, _, metadata, _ ->
        if metadata.event in ["sync.websocket.authenticated", "sync.websocket.closed"] do
          send(owner, {:whiteboard_observed, metadata.event, metadata.session_id})
        end
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)

    assert Task.async(fn -> authenticate_hello("session.id=invalid") end)
           |> Task.await() == :live

    assert_receive {:whiteboard_observed, "sync.websocket.authenticated", nil}
    assert_receive {:whiteboard_observed, "sync.websocket.closed", nil}
  end

  test "enforces the hello deadline and strict text framing" do
    assert {:ok, state} = SocketWhiteboardV1.init(%{})

    assert {:stop, :normal, {1008, "hello timeout"}, timeout_state} =
             SocketWhiteboardV1.handle_info(:hello_timeout, state)

    assert timeout_state.terminal == %{close_code: 1008, reason: :hello_timeout}

    assert {:stop, :normal, {1009, "text frames only"}, frame_state} =
             SocketWhiteboardV1.handle_in({<<1, 2>>, [opcode: :binary]}, state)

    assert frame_state.terminal == %{close_code: 1009, reason: :protocol_error}

    assert {:push, {:text, ~s({"type":"pong"})}, pinged} =
             SocketWhiteboardV1.handle_in(
               {~s({"type":"ping"}), [opcode: :text]},
               state
             )

    assert is_integer(pinged.last_heartbeat_at_ms)
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
        scene_id: @scene_id,
        opened_at_ms: System.monotonic_time(:millisecond) - 90_000,
        last_heartbeat_at_ms: System.monotonic_time(:millisecond) - 70_000
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
      assert attributes.socket_age_ms >= 90_000
      assert attributes.heartbeat_gap_ms >= 70_000
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

  test "closes with 1012 when the owner dies during a view call" do
    parent = self()
    episode = new_episode(live_access_state())

    socket =
      Task.async(fn ->
        {:ok, owner, owner_id, _snapshot} = ViewOwner.join(episode, @participant_id)
        state = live_access_state()

        live = %{
          state
          | identity: %{state.identity | episode: episode},
            extensions: extensions(view: :basic),
            view_owner: owner,
            view_owner_ref: Process.monitor(owner)
        }

        send(parent, {:socket_ready, owner, owner_id})

        receive do
          :move -> receive_frame(view_frame(false), live)
        end
      end)

    assert_receive {:socket_ready, owner, owner_id}
    on_exit(fn -> if Process.alive?(owner), do: Process.exit(owner, :kill) end)
    :ok = :sys.suspend(owner)
    :erlang.trace(owner, true, [:receive])
    send(socket.pid, :move)
    assert_receive {:trace, ^owner, :receive, {:"$gen_call", _from, {:view, _, _, _}}}
    Process.exit(owner, :kill)

    assert {:stop, :normal, {1012, "view owner restarted"}, closed} = Task.await(socket)
    assert closed.terminal == %{close_code: 1012, reason: :view_owner_restarted}
    assert {:ok, replacement, replacement_id, []} = ViewOwner.join(episode, @participant_id)
    assert replacement != owner
    assert replacement_id != owner_id
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

  defp authenticate_hello(baggage) do
    identity = identity()
    {:ok, initial} = SocketWhiteboardV1.init(%{})

    frame = %{
      "type" => "hello",
      "protocol" => "whiteboard-v1",
      "token" => token(identity),
      "cursor" => nil,
      "baggage" => baggage
    }

    case SocketWhiteboardV1.handle_in({JSON.encode!(frame), [opcode: :text]}, initial) do
      {:push, {:text, _welcome}, state} ->
        phase = state.phase
        SocketWhiteboardV1.terminate(:normal, state)
        phase

      other ->
        other
    end
  end
end
