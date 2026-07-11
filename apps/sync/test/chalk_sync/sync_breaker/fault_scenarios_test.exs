defmodule ChalkSync.SyncBreaker.FaultScenariosTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.SyncBreaker.FaultScenarios

  setup do
    previous = Application.fetch_env!(:chalk_sync, :stateholder)
    Application.put_env(:chalk_sync, :stateholder, Memory)
    on_exit(fn -> Application.put_env(:chalk_sync, :stateholder, previous) end)
  end

  test "detects the unknown commit acknowledgement defect" do
    result = FaultScenarios.commit_ambiguity(101)
    assert result.status == :fail
    assert result.invariant == :commit_acknowledgement
    assert result.evidence["authoritative_revision"] == 2
  end

  test "detects an orphan writer after a revision conflict" do
    result = FaultScenarios.writer_conflict_orphan(102)
    assert result.status == :fail
    assert result.invariant == :empty_writer_cleanup
    assert result.evidence["subscribers"] == 0
  end

  test "detects idempotency loss after bounded remembered-command eviction" do
    result = FaultScenarios.idempotency_eviction(103)
    assert result.status == :fail
    assert result.invariant == :idempotency_retention
  end

  test "detects unbounded fanout to a non-reading subscriber" do
    result = FaultScenarios.slow_subscriber(104, 300, 64)
    assert result.status == :fail
    assert result.invariant == :bounded_fanout
    assert result.evidence["message_queue_len"] > 64
  end

  test "falls back to a convergent snapshot beyond event retention" do
    result = FaultScenarios.retention_snapshot_fallback(105)
    assert result.status == :pass
    assert result.invariant == :retention_convergence
    assert result.evidence["mode"] == "snapshot"
    assert result.evidence["snapshot_matches"]
  end

  test "keeps a participant alive while another subscription remains" do
    result = FaultScenarios.multiple_subscriptions_lifecycle(106)
    assert result.status == :pass
    assert result.invariant == :subscription_lifecycle
    assert result.evidence["revision_before"] == result.evidence["revision_after_close"]
    assert result.evidence["remaining_subscribers"] == 1
  end
end
