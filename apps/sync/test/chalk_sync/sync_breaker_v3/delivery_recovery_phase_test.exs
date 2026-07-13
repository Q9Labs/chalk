defmodule ChalkSync.SyncBreakerV3.DeliveryRecoveryPhaseTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncBreakerV3.DeliveryRecoveryPhase

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  test "executes every deterministic delivery and recovery schedule" do
    result = DeliveryRecoveryPhase.run!(@database_url, 730_014)

    assert result["verdict"] == "pass"
    assert length(result["schedule"]) == 7
    assert length(result["observations"]) >= 7
    assert Enum.any?(result["observations"], &(&1["action"] == "drop"))
    assert Enum.any?(result["observations"], &String.starts_with?(&1["action"], "hold:"))
    assert Enum.any?(result["observations"], &(&1["action"] == "duplicate"))
    assert result["evidence"]["duplicate_delivery_tolerance"]["wire_event_count"] == 1
    assert result["evidence"]["dropped_hint_repair"]["converged"]

    assert result["evidence"]["held_released_live_frame"] == %{
             "wire_sources" => ["microphone", "camera"],
             "wire_sequences" => [2, 1],
             "release_order" => ["later", "earlier"]
           }
  end
end
