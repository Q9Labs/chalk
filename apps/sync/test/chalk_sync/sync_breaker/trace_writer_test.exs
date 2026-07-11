defmodule ChalkSync.SyncBreaker.TraceWriterTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreaker.Generator
  alias ChalkSync.SyncBreaker.TraceWriter

  test "writes a JSONL replay artifact in the caller supplied directory" do
    directory =
      Path.join(System.tmp_dir!(), "chalk-sync-breaker-#{System.unique_integer([:positive])}")

    on_exit(fn -> File.rm_rf(directory) end)

    scenario = Generator.generate(37, operations: 8, participants: 2)

    assert {:ok, path} = TraceWriter.write(directory, scenario, name: "counterexample.jsonl")
    assert path == Path.join(directory, "counterexample.jsonl")
    assert {:ok, records} = TraceWriter.read(path)
    assert %{"kind" => "manifest", "seed" => 37} = hd(records)
    assert length(records) == 1 + length(scenario.operations) + length(scenario.history)

    snapshot_record =
      Enum.find(records, &match?(%{"kind" => "history", "record" => %{"kind" => "snapshot"}}, &1))

    refute Map.has_key?(snapshot_record["record"], "event")
  end

  test "preserves booleans and nulls in replay artifacts" do
    directory =
      Path.join(System.tmp_dir!(), "chalk-sync-breaker-#{System.unique_integer([:positive])}")

    on_exit(fn -> File.rm_rf(directory) end)

    artifact = %{
      seed: 41,
      operations: [%{"enabled" => true, "optional" => nil}],
      history: [%{"snapshot" => %{"hand_raised" => false}}]
    }

    assert {:ok, path} = TraceWriter.write(directory, artifact, name: "types.jsonl")
    assert {:ok, [_manifest, operation, history]} = TraceWriter.read(path)
    assert operation["operation"] == %{"enabled" => true, "optional" => nil}
    assert history["record"] == %{"snapshot" => %{"hand_raised" => false}}
  end
end
