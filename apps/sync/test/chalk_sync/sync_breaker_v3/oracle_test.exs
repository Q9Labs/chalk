defmodule ChalkSync.SyncBreakerV3.OracleTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreakerV3.Oracle

  test "folds every frozen v3 event without consulting the production reducer" do
    participants = [
      join("host", "Host", "host", ~w(host cohost participant)),
      join("guest-1", "Guest One", "participant", ~w(host cohost participant)),
      join("guest-2", "Guest Two", "participant", ~w(host cohost participant))
    ]

    requests = [request("request-1", "waiting-1"), request("request-2", "waiting-2")]

    facts =
      participants ++
        [
          {"hand_raised", %{"participant_session_id" => "guest-1"}},
          {"hand_lowered", %{"participant_session_id" => "guest-1"}},
          {"participant_display_name_changed",
           %{"participant_session_id" => "guest-1", "display_name" => "Renamed"}},
          {"admission_policy_changed", %{"policy" => "approval"}},
          {"deadline_changed", %{"deadline_at_ms" => 2, "deadline_generation" => 2}}
        ] ++
        requests ++
        [
          {"admission_denied", %{"admission_request_id" => "request-1"}},
          {"admission_expired", %{"admission_request_id" => "request-2"}},
          {"participant_microphone_stopped", %{"participant_session_id" => "guest-1"}},
          {"participant_camera_stopped", %{"participant_session_id" => "guest-1"}},
          {"participant_screen_share_stopped", %{"participant_session_id" => "guest-1"}},
          {"recording_status_changed",
           %{"recording_id" => "recording-1", "status" => "starting", "failure_code" => nil}},
          {"participant_role_changed",
           %{"participant_session_id" => "guest-2", "role" => "cohost"}},
          {"host_transferred",
           %{
             "previous_host_participant_session_id" => "host",
             "new_host_participant_session_id" => "guest-1"
           }},
          {"participant_left", %{"participant_session_id" => "guest-2", "reason" => "left"}},
          {"host_left_and_transferred",
           %{
             "departing_participant_session_id" => "guest-1",
             "successor_participant_session_id" => "host"
           }},
          {"session_ended", %{"reason" => "ended_by_participant"}}
        ]

    events =
      facts
      |> Enum.with_index(1)
      |> Enum.map(fn {{name, payload}, revision} ->
        %{name: name, base_revision: revision - 1, revision: revision, payload: payload}
      end)

    state = Oracle.fold("session", %{}, events)

    assert Enum.sort(Enum.uniq(Enum.map(facts, &elem(&1, 0)))) == Enum.sort(Oracle.event_names())
    assert state.revision == length(events)
    assert Oracle.snapshot(state)["status"] == "ended"
    assert byte_size(Oracle.digest(state)) == 32
  end

  test "source remains mechanically independent from Sessions.Reducer" do
    source = File.read!(Path.expand("../../support/sync_breaker_v3/oracle.ex", __DIR__))
    refute source =~ "Sessions.Reducer"
    refute source =~ "Reducer."
  end

  defp join(id, display_name, role, eligible_roles) do
    {"participant_joined",
     %{
       "participant_session_id" => id,
       "display_name" => display_name,
       "role" => role,
       "eligible_roles" => eligible_roles,
       "admission_revision" => 1
     }}
  end

  defp request(id, participant_id) do
    {"admission_requested",
     %{
       "admission_request_id" => id,
       "participant_session_id" => participant_id,
       "display_name" => "Waiting",
       "initial_role" => "participant",
       "eligible_roles" => ["participant"],
       "expires_at_ms" => 2
     }}
  end
end
