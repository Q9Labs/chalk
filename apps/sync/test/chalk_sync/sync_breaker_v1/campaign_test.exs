defmodule ChalkSync.SyncBreakerV1.CampaignTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncBreakerV1.Campaign
  alias ChalkSync.SyncBreakerV1.Verdict

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  test "runs every real seeded phase and reproduces the complete semantic artifact" do
    first = Campaign.run!(@database_url, 730_013)
    second = Campaign.run!(@database_url, 730_013)

    assert first["verdict"] == "pass"
    assert first["config"]["postgres_major"] == 18

    assert first["phase_order"] ==
             ~w(durable_lifecycle_reference external-operation-live-media delivery_recovery wire_sdk)

    assert Enum.all?(first["phases"], &(&1["verdict"] == "pass"))
    assert first["aggregate"]["bounds"]["schedule_steps"] == 36

    [durable, external, delivery, wire] = first["phases"]

    assert length(delivery["schedule"]) == 7
    assert length(delivery["observations"]) >= 7
    assert Enum.any?(delivery["observations"], &(&1["action"] == "drop"))
    assert Enum.any?(delivery["observations"], &String.starts_with?(&1["action"], "hold:"))
    assert Enum.any?(delivery["observations"], &(&1["action"] == "duplicate"))
    assert delivery["evidence"]["duplicate_delivery_tolerance"]["wire_event_count"] == 1
    assert delivery["evidence"]["dropped_hint_repair"]["converged"]

    assert delivery["evidence"]["held_released_live_frame"] == %{
             "wire_sources" => ["microphone", "camera"],
             "wire_sequences" => [2, 1],
             "release_order" => ["later", "earlier"]
           }

    assert durable["invariants"]["all_schedules_executed"]
    assert durable["bounds"]["schedule_steps"] == 8
    assert Enum.map(durable["observations"], & &1["schedule"]) == durable["schedule"]
    assert length(durable["digest_sequence"]) == durable["folded_snapshot"]["control_revision"]
    assert Enum.all?(durable["digest_sequence"], &(byte_size(&1["digest"]) == 64))

    [admission_race] = Enum.filter(durable["observations"], &Map.has_key?(&1, "order"))
    assert admission_race["order"] == ["phase_admission_deny", "phase_admission_expiry"]
    assert admission_race["second_waited_for_authority_lock"]
    refute Map.has_key?(durable, "runtime_ms")

    assert Enum.all?(Map.values(external["invariants"]), & &1)
    assert length(external["receipts"]) == 4

    assert external["observations"]["confirmation_crash_retry"] == %{
             "effect_count" => 1,
             "final_status" => "applied",
             "pending_after_crash" => true
           }

    assert external["observations"]["screen_race"]["second"] == "terminal_failure"

    assert external["observations"]["stale_observation"] == %{
             "cursor_after_newer_snapshot" => %{"incarnation" => 1, "sequence" => 2},
             "cursor_after_older_snapshot" => %{"incarnation" => 1, "sequence" => 2},
             "newer_projection_item_count" => 2,
             "older_snapshot_ignored" => true,
             "production_item_count_after_older_snapshot" => 2
           }

    assert external["observations"]["restart_reconciliation"] == %{
             "original_controller_stopped" => true,
             "production_projection_matches_provider_truth" => true,
             "production_publication_count" => 1,
             "provider_publication_count" => 1,
             "restarted_incarnation" => 2
           }

    assert external["observations"]["role_moderation"]["assigned_role"] == "collaborator"
    assert external["observations"]["role_moderation"]["final_role"] == "observer"
    assert external["observations"]["role_moderation"]["moderation_status"] == "applied"

    assert length(wire["schedule"]) == 9
    assert length(wire["evidence"]["wire"]["declarative_targets"]) == 4
    assert length(wire["evidence"]["wire"]["invalid_shapes"]["results"]) == 6
    assert wire["evidence"]["wire"]["invalid_shapes"]["all_decode_rejected"]
    assert wire["evidence"]["sdk"]["forbidden_client_shapes"]["all_encoder_rejected"]

    assert wire["evidence"]["sdk"]["forbidden_client_shapes"]["labels"] ==
             wire["evidence"]["wire"]["invalid_shapes"]["labels"]

    assert wire["evidence"]["sdk"]["ack_before_event"]["settled_after_event"]
    assert wire["evidence"]["sdk"]["event_before_ack"]["settled_after_ack"]
    assert wire["evidence"]["sdk"]["projection_gap_recovery"]["phase_after_gap"] == "connecting"

    assert wire["evidence"]["sdk"]["restart_persisted_pending_target"]["replayed_frame_count"] ==
             1

    assert Enum.all?(Map.values(wire["invariants"]), & &1)

    assert Verdict.from_invariants(%{"receipt_stable" => true}) == "pass"
    assert Verdict.from_invariants(%{"receipt_stable" => false}) == "fail"
    assert Verdict.from_invariants(%{"receipt_stable" => "true"}) == "fail"
    assert Verdict.from_invariants(%{}) == "fail"

    assert Verdict.from_invariants(
             %{"receipt_stable" => true},
             [%{"verdict" => "fail"}]
           ) == "fail"

    refute Verdict.pass?(%{"verdict" => "fail"})
    refute Verdict.pass?(%{})
    assert first == second

    refute inspect(durable) =~ "#PID<"
    refute inspect(external) =~ "#PID"
    refute inspect(wire) =~ "#PID<"

    refute inspect(external) =~
             ~r/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

    refute inspect(wire) =~
             ~r/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
  end
end
