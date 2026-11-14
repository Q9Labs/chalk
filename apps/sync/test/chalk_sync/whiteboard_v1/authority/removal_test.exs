defmodule ChalkSync.WhiteboardV1.AuthorityRemovalTest do
  use ChalkSync.WhiteboardV1.AuthorityCase, async: false

  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.Authority.Poller
  alias ChalkSync.WhiteboardV1.Authority.Reads

  test "after a removal or an end is final, the board stops within one poll interval" do
    Application.put_env(:chalk_sync, :whiteboard_authority_poll_ms, 200)

    for {episode_status, participant_status, denial} <- [
          {"active", "left", :participant_inactive},
          {"ended", "active", :episode_ended}
        ] do
      access("active", "active")
      identity = identity()
      Authority.watch(identity.episode)
      wait_until(fn -> Authority.check(identity) == :ok end)

      # The removal commits just after a read, the latest it can be seen.
      drain_reads(identity.episode)
      assert_receive {:read, _episode}, 1_000
      access(episode_status, participant_status)
      final_at = System.monotonic_time(:millisecond)

      assert until_not_ok(identity) == {:error, {:permission_denied, denial}}
      assert System.monotonic_time(:millisecond) - final_at <= Reads.poll_ms() + 100
    end
  end

  test "when reads fail after a removal, the board stops by the freshness deadline" do
    Application.put_env(:chalk_sync, :whiteboard_authority_poll_ms, 100)
    Application.put_env(:chalk_sync, :whiteboard_authority_stale_ms, 600)
    identity = identity()
    Authority.watch(identity.episode)
    wait_until(fn -> Authority.check(identity) == :ok end)

    # The removal commits, but no read after it succeeds.
    drain_reads(identity.episode)
    assert_receive {:read, _episode}, 1_000
    good_read_at = System.monotonic_time(:millisecond)

    Application.put_env(
      :chalk_sync,
      :authority_test_access,
      {:retryable, {:storage_unavailable, "timeout"}}
    )

    assert until_not_ok(identity) == {:retryable, {:storage_unavailable, "timeout"}}
    assert System.monotonic_time(:millisecond) - good_read_at <= 600 + 100
  end

  test "a removal that commits during an in-flight read stops the board within P + D" do
    Application.put_env(:chalk_sync, :whiteboard_authority_poll_ms, 300)
    Application.put_env(:chalk_sync, :whiteboard_authority_read_ms, 300)
    Application.put_env(:chalk_sync, :authority_test_read_delay_ms, 250)
    identity = identity()
    connected_at = System.monotonic_time(:millisecond)
    Authority.watch(identity.episode)
    wait_until(fn -> Authority.check(identity, connected_at) == :ok end)

    # This read already has the old answer and returns it 250 ms later.
    drain_reads(identity.episode)
    assert_receive {:read, _episode}, 1_000
    access("active", "left")
    final_at = System.monotonic_time(:millisecond)

    assert until_not_ok(identity, connected_at) ==
             {:error, {:permission_denied, :participant_inactive}}

    assert System.monotonic_time(:millisecond) - final_at <= 300 + 300 + 100
  end

  test "a poller killed while reads fail does not extend the freshness deadline" do
    Application.put_env(:chalk_sync, :whiteboard_authority_poll_ms, 100)
    Application.put_env(:chalk_sync, :whiteboard_authority_stale_ms, 600)
    identity = identity()
    connected_at = System.monotonic_time(:millisecond)
    Authority.watch(identity.episode)
    wait_until(fn -> Authority.check(identity, connected_at) == :ok end)

    drain_reads(identity.episode)
    assert_receive {:read, _episode}, 1_000
    good_read_at = System.monotonic_time(:millisecond)
    fail_reads()

    for _failed <- 1..3,
        do: assert_receive({:read, _episode}, 1_000)

    # The next check finds no stored read and starts a new poller, whose reads fail too.
    [{poller, _value}] = pollers(identity.episode)
    Process.exit(poller, :kill)

    assert {:retryable, {:storage_unavailable, _failure}} = until_not_ok(identity, connected_at)
    assert System.monotonic_time(:millisecond) - good_read_at <= 600 + 100
  end

  test "a check while the poller supervisor restarts asks for a retry" do
    identity = identity()
    supervisor = Authority.Supervisor

    # After an Authority restart, the poller supervisor is the last child to come back.
    :ok = Supervisor.terminate_child(supervisor, Authority.Pollers)
    on_exit(fn -> Supervisor.restart_child(supervisor, Authority.Pollers) end)

    assert Authority.check(identity, System.monotonic_time(:millisecond)) ==
             {:retryable, {:storage_unavailable, "authority"}}

    {:ok, _pollers} = Supervisor.restart_child(supervisor, Authority.Pollers)
    wait_until(fn -> Authority.check(identity) == :ok end)
  end

  test "a read that does not answer gives up at the read deadline" do
    Application.put_env(:chalk_sync, :whiteboard_authority_read_ms, 200)
    Application.put_env(:chalk_sync, :authority_test_read_delay_ms, 5_000)
    started_at = System.monotonic_time(:millisecond)

    assert Poller.read_access(identity().episode) ==
             {:retryable, {:storage_unavailable, "deadline"}}

    assert System.monotonic_time(:millisecond) - started_at <= 200 + 100
  end

  test "an Episode named in a different letter case shares one poller and one stored read" do
    identity = identity()

    upper = %{
      identity
      | episode: %{
          identity.episode
          | tenant_id: String.upcase(identity.episode.tenant_id),
            episode_id: String.upcase(identity.episode.episode_id)
        }
    }

    Authority.watch(identity.episode)
    wait_until(fn -> Authority.check(identity) == :ok end)
    Authority.watch(upper.episode)

    assert Authority.check(upper) == :ok
    assert [{poller, _value}] = pollers(identity.episode)
    assert pollers(upper.episode) == [{poller, nil}]
    drain_reads(identity.episode)
    drain_reads(upper.episode)
    Process.sleep(Reads.poll_ms() * 3)
    assert (drain_reads(identity.episode) + drain_reads(upper.episode)) in 2..4
  end

  test "pollers are not Episode Coordinators, so a drain and the Coordinator count skip them" do
    identity = identity()
    Authority.watch(identity.episode)
    wait_until(fn -> Authority.check(identity) == :ok end)
    [{poller, _value}] = pollers(identity.episode)
    monitor = Process.monitor(poller)

    refute Enum.any?(
             DynamicSupervisor.which_children(ChalkSync.Episodes.Supervisor),
             fn {_id, child, _type, _modules} -> child == poller end
           )

    Coordinator.drain_all()

    refute_receive {:DOWN, ^monitor, :process, ^poller, _reason}, 200
    drain_reads(identity.episode)
    assert_receive {:read, _episode}, 1_000
  end
end
