defmodule ChalkSync.SyncBreakerV3.WireSdkPhaseTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncBreakerV3.WireSdkPhase

  test "proves the bounded v3 wire and production SDK schedule twice" do
    first = WireSdkPhase.run!(730_044)
    second = WireSdkPhase.run!(730_044)

    assert first["verdict"] == "pass"
    assert first["name"] == "wire_sdk"
    assert length(first["schedule"]) == 9
    assert length(first["evidence"]["wire"]["declarative_targets"]) == 5
    assert length(first["evidence"]["wire"]["invalid_shapes"]["results"]) == 6
    assert first["evidence"]["wire"]["invalid_shapes"]["all_decode_rejected"]
    assert first["evidence"]["sdk"]["forbidden_client_shapes"]["all_encoder_rejected"]

    assert first["evidence"]["sdk"]["forbidden_client_shapes"]["labels"] ==
             first["evidence"]["wire"]["invalid_shapes"]["labels"]

    assert first["evidence"]["sdk"]["ack_before_event"]["settled_after_event"]
    assert first["evidence"]["sdk"]["event_before_ack"]["settled_after_ack"]
    assert first["evidence"]["sdk"]["projection_gap_recovery"]["phase_after_gap"] == "connecting"

    assert first["evidence"]["sdk"]["restart_persisted_pending_target"]["replayed_frame_count"] ==
             1

    assert Enum.all?(first["invariants"], fn {_name, holds?} -> holds? end)
    assert first == second
    refute inspect(first) =~ "#PID<"

    refute inspect(first) =~
             ~r/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
  end
end
