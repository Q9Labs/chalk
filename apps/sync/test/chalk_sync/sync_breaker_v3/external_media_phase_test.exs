defmodule ChalkSync.SyncBreakerV3.ExternalMediaPhaseTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncBreakerV3.ExternalMediaPhase

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  test "executes the complete deterministic external media schedule twice" do
    first = ExternalMediaPhase.run!(@database_url, 730_031)
    second = ExternalMediaPhase.run!(@database_url, 730_031)

    assert first["verdict"] == "pass"
    assert length(first["schedule"]) == 12
    assert Enum.all?(first["invariants"], fn {_name, holds?} -> holds? end)
    assert length(first["receipts"]) == 4

    assert first["observations"]["confirmation_crash_retry"] == %{
             "effect_count" => 1,
             "final_status" => "applied",
             "pending_after_crash" => true
           }

    assert first["observations"]["screen_race"]["second"] == "terminal_failure"

    assert first["observations"]["stale_observation"] == %{
             "cursor_after_newer_snapshot" => %{"incarnation" => 1, "sequence" => 2},
             "cursor_after_older_snapshot" => %{"incarnation" => 1, "sequence" => 2},
             "newer_projection_item_count" => 2,
             "older_snapshot_ignored" => true,
             "production_item_count_after_older_snapshot" => 2
           }

    assert first["observations"]["restart_reconciliation"] == %{
             "original_controller_stopped" => true,
             "production_projection_matches_provider_truth" => true,
             "production_publication_count" => 1,
             "provider_publication_count" => 1,
             "restarted_incarnation" => 2
           }

    assert first["observations"]["role_moderation"]["initial_role"] == "cohost"
    assert first["observations"]["role_moderation"]["final_role"] == "participant"
    assert first["observations"]["role_moderation"]["moderation_status"] == "applied"

    assert first == second
    refute inspect(first) =~ "#PID"

    refute inspect(first) =~
             ~r/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
  end
end
