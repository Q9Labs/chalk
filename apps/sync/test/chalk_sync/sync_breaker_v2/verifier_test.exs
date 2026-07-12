defmodule ChalkSync.SyncBreakerV2.VerifierTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.SyncBreakerV2.Config
  alias ChalkSync.SyncBreakerV2.Replica
  alias ChalkSync.SyncBreakerV2.Verifier

  setup do
    started? = is_nil(Process.whereis(Memory))
    if started?, do: start_supervised!(Memory)
    Memory.reset()

    on_exit(fn ->
      if Process.whereis(Memory), do: Memory.reset()
    end)

    :ok
  end

  test "audits the persisted event stream when revision-zero recovery selects a snapshot" do
    fixture = seed_fixture()

    Enum.each(1..2_050, fn index ->
      name = if rem(index, 2) == 1, do: :raise_hand, else: :lower_hand
      {:ok, command} = Command.new("snapshot_boundary_#{index}", name, %{})

      assert {:ok, %{result: :committed}} =
               Memory.decide_command(hd(fixture.identities), command)
    end)

    initial_cursor = %{
      revision: 0,
      state_schema_version: 1,
      digest: Replica.digest(Replica.new())
    }

    assert {:ok, %{mode: :snapshot, head: %{revision: 2_051}}} =
             Memory.recover_session(fixture.session, initial_cursor)

    config =
      Config.new!(
        sessions: 1,
        participants: 1,
        sockets: 1,
        subscriptions: 1,
        commands: 1,
        burst: 1,
        concurrency: 1,
        cursor_age: 16,
        network_interrupt_every: 1
      )

    result = Verifier.verify(config, :memory, [fixture], [Verifier.setup_trace(config)])

    assert result.verdict == "PASS"
    assert result.metrics["trace_records"] == 2_053
    assert [%{session: session_id, revision: 2_051}] = result.metrics["sessions"]
    assert session_id == fixture.session.session_id
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

    identity = %Identity{
      session: session,
      participant_session_id: participant.id,
      participant_session_generation: participant.generation,
      capabilities: participant.capabilities
    }

    %{session: session, identities: [identity]}
  end
end
