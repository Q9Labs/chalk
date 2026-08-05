defmodule ChalkSync.SyncBreakerV1.OracleTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreakerV1.Oracle

  test "folds the v1 event set and produces a stable digest" do
    facts = [
      {"participant_joined",
       %{
         "participant_id" => "owner",
         "display_name" => "Owner",
         "role" => "owner",
         "admission_revision" => 1
       }},
      {"participant_joined",
       %{
         "participant_id" => "guest",
         "display_name" => "Guest",
         "role" => "observer",
         "admission_revision" => 2
       }},
      {"hand_raised", %{"participant_id" => "guest"}},
      {"hand_lowered", %{"participant_id" => "guest"}},
      {"participant_display_name_changed",
       %{"participant_id" => "guest", "display_name" => "Renamed"}},
      {"admission_policy_changed", %{"policy" => "knock"}},
      {"deadline_changed", %{"deadline_at_ms" => 2, "deadline_generation" => 2}},
      {"admission_requested", admission_payload("request-1", "waiting-1")},
      {"admission_denied", %{"admission_request_id" => "request-1"}},
      {"participant_microphone_stopped", %{"participant_id" => "guest"}},
      {"participant_camera_stopped", %{"participant_id" => "guest"}},
      {"participant_screen_share_stopped", %{"participant_id" => "guest"}},
      {"recording_status_changed",
       %{"recording_id" => "recording-1", "status" => "starting", "failure_code" => nil}},
      {"role_assigned", %{"participant_id" => "guest", "role" => "collaborator"}},
      {"participant_left", %{"participant_id" => "guest", "reason" => "left"}},
      {"episode_ended", %{"reason" => "ended_by_participant"}}
    ]

    events =
      facts
      |> Enum.with_index(1)
      |> Enum.map(fn {{name, payload}, revision} ->
        %{name: name, base_revision: revision - 1, revision: revision, payload: payload}
      end)

    state = Oracle.fold("episode", %{}, events)

    assert Enum.all?(facts, fn {name, _payload} -> name in Oracle.event_names() end)
    assert state.revision == length(events)
    assert Oracle.snapshot(state)["status"] == "ended"
    assert byte_size(Oracle.digest(state)) == 32
  end

  defp admission_payload(request_id, participant_id) do
    %{
      "admission_request_id" => request_id,
      "participant_id" => participant_id,
      "display_name" => "Waiting",
      "role" => "observer",
      "expires_at_ms" => 2
    }
  end
end
