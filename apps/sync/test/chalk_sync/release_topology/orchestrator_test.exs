defmodule ChalkSync.ReleaseTopology.OrchestratorTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ReleaseTopology.Orchestrator

  @tag :tmp_dir
  test "dry run validates every planned transition without launching a command", %{
    tmp_dir: tmp_dir
  } do
    runner = fn _action -> raise "dry run must not launch commands" end

    assert {:ok, result} =
             Orchestrator.run(schedule(), output: tmp_dir, clock: clock(), runner: runner)

    assert result.verdict == :dry_run
    assert Enum.all?(result.transitions, &(&1["at"] == "2026-07-12T12:00:00Z"))
    assert Enum.all?(result.transitions, &(&1["monotonic_ms"] == 42))

    assert %{"execution_mode" => "dry_run", "verdict" => "dry_run"} =
             result.run_directory
             |> Path.join("manifest.json")
             |> File.read!()
             |> JSON.decode!()
  end

  @tag :tmp_dir
  test "requires two matching local execution confirmations before running commands", %{
    tmp_dir: tmp_dir
  } do
    runner = fn _action -> raise "the environment guard must run first" end

    assert {:error, message} =
             Orchestrator.run(schedule(),
               mode: :execute,
               output: tmp_dir,
               clock: clock(),
               runner: runner,
               runtime_environment: "staging"
             )

    assert message =~ "--confirm-environment local"
  end

  @tag :tmp_dir
  test "runs an event, seals sanitized evidence, and verifies the breaker", %{tmp_dir: tmp_dir} do
    runner = fn action ->
      output = action["expect"] || "raw-token-value-must-not-appear"
      {:ok, %{exit_code: 0, output: output <> "\n", duration_ms: 7}}
    end

    assert {:ok, result} =
             Orchestrator.run(schedule(),
               mode: :execute,
               output: tmp_dir,
               clock: clock(),
               runner: runner,
               confirm_environment: "local",
               runtime_environment: "local"
             )

    assert result.verdict == :pass

    assert Enum.any?(
             result.transitions,
             &(&1["phase"] == "cleanup" and &1["status"] == "completed")
           )

    assert Enum.any?(
             result.transitions,
             &(&1["phase"] == "breaker" and &1["status"] == "completed")
           )

    manifest_path = Path.join(result.run_directory, "manifest.json")
    manifest = manifest_path |> File.read!() |> JSON.decode!()
    transitions = result.run_directory |> Path.join("transitions.jsonl") |> File.read!()

    assert manifest["schedule"]["breaker"]["argv_sha256"] =~ ~r/\A[0-9a-f]{64}\z/

    inject_reference = manifest["schedule"]["events"] |> hd() |> Map.fetch!("inject")
    assert inject_reference["argv_sha256"] =~ ~r/\A[0-9a-f]{64}\z/
    refute File.read!(manifest_path) =~ "raw-token-value-must-not-appear"
    refute transitions =~ "raw-token-value-must-not-appear"
    assert {:ok, %{mode: 0o100444}} = File.stat(manifest_path)
  end

  @tag :tmp_dir
  test "fails ambiguous observation, cleans up the active event, and skips later mutations", %{
    tmp_dir: tmp_dir
  } do
    runner = fn action ->
      output =
        if List.last(action["argv"]) == "observe",
          do: "not_confirmed",
          else: action["expect"] || "pass"

      {:ok, %{exit_code: 0, output: output, duration_ms: 7}}
    end

    schedule = update_in(schedule(), ["events"], &(&1 ++ [event("telemetry_export")]))

    assert {:ok, result} =
             Orchestrator.run(schedule,
               mode: :execute,
               output: tmp_dir,
               clock: clock(),
               runner: runner,
               confirm_environment: "local",
               runtime_environment: "local"
             )

    assert result.verdict == :fail
    assert result.error == "event sync_replacement did not produce complete evidence"

    assert Enum.any?(
             result.transitions,
             &(&1["event_id"] == "sync_replacement" and &1["phase"] == "cleanup" and
                 &1["status"] == "completed")
           )

    assert Enum.any?(
             result.transitions,
             &(&1["event_id"] == "telemetry_export" and &1["phase"] == "event" and
                 &1["status"] == "skipped")
           )

    refute Enum.any?(
             result.transitions,
             &(&1["event_id"] == "telemetry_export" and &1["phase"] == "inject" and
                 &1["status"] == "completed")
           )
  end

  @tag :tmp_dir
  test "fails a topology mismatch before it launches an event mutation", %{tmp_dir: tmp_dir} do
    runner = fn action ->
      output =
        if List.last(action["argv"]) == "topology",
          do: "not_confirmed",
          else: action["expect"] || "pass"

      {:ok, %{exit_code: 0, output: output, duration_ms: 7}}
    end

    assert {:ok, result} =
             Orchestrator.run(schedule(),
               mode: :execute,
               output: tmp_dir,
               clock: clock(),
               runner: runner,
               confirm_environment: "local",
               runtime_environment: "local"
             )

    assert result.verdict == :fail
    assert result.error == "topology check did not confirm the declared release"

    assert Enum.any?(
             result.transitions,
             &(&1["phase"] == "topology_check" and &1["status"] == "ambiguous")
           )

    refute Enum.any?(
             result.transitions,
             &(&1["event_id"] == "sync_replacement" and &1["phase"] == "inject" and
                 &1["status"] == "completed")
           )
  end

  defp schedule do
    %{
      "schema_version" => 1,
      "name" => "local_topology",
      "environment" => "local",
      "topology" => %{
        "release_artifact_sha256" => String.duplicate("a", 64),
        "configuration_sha256" => String.duplicate("b", 64),
        "topology_sha256" => String.duplicate("c", 64),
        "protocol_version" => 3
      },
      "topology_check" => action("topology", "confirmed"),
      "breaker" => %{"argv" => ["breaker_control"], "timeout_ms" => 1_000},
      "events" => [event("sync_replacement")]
    }
  end

  defp event(id) do
    %{
      "id" => id,
      "trigger" => "accepted_work",
      "duration_ms" => 100,
      "expected_readiness" => "draining_then_ready",
      "expected_client_outcome" => "reconnect_and_converge",
      "recovery_deadline_ms" => 5_000,
      "invariants" => ["stable_idempotency", "replica_convergence"],
      "trigger_check" => action("trigger", "confirmed"),
      "inject" => action("inject", "injected"),
      "observe" => action("observe", "confirmed"),
      "telemetry" => action("telemetry", "available"),
      "cleanup" => action("cleanup", "cleaned")
    }
  end

  defp action(name, expect),
    do: %{"argv" => ["local_control", name], "timeout_ms" => 1_000, "expect" => expect}

  defp clock do
    %{
      wall_now: fn -> ~U[2026-07-12 12:00:00Z] end,
      monotonic_ms: fn -> 42 end
    }
  end
end
