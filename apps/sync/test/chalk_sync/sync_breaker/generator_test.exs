defmodule ChalkSync.SyncBreaker.GeneratorTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreaker.Checker
  alias ChalkSync.SyncBreaker.Generator
  alias ChalkSync.SyncBreaker.History.Record

  test "seeded scenarios contain replayable operations and histories" do
    scenario = Generator.generate(81_223, operations: 16, participants: 2)

    assert scenario == Generator.generate(81_223, operations: 16, participants: 2)
    assert length(scenario.operations) == 16
    assert :ok = Checker.check(scenario.history)
    assert %Record{kind: :snapshot, snapshot: snapshot} = Enum.at(scenario.history, -2)
    assert snapshot == scenario.snapshot
    assert %Record{kind: :replay, cursor: 0, snapshot: ^snapshot} = List.last(scenario.history)
  end
end
