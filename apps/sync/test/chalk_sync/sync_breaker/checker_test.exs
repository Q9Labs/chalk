defmodule ChalkSync.SyncBreaker.CheckerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreaker.Checker
  alias ChalkSync.SyncBreaker.Checker.Failure
  alias ChalkSync.SyncBreaker.Generator
  alias ChalkSync.SyncBreaker.History.Record
  alias ChalkSync.SyncBreaker.Operation

  test "valid generated history satisfies every invariant" do
    assert :ok = Checker.check(valid_history())
  end

  test "revision continuity fails for a gapped event" do
    history =
      update_first(valid_history(), :event, fn record ->
        %{record | event: %{record.event | base_revision: 4, revision: 5}}
      end)

    assert_failure(:revision_continuity, Checker.check_revision_continuity(history))
  end

  test "model convergence fails for a stale authoritative snapshot" do
    history =
      update_first(valid_history(), :snapshot, fn record ->
        %{record | snapshot: %{"control_revision" => 0, "participants" => []}}
      end)

    assert_failure(:model_convergence, Checker.check_model_convergence(history))
  end

  test "acknowledgement correlation fails when a committed revision has no event" do
    history =
      update_first(valid_history(), :complete, fn record ->
        case record.outcome do
          {:committed, _revision} -> %{record | outcome: {:committed, 9_999}}
          _outcome -> record
        end
      end)

    assert_failure(:ack_event_correlation, Checker.check_ack_event_correlation(history))
  end

  test "rejected commands fail when they emit an event" do
    operation = Operation.new(1, "p1", "c-1", :raise_hand)

    event = %{
      name: "hand_raised",
      base_revision: 0,
      revision: 1,
      payload: %{"participant_id" => "p1"}
    }

    history = [
      Record.complete(1, operation, {:rejected, :no_change}),
      Record.event(2, operation, event)
    ]

    assert_failure(:rejected_no_mutation, Checker.check_rejected_no_mutation(history))
  end

  test "replay equivalence fails for a missing replay event" do
    history =
      update_first(valid_history(), :replay, fn record ->
        %{record | events: []}
      end)

    assert_failure(
      :replay_snapshot_equivalence,
      Checker.check_replay_snapshot_equivalence(history)
    )
  end

  test "replay equivalence rejects a state-equivalent but incorrect event suffix" do
    join = Operation.new(1, "p1", "c-1", :join, %{display_name: "Ada"})
    raise = Operation.new(2, "p1", "c-2", :raise_hand)
    lower = Operation.new(3, "p1", "c-3", :lower_hand)

    joined = %{
      name: "participant_joined",
      base_revision: 0,
      revision: 1,
      payload: %{"participant_id" => "p1", "display_name" => "Ada"}
    }

    raised = %{
      name: "hand_raised",
      base_revision: 1,
      revision: 2,
      payload: %{"participant_id" => "p1"}
    }

    lowered = %{
      name: "hand_lowered",
      base_revision: 2,
      revision: 3,
      payload: %{"participant_id" => "p1"}
    }

    alternate = [
      %{
        name: "participant_left",
        base_revision: 1,
        revision: 2,
        payload: %{"participant_id" => "p1"}
      },
      %{
        name: "participant_joined",
        base_revision: 2,
        revision: 3,
        payload: %{"participant_id" => "p1", "display_name" => "Ada"}
      }
    ]

    snapshot = %{
      "control_revision" => 3,
      "participants" => [
        %{"participant_id" => "p1", "display_name" => "Ada", "hand_raised" => false}
      ]
    }

    history = [
      Record.event(1, join, joined),
      Record.event(2, raise, raised),
      Record.event(3, lower, lowered),
      Record.snapshot(4, snapshot),
      Record.replay(5, 1, alternate, 3, snapshot)
    ]

    assert_failure(
      :replay_snapshot_equivalence,
      Checker.check_replay_snapshot_equivalence(history)
    )
  end

  test "idempotency fails when a retry commits again" do
    original = Operation.new(1, "p1", "c-1", :join, %{display_name: "Ada"})
    retry = Operation.new(2, "p1", "c-1", :join, %{display_name: "Ada"})

    history = [
      Record.complete(1, original, {:committed, 1}),
      Record.event(2, original, %{
        name: "participant_joined",
        base_revision: 0,
        revision: 1,
        payload: %{}
      }),
      Record.complete(3, retry, {:committed, 2}),
      Record.event(4, retry, %{
        name: "participant_joined",
        base_revision: 1,
        revision: 2,
        payload: %{}
      })
    ]

    assert_failure(:idempotency, Checker.check_idempotency(history))
  end

  defp valid_history do
    Generator.generate(9_321, operations: 18, participants: 2).history
  end

  defp update_first(history, kind, fun) do
    {before, [record | rest]} = Enum.split_while(history, &(&1.kind != kind))
    before ++ [fun.(record) | rest]
  end

  defp assert_failure(invariant, result) do
    assert {:error, %Failure{invariant: ^invariant}} = result
  end
end
