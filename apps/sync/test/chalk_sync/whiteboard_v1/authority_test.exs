defmodule ChalkSync.WhiteboardV1.AuthorityTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority

  @participant_id "20000000-0000-4000-8000-000000000002"

  defmodule Repository do
    # Each read reports to the test and waits until the test releases it.
    def episode_access(_episode) do
      send(Process.get(:authority_test), {:reading, self()})
      receive do: (:release -> :ok)

      {:ok,
       %{
         status: "active",
         participants: %{{"20000000-0000-4000-8000-000000000002", 1} => "active"}
       }}
    end
  end

  setup do
    previous = Application.get_env(:chalk_sync, :whiteboard_v1_repository)
    Application.put_env(:chalk_sync, :whiteboard_v1_repository, Repository)

    on_exit(fn ->
      Application.delete_env(:chalk_sync, :whiteboard_authority_ttl_ms)
      Application.delete_env(:chalk_sync, :whiteboard_authority_wait_ms)

      if previous,
        do: Application.put_env(:chalk_sync, :whiteboard_v1_repository, previous),
        else: Application.delete_env(:chalk_sync, :whiteboard_v1_repository)
    end)
  end

  test "sockets that find no cached access wait for one read instead of each reading" do
    identity = identity()
    sockets = for _index <- 1..50, do: check_async(identity)

    assert_receive {:reading, reader}
    refute_receive {:reading, _another}, 200
    send(reader, :release)

    assert Task.await_many(sockets) == List.duplicate(:ok, 50)
    refute_received {:reading, _another}
  end

  test "a socket that dies while it reads hands the read to one waiting socket" do
    identity = identity()
    first = check_async(identity)
    assert_receive {:reading, reader}
    waiting = for _index <- 1..10, do: check_async(identity)
    wait_until(fn -> length(read_for(identity).waiters) == 10 end)

    Task.shutdown(first, :brutal_kill)
    assert_receive {:reading, next}
    refute next == reader
    refute_receive {:reading, _another}, 200
    send(next, :release)

    assert Task.await_many(waiting) == List.duplicate(:ok, 10)
  end

  test "access read for Episodes that are no longer checked does not stay in memory" do
    Application.put_env(:chalk_sync, :whiteboard_authority_ttl_ms, 50)

    episodes =
      for _episode <- 1..20 do
        identity = identity()
        socket = check_async(identity)
        assert_receive {:reading, reader}
        send(reader, :release)
        assert Task.await(socket) == :ok
        # The reader reports by cast, so a call to Authority waits until the access is stored.
        :sys.get_state(Authority)
        assert :ets.member(Authority, identity.episode)
        identity.episode
      end

    Process.sleep(60)
    send(Authority, :sweep)
    :sys.get_state(Authority)

    assert Enum.filter(episodes, &:ets.member(Authority, &1)) == []
  end

  test "a report from a read that Authority no longer tracks is ignored" do
    # A read that started before Authority restarted reports to the new process.
    authority = Process.whereis(Authority)
    identity = identity()
    access = %{status: "active", participants: %{{@participant_id, 1} => "active"}}
    read_at = System.monotonic_time(:millisecond)
    GenServer.cast(Authority, {:read, identity.episode, make_ref(), read_at, {:ok, access}})

    assert %{reads: %{}} = :sys.get_state(Authority)
    assert Process.whereis(Authority) == authority
    refute :ets.member(Authority, identity.episode)
  end

  test "a read that stalls is taken over, and its late result is ignored" do
    Application.put_env(:chalk_sync, :whiteboard_authority_wait_ms, 100)
    identity = identity()
    stalled = check_async(identity)
    assert_receive {:reading, stalled_reader}

    Process.sleep(150)
    socket = check_async(identity)
    assert_receive {:reading, reader}
    refute reader == stalled_reader
    send(reader, :release)
    assert Task.await(socket) == :ok

    send(stalled_reader, :release)
    assert Task.await(stalled) == :ok
    :sys.get_state(Authority)
    refute Map.has_key?(:sys.get_state(Authority).reads, identity.episode)
  end

  defp read_for(identity), do: :sys.get_state(Authority).reads[identity.episode]

  defp wait_until(condition, attempts \\ 100) do
    cond do
      condition.() -> :ok
      attempts == 0 -> flunk("condition not met")
      true -> Process.sleep(10) && wait_until(condition, attempts - 1)
    end
  end

  defp check_async(identity) do
    test = self()

    Task.async(fn ->
      Process.put(:authority_test, test)
      Authority.check(identity)
    end)
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
