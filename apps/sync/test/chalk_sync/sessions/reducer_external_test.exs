defmodule ChalkSync.Sessions.ReducerExternalTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Sessions.Reducer

  test "admission request round-trips, rejects duplicates, and is consumed by matching admission" do
    state = host_state()
    payload = admission_payload("request-a", "guest-a")

    assert {:ok, requested, state} =
             Reducer.apply_lifecycle(state, :admission_requested, payload)

    assert requested.name == "admission_requested"
    assert state.admission_requests["request-a"] == payload

    assert Reducer.apply_lifecycle(state, :admission_requested, payload) ==
             {:error, :invalid_transition}

    snapshot = Reducer.snapshot(state)
    assert {:ok, ^state} = Reducer.from_snapshot("session-a", snapshot)

    assert {:ok, joined, admitted} =
             Reducer.apply_lifecycle(state, :participant_joined, %{
               "participant_session_id" => "guest-a",
               "display_name" => "Grace",
               "role" => "participant",
               "eligible_roles" => ["participant", "cohost"],
               "admission_revision" => state.revision + 1
             })

    assert joined.name == "participant_joined"
    assert admitted.admission_requests == %{}
    assert admitted.participants["guest-a"].display_name == "Grace"
  end

  test "admission denial removes one exact pending request and cannot win twice" do
    state = host_state()

    {:ok, _event, state} =
      Reducer.apply_lifecycle(
        state,
        :admission_requested,
        admission_payload("request-a", "guest-a")
      )

    assert {:ok, event, denied} =
             Reducer.apply_external(state, :admission_denied, %{
               "admission_request_id" => "request-a"
             })

    assert event.name == "admission_denied"
    assert denied.admission_requests == %{}

    assert Reducer.apply_external(denied, :admission_denied, %{
             "admission_request_id" => "request-a"
           }) == {:error, :invalid_transition}
  end

  test "admission expiry is an explicit exact-next fact, not a wall-clock fold" do
    {:ok, _requested, state} =
      Reducer.apply_lifecycle(
        Reducer.new("session-a"),
        :admission_requested,
        admission_payload("request-expiry", "guest-a")
      )

    assert {:ok, event, expired} =
             Reducer.apply_external(state, :admission_expired, %{
               "admission_request_id" => "request-expiry"
             })

    assert event.name == "admission_expired"
    assert expired.admission_requests == %{}

    assert {:error, :invalid_transition} =
             Reducer.apply_external(expired, :admission_expired, %{
               "admission_request_id" => "request-expiry"
             })
  end

  test "moderation confirmation facts advance revision without inventing media state" do
    state = host_state()

    final =
      Enum.reduce(
        ~w(participant_microphone_stopped participant_camera_stopped participant_screen_share_stopped),
        state,
        fn name, current ->
          assert {:ok, event, next} =
                   Reducer.apply_external(current, name, %{"participant_session_id" => "host"})

          assert event.revision == current.revision + 1
          assert next.participants == current.participants
          next
        end
      )

    assert final.revision == state.revision + 3
  end

  test "recording state is keyed and enforces the exact transition graph" do
    state = host_state()
    recording_id = "recording-a"

    state = recording_transition(state, recording_id, "starting", nil)
    state = recording_transition(state, recording_id, "recording", nil)

    assert Reducer.apply_external(
             state,
             :recording_status_changed,
             recording_payload("other", "stopping", nil)
           ) ==
             {:error, :invalid_transition}

    state = recording_transition(state, recording_id, "stopping", nil)
    state = recording_transition(state, recording_id, "stopped", nil)
    state = recording_transition(state, "recording-b", "starting", nil)
    failed = recording_transition(state, "recording-b", "failed", "provider_rejected")

    assert failed.recording == recording_payload("recording-b", "failed", "provider_rejected")

    assert Reducer.apply_external(
             state,
             :recording_status_changed,
             recording_payload("recording-b", "failed", nil)
           ) ==
             {:error, :invalid_transition}
  end

  test "deadline changes require an exact-next generation and positive deadline" do
    state = host_state()

    assert {:ok, event, changed} =
             Reducer.apply_external(state, :deadline_changed, %{
               "deadline_at_ms" => 9_999,
               "deadline_generation" => 2
             })

    assert event.name == "deadline_changed"
    assert {changed.deadline_at_ms, changed.deadline_generation} == {9_999, 2}

    assert Reducer.apply_external(changed, :deadline_changed, %{
             "deadline_at_ms" => 10_000,
             "deadline_generation" => 4
           }) == {:error, :invalid_transition}
  end

  test "external leave and end facts are unavailable through lifecycle origin" do
    state = host_state() |> join_participant("guest-a")

    assert Reducer.apply_lifecycle(state, :participant_left, %{
             "participant_session_id" => "guest-a"
           }) == {:error, :invalid_lifecycle_intent}

    assert {:change, %{name: "participant_left"}, state} =
             Reducer.decide_external(state, :participant_leave, %{
               "participant_session_id" => "guest-a"
             })

    assert {:ok, %{name: "session_ended"}, ended} =
             Reducer.apply_external(state, :session_ended, %{
               "reason" => "tenant_recovery"
             })

    assert ended.status == "ended"
    assert ended.participants == %{}
    assert ended.recording == nil
  end

  test "snapshot rejects projected capabilities that differ from immutable role mapping" do
    snapshot = Reducer.snapshot(host_state())

    corrupted =
      update_in(snapshot["participants"], fn [host] ->
        [%{host | "capabilities" => ["raiseHand"]}]
      end)

    assert Reducer.from_snapshot("session-a", corrupted) == {:error, :invalid_snapshot}
  end

  defp host_state do
    Reducer.new("session-a")
    |> join("host", "Ada", "host", ["host", "cohost", "participant"])
  end

  defp join_participant(state, id),
    do: join(state, id, "Grace", "participant", ["participant"])

  defp join(state, id, name, role, eligible_roles) do
    {:ok, _event, next} =
      Reducer.apply_lifecycle(state, :participant_joined, %{
        "participant_session_id" => id,
        "display_name" => name,
        "role" => role,
        "eligible_roles" => eligible_roles,
        "admission_revision" => state.revision + 1
      })

    next
  end

  defp admission_payload(request_id, participant_id) do
    %{
      "admission_request_id" => request_id,
      "participant_session_id" => participant_id,
      "display_name" => "Grace",
      "initial_role" => "participant",
      "eligible_roles" => ["participant", "cohost"],
      "expires_at_ms" => 9_999
    }
  end

  defp recording_transition(state, recording_id, status, failure_code) do
    assert {:ok, _event, next} =
             Reducer.apply_external(
               state,
               :recording_status_changed,
               recording_payload(recording_id, status, failure_code)
             )

    next
  end

  defp recording_payload(recording_id, status, failure_code),
    do: %{
      "recording_id" => recording_id,
      "status" => status,
      "failure_code" => failure_code
    }
end
