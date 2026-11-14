defmodule ChalkSync.WhiteboardV1.AuthorityReadsTest do
  use ChalkSync.WhiteboardV1.AuthorityCase, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.Authority.Reads

  test "many sockets checking all the time share one read per Episode per poll" do
    identity = identity()

    sockets =
      for _socket <- 1..50 do
        Task.async(fn ->
          connected_at = System.monotonic_time(:millisecond)

          for _check <- 1..40 do
            assert Authority.check(identity, connected_at) == :ok
            Process.sleep(10)
          end
        end)
      end

    Task.await_many(sockets)

    # 50 sockets made 2,000 checks over about 400 ms, which is about 8 poll intervals.
    assert drain_reads(identity.episode) in 1..12
  end

  test "a person who joins after the last read keeps the board until a newer read" do
    Application.put_env(:chalk_sync, :whiteboard_authority_poll_ms, 300)
    identity = identity()

    Application.put_env(
      :chalk_sync,
      :authority_test_access,
      {:ok, %{status: "active", participants: %{}}}
    )

    Authority.watch(identity.episode)

    wait_until(fn ->
      :ets.member(:whiteboard_authority_reads, EpisodeKey.authority_key(identity.episode))
    end)

    # Connect checked the database just now and found the new Participant active.
    connected_at = System.monotonic_time(:millisecond)
    assert Authority.check(identity, connected_at) == :ok

    # A read that started after the connect is current, so it decides.
    drain_reads(identity.episode)
    assert_receive {:read, _episode}, 1_000

    wait_until(fn ->
      Authority.check(identity, connected_at) ==
        {:error, {:permission_denied, :participant_inactive}}
    end)
  end

  test "a removal or an end that can still be undone keeps the socket open" do
    for {episode_status, participant_status} <- [
          {"active", "leaving"},
          {"ending", "active"},
          {"active", "joining"}
        ] do
      identity = identity()
      access(episode_status, participant_status)
      Authority.watch(identity.episode)

      wait_until(fn ->
        :ets.member(:whiteboard_authority_reads, EpisodeKey.authority_key(identity.episode))
      end)

      assert Authority.check(identity) == :ok
    end

    identity = identity()
    access("ended", "active")
    Authority.watch(identity.episode)

    wait_until(fn ->
      Authority.check(identity) == {:error, {:permission_denied, :episode_ended}}
    end)
  end

  test "failed reads keep the last access until it is stale, then ask for a retry" do
    Application.put_env(:chalk_sync, :whiteboard_authority_stale_ms, 300)
    identity = identity()
    Authority.watch(identity.episode)

    wait_until(fn ->
      :ets.member(:whiteboard_authority_reads, EpisodeKey.authority_key(identity.episode))
    end)

    Application.put_env(
      :chalk_sync,
      :authority_test_access,
      {:retryable, {:storage_unavailable, "timeout"}}
    )

    drain_reads(identity.episode)
    assert_receive {:read, _episode}
    assert Authority.check(identity) == :ok

    wait_until(fn ->
      Authority.check(identity) == {:retryable, {:storage_unavailable, "timeout"}}
    end)
  end

  test "a socket that just connected keeps the board while the stored read is stale" do
    Application.put_env(:chalk_sync, :whiteboard_authority_stale_ms, 300)
    identity = identity()
    now = System.monotonic_time(:millisecond)
    Reads.store(identity.episode, nil, now - 10_000, "timeout")

    # The connect check just read the database and found the Participant.
    connected_at = System.monotonic_time(:millisecond)
    assert Authority.check(identity, connected_at) == :ok
    assert Authority.check(identity) == {:retryable, {:storage_unavailable, "timeout"}}

    Process.sleep(350)

    assert Authority.check(identity, connected_at) ==
             {:retryable, {:storage_unavailable, "timeout"}}
  end

  test "an Episode that no longer exists denies access" do
    identity = identity()
    Application.put_env(:chalk_sync, :authority_test_access, {:error, :not_found})
    Authority.watch(identity.episode)

    wait_until(fn ->
      Authority.check(identity) == {:error, {:permission_denied, :episode_not_found}}
    end)
  end
end
