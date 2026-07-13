defmodule ChalkSync.ReleaseTopology.ScheduleTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ReleaseTopology.Schedule

  test "validates the versioned public-safe schedule contract" do
    assert {:ok, valid_schedule} = Schedule.validate(schedule())
    assert valid_schedule["schema_version"] == 1
    assert valid_schedule["environment"] == "local"
    assert Schedule.digest(valid_schedule) =~ ~r/\A[0-9a-f]{64}\z/

    assert %{
             "breaker" => %{"argv_sha256" => breaker_digest},
             "events" => [%{"inject" => %{"argv_sha256" => inject_digest}}]
           } = Schedule.sanitized(valid_schedule)

    assert breaker_digest =~ ~r/\A[0-9a-f]{64}\z/
    assert inject_digest =~ ~r/\A[0-9a-f]{64}\z/
  end

  test "rejects production, unknown fields, and credential-bearing command arguments" do
    assert {:error, "environment must be one of local, staging"} =
             schedule() |> Map.put("environment", "production") |> Schedule.validate()

    assert {:error, "schedule has unsupported or missing fields"} =
             schedule() |> Map.put("provider_id", "private") |> Schedule.validate()

    schedule =
      update_in(schedule(), ["events", Access.at(0), "inject", "argv"], fn _argv ->
        ["local_control", "--token"]
      end)

    assert {:error, reason} = Schedule.validate(schedule)
    assert reason =~ "credentials, tokens, URLs, or secret references"
  end

  test "rejects ambiguous event declarations and unsupported action markers" do
    duplicate = update_in(schedule(), ["events"], &[event() | &1])

    assert {:error, "event id is duplicated: sync_replacement"} = Schedule.validate(duplicate)

    invalid_marker =
      update_in(
        schedule(),
        ["events", Access.at(0), "observe"],
        &Map.put(&1, "expect", "available")
      )

    assert {:error, "events[1].observe.expect must equal \"confirmed\""} =
             Schedule.validate(invalid_marker)
  end

  test "publishes a parseable schema whose version matches the runtime validator" do
    schema_path =
      Path.expand("../../../docs/release-topology-failure-schedule-v1.schema.json", __DIR__)

    schema = schema_path |> File.read!() |> JSON.decode!()

    assert schema["properties"]["schema_version"]["const"] == Schedule.schema_version()
    assert schema["properties"]["environment"]["enum"] == ["local", "staging"]
  end

  test "loads the public dry-run fixture" do
    fixture_path = Path.expand("../../fixtures/release_topology/local_schedule_v1.json", __DIR__)

    assert {:ok, %{"name" => "local_topology", "environment" => "local"}} =
             Schedule.load(fixture_path)
  end

  test "rejects an oversized schedule before decoding it" do
    path =
      Path.join(System.tmp_dir!(), "chalk-oversized-schedule-#{System.unique_integer()}.json")

    File.write!(path, String.duplicate("x", 262_145))
    on_exit(fn -> File.rm(path) end)

    assert {:error, "could not load schedule: schedule exceeds 262144 bytes"} =
             Schedule.load(path)
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
      "events" => [event()]
    }
  end

  defp event do
    %{
      "id" => "sync_replacement",
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
end
