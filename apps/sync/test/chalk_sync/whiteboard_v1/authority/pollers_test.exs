defmodule ChalkSync.WhiteboardV1.AuthorityPollersTest do
  use ChalkSync.WhiteboardV1.AuthorityCase, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.WhiteboardV1.Authority

  test "an Episode stops being read and leaves memory when its last socket closes" do
    identity = identity()
    test = self()

    sockets =
      for _socket <- 1..3 do
        spawn(fn ->
          send(test, {:watching, Authority.watch(identity.episode)})
          receive do: (:close -> :ok)
        end)
      end

    for _socket <- sockets, do: assert_receive({:watching, :ok})

    wait_until(fn ->
      :ets.member(:whiteboard_authority_reads, EpisodeKey.authority_key(identity.episode))
    end)

    [{poller, _value}] = pollers(identity.episode)

    monitor = Process.monitor(poller)
    Enum.each(sockets, &send(&1, :close))

    assert_receive {:DOWN, ^monitor, :process, ^poller, :normal}

    wait_until(fn ->
      not :ets.member(:whiteboard_authority_reads, EpisodeKey.authority_key(identity.episode))
    end)

    drain_reads(identity.episode)
    # Pollers of earlier tests can still report reads of their own Episodes here.
    episode = identity.episode
    refute_receive {:read, ^episode}, 200
  end

  test "a killed poller's stored read leaves memory, and another poller's read stays" do
    identity = identity()
    other = identity()
    test = self()

    [socket, other_socket] =
      for episode <- [identity.episode, other.episode] do
        spawn(fn ->
          Authority.watch(episode)
          send(test, :watching)
          receive do: (:close -> :ok)
        end)
      end

    assert_receive :watching
    assert_receive :watching

    wait_until(fn ->
      :ets.member(:whiteboard_authority_reads, EpisodeKey.authority_key(identity.episode))
    end)

    wait_until(fn ->
      :ets.member(:whiteboard_authority_reads, EpisodeKey.authority_key(other.episode))
    end)

    [{poller, _value}] = pollers(identity.episode)
    monitor = Process.monitor(poller)

    # A kill skips the poller's own cleanup.
    Process.exit(poller, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^poller, :killed}
    send(socket, :close)

    wait_until(fn ->
      not :ets.member(:whiteboard_authority_reads, EpisodeKey.authority_key(identity.episode))
    end)

    # The Registry drops the killed poller's name on its own schedule.
    wait_until(fn -> pollers(identity.episode) == [] end)
    assert :ets.member(:whiteboard_authority_reads, EpisodeKey.authority_key(other.episode))
    send(other_socket, :close)
  end

  test "a poller that replaces a killed one keeps its own stored read" do
    identity = identity()
    Authority.watch(identity.episode)
    wait_until(fn -> Authority.check(identity) == :ok end)
    [{killed, _value}] = pollers(identity.episode)
    monitor = Process.monitor(killed)
    Process.exit(killed, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^killed, :killed}

    # Like a socket, check until a new poller runs: a watch can still reach the killed poller's
    # name before the Registry drops it, and a check with no stored read watches again.
    wait_until(fn ->
      Authority.check(identity)
      match?([{poller, _value}] when poller != killed, pollers(identity.episode))
    end)

    [{poller, _value}] = pollers(identity.episode)
    wait_until(fn -> stored_by(identity.episode) == poller end)

    # Authority has handled the killed poller's exit, and the new read is still there.
    :sys.get_state(Authority)
    assert stored_by(identity.episode) == poller
  end

  test "after Authority restarts, a killed poller's read still leaves memory at once" do
    Application.put_env(:chalk_sync, :whiteboard_authority_stale_ms, 600)
    identity = identity()
    # Connected long ago, so only a stored read keeps this socket's access fresh.
    connected_at = System.monotonic_time(:millisecond) - 1_000
    Authority.watch(identity.episode)
    wait_until(fn -> Authority.check(identity, connected_at) == :ok end)
    [{old_poller, _value}] = pollers(identity.episode)
    old_monitor = Process.monitor(old_poller)

    authority = Process.whereis(Authority)
    Process.exit(authority, :kill)

    # The pollers restart with Authority, since its table and its monitors are gone.
    assert_receive {:DOWN, ^old_monitor, :process, ^old_poller, _reason}, 1_000
    wait_until(fn -> Process.whereis(Authority) not in [nil, authority] end)
    wait_until(fn -> Authority.check(identity, connected_at) == :ok end)
    [{poller, _value}] = pollers(identity.episode)

    fail_reads()
    Process.exit(poller, :kill)
    killed_at = System.monotonic_time(:millisecond)

    # Until the next poller stores its first failed read, the check finds no read at all.
    assert {:retryable, {:storage_unavailable, _failure}} = until_not_ok(identity, connected_at)
    assert System.monotonic_time(:millisecond) - killed_at <= 100
  end

  defp stored_by(episode) do
    case :ets.lookup(:whiteboard_authority_reads, EpisodeKey.authority_key(episode)) do
      [{_episode, poller, _access, _read_at, _failure}] -> poller
      [] -> nil
    end
  end
end
