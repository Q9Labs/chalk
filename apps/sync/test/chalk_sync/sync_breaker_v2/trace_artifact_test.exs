defmodule ChalkSync.SyncBreakerV2.TraceArtifactTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreakerV2.Config
  alias ChalkSync.SyncBreakerV2.Replay
  alias ChalkSync.SyncBreakerV2.TraceArtifact

  @tag :tmp_dir
  test "writes the complete machine-readable failure artifact with JSON nulls", %{
    tmp_dir: tmp_dir
  } do
    config = Config.new!(output: tmp_dir)
    artifact = TraceArtifact.create(config)

    result = %{
      verdict: "FAIL",
      invariants: [
        %{"name" => "exact_revision_order", "status" => "FAIL", "detail" => "revision 4"}
      ],
      error: "revision 4",
      trace: [%{"kind" => "decision", "event_id" => nil, "accepted" => true}],
      metrics: %{"trace_records" => 1}
    }

    assert :ok = TraceArtifact.write(artifact, config, result)

    assert {:ok, [%{"record" => %{"event_id" => nil, "accepted" => true}}]} =
             artifact.directory
             |> Path.join("trace.jsonl")
             |> TraceArtifact.read_trace()

    assert File.read!(Path.join(artifact.directory, "failure.md")) =~ "exact_revision_order"
    assert {:error, :missing_final_head} = Replay.verify(artifact.directory)

    for name <- ["manifest.json", "verdict.json", "server.log", "client.log", "postgres.log"] do
      assert File.exists?(Path.join(artifact.directory, name))
    end

    manifest =
      artifact.directory
      |> Path.join("manifest.json")
      |> File.read!()
      |> JSON.decode!()

    assert is_boolean(manifest["dirty_worktree"])
    assert manifest["dirty_status_sha256"] =~ ~r/^[0-9a-f]{64}$/
  end
end
