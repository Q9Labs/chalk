defmodule ChalkSync.WhiteboardV1.AuthorityTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority

  @participant_id "20000000-0000-4000-8000-000000000002"

  defmodule Repository do
    # Reads run in the Episode's poller, so the test's answer and its read log live in app env.
    def episode_access(episode) do
      if test = Application.get_env(:chalk_sync, :authority_test),
        do: send(test, {:read, episode})

      Application.get_env(:chalk_sync, :authority_test_access)
    end
  end

  setup do
    previous = Application.get_env(:chalk_sync, :whiteboard_v1_repository)
    Application.put_env(:chalk_sync, :whiteboard_v1_repository, Repository)
    Application.put_env(:chalk_sync, :authority_test, self())
    Application.put_env(:chalk_sync, :whiteboard_authority_poll_ms, 50)
    access("active", "active")

    on_exit(fn ->
      for key <- [
            :authority_test,
            :authority_test_access,
            :whiteboard_authority_poll_ms,
            :whiteboard_authority_stale_ms
          ],
          do: Application.delete_env(:chalk_sync, key)

      if previous,
        do: Application.put_env(:chalk_sync, :whiteboard_v1_repository, previous),
        else: Application.delete_env(:chalk_sync, :whiteboard_v1_repository)
    end)
  end

  test "many sockets checking all the time share one read per Episode per poll" do
    identity = identity()

    sockets =
      for _socket <- 1..50 do
        Task.async(fn ->
          for _check <- 1..40 do
            assert Authority.check(identity) == :ok
            Process.sleep(10)
          end
        end)
      end

    Task.await_many(sockets)

    # 50 sockets made 2,000 checks over about 400 ms, which is about 8 poll intervals.
    assert drain_reads(identity.episode) in 1..12
  end

  test "an idle socket sees a removal without sending anything" do
    identity = identity()
    Authority.watch(identity.episode)
    assert_receive {:read, _episode}

    access("active", "left")
    wait_until(fn -> Authority.check(identity) == {:error, :permission_denied} end)
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
      wait_until(fn -> :ets.member(Authority, identity.episode) end)
      assert Authority.check(identity) == :ok
    end

    identity = identity()
    access("ended", "active")
    Authority.watch(identity.episode)
    wait_until(fn -> Authority.check(identity) == {:error, :permission_denied} end)
  end

  test "failed reads keep the last access until it is stale, then ask for a retry" do
    Application.put_env(:chalk_sync, :whiteboard_authority_stale_ms, 300)
    identity = identity()
    Authority.watch(identity.episode)
    wait_until(fn -> :ets.member(Authority, identity.episode) end)

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

  test "an Episode that no longer exists denies access" do
    identity = identity()
    Application.put_env(:chalk_sync, :authority_test_access, {:error, :not_found})
    Authority.watch(identity.episode)
    wait_until(fn -> Authority.check(identity) == {:error, :permission_denied} end)
  end

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
    wait_until(fn -> :ets.member(Authority, identity.episode) end)

    [{poller, _value}] =
      Registry.lookup(ChalkSync.Episodes.Registry, {:whiteboard_authority, identity.episode})

    monitor = Process.monitor(poller)
    Enum.each(sockets, &send(&1, :close))

    assert_receive {:DOWN, ^monitor, :process, ^poller, :normal}
    refute :ets.member(Authority, identity.episode)
    drain_reads(identity.episode)
    refute_receive {:read, _episode}, 200
  end

  defp access(episode_status, participant_status) do
    Application.put_env(
      :chalk_sync,
      :authority_test_access,
      {:ok,
       %{status: episode_status, participants: %{{@participant_id, 1} => participant_status}}}
    )
  end

  defp drain_reads(episode, count \\ 0) do
    receive do
      {:read, ^episode} -> drain_reads(episode, count + 1)
    after
      0 -> count
    end
  end

  defp wait_until(condition, attempts \\ 100) do
    cond do
      condition.() -> :ok
      attempts == 0 -> flunk("condition not met")
      true -> Process.sleep(10) && wait_until(condition, attempts - 1)
    end
  end

  defp identity do
    %Identity{
      participant_id: @participant_id,
      participant_generation: 1,
      episode: %EpisodeKey{
        tenant_id: UUID.generate(),
        space_id: UUID.generate(),
        episode_id: UUID.generate()
      }
    }
  end
end
