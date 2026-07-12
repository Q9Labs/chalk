defmodule ChalkSync.SyncBreakerV2.CampaignTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncBreakerV2.Campaign
  alias ChalkSync.SyncBreakerV2.Replay

  @tag :tmp_dir
  test "runs a deterministic local Memory smoke campaign and replays its trace", %{
    tmp_dir: tmp_dir
  } do
    result =
      Campaign.run(
        seed: 20_260_712,
        sessions: 1,
        participants: 2,
        sockets: 2,
        subscriptions: 1,
        commands: 12,
        command_rate: 10_000,
        burst: 3,
        concurrency: 1,
        cursor_age: 0,
        client_read_delay_ms: 0,
        network_interrupt_every: 0,
        duration_ms: 0,
        output: tmp_dir
      )

    assert result.verdict == :pass
    assert {:ok, %{sessions: 1}} = Replay.verify(result.run_directory)

    assert %{"verdict" => "PASS", "invariants" => invariants} =
             result.run_directory
             |> Path.join("verdict.json")
             |> File.read!()
             |> JSON.decode!()

    assert Enum.all?(invariants, &(&1["status"] == "PASS"))

    assert File.exists?(Path.join(result.run_directory, "manifest.json"))
    assert File.exists?(Path.join(result.run_directory, "metrics.json"))
    assert File.exists?(Path.join(result.run_directory, "reproducer.json"))
    assert File.exists?(Path.join(result.run_directory, "failure.md"))

    assert %{"dimensions" => %{"duration_ms" => 0, "operation_count" => 12}} =
             result.run_directory
             |> Path.join("manifest.json")
             |> File.read!()
             |> JSON.decode!()
  end
end
