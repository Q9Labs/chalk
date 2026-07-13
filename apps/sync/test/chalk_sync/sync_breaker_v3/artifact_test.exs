defmodule ChalkSync.SyncBreakerV3.ArtifactTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreakerV3.Artifact

  test "rejects a corrupted bounded artifact" do
    path =
      Path.join(
        System.tmp_dir!(),
        "chalk-sync-breaker-v3-corrupt-#{System.unique_integer()}.json"
      )

    on_exit(fn -> File.rm(path) end)
    Artifact.write!(path, %{"seed" => 1, "schedule" => []})
    artifact = path |> File.read!() |> JSON.decode!() |> put_in(["payload", "seed"], 2)
    File.write!(path, JSON.encode!(artifact))

    assert_raise ArgumentError, ~r/corrupt/, fn -> Artifact.read!(path) end
  end

  test "rejects an artifact larger than one MiB" do
    path =
      Path.join(
        System.tmp_dir!(),
        "chalk-sync-breaker-v3-oversize-#{System.unique_integer()}.json"
      )

    on_exit(fn -> File.rm(path) end)

    assert_raise ArgumentError, ~r/1 MiB/, fn ->
      Artifact.write!(path, %{"evidence" => String.duplicate("x", 1_048_576)})
    end
  end

  test "semantic projection excludes runtime and environment identities" do
    campaign = %{
      "seed" => 7,
      "git_revision" => "revision-a",
      "runtime_ms" => 10,
      "contract_version" => 3,
      "config" => %{"postgres_major" => 18},
      "phase_order" => ["durable"],
      "phases" => [%{"name" => "durable", "verdict" => "pass"}],
      "aggregate" => %{"receipts" => []},
      "verdict" => "pass"
    }

    projection = Artifact.semantic_projection(campaign)

    refute Map.has_key?(projection, "seed")
    refute Map.has_key?(projection, "git_revision")
    refute Map.has_key?(projection, "runtime_ms")
    assert projection["phase_order"] == ["durable"]
  end
end
