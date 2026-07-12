defmodule ChalkSync.SyncBreakerV2.RunnerTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.SyncBreakerV2.Config
  alias ChalkSync.SyncBreakerV2.Runner

  setup do
    started? = is_nil(Process.whereis(Memory))

    if started? do
      {:ok, _pid} = Memory.start_link([])
    end

    Memory.reset()

    on_exit(fn ->
      if started?, do: GenServer.stop(Memory)
      if Process.whereis(Memory), do: Memory.reset()
    end)

    {:ok, fixtures: [seed_fixture()]}
  end

  test "waits until a duration campaign reaches its requested minimum", %{fixtures: fixtures} do
    config = Config.new!(commands: 5, command_rate: 100, burst: 5, duration_ms: 50)
    {:ok, clock} = Agent.start_link(fn -> %{now_ms: 0, sleeps: []} end)

    timing = %{
      now_ms: fn -> Agent.get(clock, & &1.now_ms) end,
      sleep: fn duration_ms ->
        Agent.update(clock, fn state ->
          %{state | now_ms: state.now_ms + duration_ms, sleeps: [duration_ms | state.sleeps]}
        end)
      end
    }

    {outcomes, _trace} = Runner.run(config, :memory, fixtures, timing)

    assert length(outcomes) == config.operation_count
    assert %{now_ms: 50, sleeps: [50]} = Agent.get(clock, & &1)
  end

  defp seed_fixture do
    session = %SessionKey{
      tenant_id: "11111111-1111-4111-8111-111111111111",
      room_id: "22222222-2222-4222-8222-222222222222",
      session_id: "33333333-3333-4333-8333-333333333333"
    }

    participant = %{
      id: "55555555-5555-4555-8555-555555555555",
      generation: 1,
      display_name: "Breaker",
      capabilities: ["control:hand"]
    }

    :ok = Memory.seed_session(session, [participant])

    %{
      identities: [
        %Identity{
          session: session,
          participant_session_id: participant.id,
          participant_session_generation: participant.generation,
          capabilities: participant.capabilities
        }
      ]
    }
  end
end
