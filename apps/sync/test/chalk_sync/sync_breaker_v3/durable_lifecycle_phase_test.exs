defmodule ChalkSync.SyncBreakerV3.DurableLifecyclePhaseTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncBreakerV3.DurableLifecyclePhase

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  test "executes every durable and lifecycle schedule against PostgreSQL" do
    result = DurableLifecyclePhase.run!(@database_url, 730_019)
    repeated = DurableLifecyclePhase.run!(@database_url, 730_019)

    assert result["verdict"] == "pass"
    assert result["invariants"]["all_schedules_executed"]
    assert result["bounds"]["schedule_steps"] == 9
    assert Enum.map(result["observations"], & &1["schedule"]) == result["schedule"]
    assert length(result["digest_sequence"]) == result["folded_snapshot"]["control_revision"]
    assert Enum.all?(result["digest_sequence"], &(byte_size(&1["digest"]) == 64))

    [host_race, admission_race] =
      Enum.filter(result["observations"], &Map.has_key?(&1, "order"))

    assert host_race["order"] == ["phase_host_transfer1", "phase_host_leave_001"]
    assert admission_race["order"] == ["phase_admission_deny", "phase_admission_expiry"]
    assert host_race["second_waited_for_authority_lock"]
    assert admission_race["second_waited_for_authority_lock"]
    refute Map.has_key?(result, "runtime_ms")
    refute inspect(result) =~ "#PID<"
    assert repeated == result
  end
end
