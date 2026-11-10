defmodule ChalkSync.Episodes.CoordinatorRecoveryTest do
  use ExUnit.Case, async: false
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Stateholder.{EpisodeKey, Identity}
  alias ChalkSync.UUID

  test "a new recovery survives the last socket stopping its coordinator" do
    identity = %Identity{
      episode: %EpisodeKey{
        tenant_id: UUID.generate(),
        space_id: UUID.generate(),
        episode_id: UUID.generate()
      },
      participant_id: UUID.generate(),
      participant_generation: 1
    }

    socket = self()
    assert {:ok, previous} = Coordinator.begin_recovery(identity, socket)
    monitor = Process.monitor(previous)
    :sys.suspend(previous)
    # Queue the final departure, then prove the new recovery has found the old PID.
    Coordinator.unsubscribe(previous, socket)

    task =
      Task.async(fn ->
        receive do
          :begin -> Coordinator.begin_recovery(identity, socket)
        end
      end)

    :erlang.trace(task.pid, true, [:send])
    send(task.pid, :begin)

    try do
      assert_receive {:trace, _, :send, {:"$gen_call", _, {:begin_recovery, ^socket, _, _}},
                      ^previous},
                     1_000

      :sys.resume(previous)
      assert {:ok, current} = Task.await(task)
      assert_receive {:DOWN, ^monitor, :process, ^previous, :normal}
      refute Process.alive?(previous)
      refute current == previous
      assert Coordinator.whereis(identity.episode) == current
      Coordinator.unsubscribe(current, socket)
    after
      if Process.alive?(previous), do: :sys.resume(previous)
    end
  end
end
