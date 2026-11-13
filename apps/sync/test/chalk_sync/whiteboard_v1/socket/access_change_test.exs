defmodule ChalkSync.WhiteboardV1.SocketAccessChangeTest do
  use ChalkSync.WhiteboardV1.SocketCase, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.Authority.Reads
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.Fanout

  @scene_id "10000000-0000-4000-8000-000000000001"

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
        Reads.store(
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
      episode = state.identity.episode

      for participant_id <- participants do
        socket = %{state | identity: %{state.identity | participant_id: participant_id}}

        assert {:push, {:text, _update}, _state} =
                 SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, update}, socket)
      end

      refute_received {:episode_access_read, ^episode}
    end
  end
end
