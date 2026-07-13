defmodule ChalkSync.SyncBreakerV3.Oracle do
  @moduledoc false

  alias ChalkSync.CanonicalJSON

  @digest_prefix "chalk-sync-state-v3"
  @schema_version 3
  @capabilities ~w(publishAudio publishVideo publishScreen subscribe raiseHand renameSelf manageAdmission promoteDemote transferHost muteOthers stopVideoOthers stopScreenOthers requestMediaOthers removeParticipant manageRecording endMeeting)
  @default_role_capabilities %{
    "host" => @capabilities,
    "cohost" =>
      ~w(publishAudio publishVideo publishScreen subscribe raiseHand renameSelf manageAdmission promoteDemote muteOthers stopVideoOthers stopScreenOthers requestMediaOthers removeParticipant manageRecording),
    "participant" => ~w(publishAudio publishVideo publishScreen subscribe raiseHand renameSelf)
  }
  @event_names ~w(participant_joined participant_left host_left_and_transferred hand_raised hand_lowered participant_display_name_changed admission_policy_changed deadline_changed admission_requested admission_denied admission_expired participant_microphone_stopped participant_camera_stopped participant_screen_share_stopped recording_status_changed participant_role_changed host_transferred session_ended)

  def event_names, do: @event_names

  def fold(session_id, policy, events) do
    Enum.reduce(events, initial(session_id, policy), &advance/2)
  end

  def verify!(session_id, policy, events, recovery) do
    state = fold(session_id, policy, events)
    snapshot = snapshot(state)
    digest = digest(state)

    verified_state =
      Enum.reduce(events, initial(session_id, policy), fn event, current ->
        next = advance(event, current)

        unless digest(next) == field(event, :resulting_state_digest) do
          raise "independent digest chain diverged from PostgreSQL events"
        end

        next
      end)

    unless verified_state == state and state.revision == recovery.head.revision and
             digest == recovery.head.digest and
             snapshot == recovery.snapshot and
             eligibility(state) == eligibility(recovery.snapshot) do
      raise "independent fold diverged from PostgreSQL authority"
    end

    Map.merge(state, %{digest: digest, snapshot: snapshot})
  end

  def snapshot(state) do
    %{
      "control_revision" => state.revision,
      "state_schema_version" => @schema_version,
      "status" => state.status,
      "admission_policy" => state.admission_policy,
      "host_exit_policy" => state.host_exit_policy,
      "host_participant_session_id" => state.host_participant_session_id,
      "deadline_at_ms" => state.deadline_at_ms,
      "deadline_generation" => state.deadline_generation,
      "role_capabilities" => state.role_capabilities,
      "recording" => state.recording,
      "admission_requests" =>
        state.admission_requests |> Map.values() |> Enum.sort_by(& &1["admission_request_id"]),
      "participants" =>
        state.participants
        |> Enum.sort_by(&elem(&1, 0))
        |> Enum.map(fn {id, participant} ->
          %{
            "participant_session_id" => id,
            "display_name" => participant.display_name,
            "hand_raised" => participant.hand_raised,
            "role" => participant.role,
            "eligible_roles" => participant.eligible_roles,
            "capabilities" => Map.fetch!(state.role_capabilities, participant.role),
            "admission_revision" => participant.admission_revision
          }
        end)
    }
  end

  def digest(state) do
    canonical = state |> snapshot() |> CanonicalJSON.encode!()
    :crypto.hash(:sha256, [@digest_prefix, <<@schema_version::unsigned-big-32>>, canonical])
  end

  defp initial(session_id, policy) do
    %{
      session_id: session_id,
      revision: 0,
      status: "active",
      admission_policy: value(policy, :admission_policy, "open"),
      host_exit_policy: value(policy, :host_exit_policy, "require_transfer"),
      role_capabilities: value(policy, :role_capabilities, @default_role_capabilities),
      host_participant_session_id: nil,
      deadline_at_ms: value(policy, :deadline_at_ms, 1),
      deadline_generation: value(policy, :deadline_generation, 1),
      recording: value(policy, :recording, nil),
      admission_requests: value(policy, :admission_requests, %{}),
      participants: %{}
    }
  end

  defp advance(event, state) do
    name = field(event, :name)
    base_revision = field(event, :base_revision)
    revision = field(event, :revision)

    unless name in @event_names and base_revision == state.revision and
             revision == state.revision + 1 do
      raise "invalid reference event sequence"
    end

    state
    |> apply_event(name, field(event, :payload))
    |> Map.put(:revision, revision)
  end

  defp apply_event(state, "participant_joined", payload) do
    id = payload["participant_session_id"]

    request =
      Enum.find(state.admission_requests, fn {_key, item} ->
        item["participant_session_id"] == id
      end)

    participant = %{
      display_name: payload["display_name"],
      hand_raised: false,
      role: payload["role"],
      eligible_roles: payload["eligible_roles"],
      admission_revision: payload["admission_revision"]
    }

    requests =
      if request,
        do: Map.delete(state.admission_requests, elem(request, 0)),
        else: state.admission_requests

    host =
      if participant.role == "host" and is_nil(state.host_participant_session_id),
        do: id,
        else: state.host_participant_session_id

    %{
      state
      | participants: Map.put(state.participants, id, participant),
        admission_requests: requests,
        host_participant_session_id: host
    }
  end

  defp apply_event(state, "participant_left", payload),
    do: %{state | participants: Map.delete(state.participants, payload["participant_session_id"])}

  defp apply_event(state, "host_left_and_transferred", payload) do
    departing = payload["departing_participant_session_id"]
    successor = payload["successor_participant_session_id"]

    participants =
      state.participants |> Map.delete(departing) |> put_in([successor, :role], "host")

    %{state | participants: participants, host_participant_session_id: successor}
  end

  defp apply_event(state, name, payload) when name in ["hand_raised", "hand_lowered"] do
    put_in(
      state.participants[payload["participant_session_id"]].hand_raised,
      name == "hand_raised"
    )
  end

  defp apply_event(state, "participant_display_name_changed", payload),
    do:
      put_in(
        state.participants[payload["participant_session_id"]].display_name,
        payload["display_name"]
      )

  defp apply_event(state, "admission_policy_changed", payload),
    do: %{state | admission_policy: payload["policy"]}

  defp apply_event(state, "deadline_changed", payload),
    do: %{
      state
      | deadline_at_ms: payload["deadline_at_ms"],
        deadline_generation: payload["deadline_generation"]
    }

  defp apply_event(state, "admission_requested", payload),
    do: put_in(state.admission_requests[payload["admission_request_id"]], payload)

  defp apply_event(state, name, payload) when name in ["admission_denied", "admission_expired"],
    do: %{
      state
      | admission_requests: Map.delete(state.admission_requests, payload["admission_request_id"])
    }

  defp apply_event(state, name, _payload)
       when name in [
              "participant_microphone_stopped",
              "participant_camera_stopped",
              "participant_screen_share_stopped"
            ],
       do: state

  defp apply_event(state, "recording_status_changed", payload), do: %{state | recording: payload}

  defp apply_event(state, "participant_role_changed", payload),
    do: put_in(state.participants[payload["participant_session_id"]].role, payload["role"])

  defp apply_event(state, "host_transferred", payload) do
    from = payload["previous_host_participant_session_id"]
    to = payload["new_host_participant_session_id"]

    participants =
      state.participants |> put_in([from, :role], "cohost") |> put_in([to, :role], "host")

    %{state | participants: participants, host_participant_session_id: to}
  end

  defp apply_event(state, "session_ended", _payload),
    do: %{
      state
      | status: "ended",
        participants: %{},
        host_participant_session_id: nil,
        admission_requests: %{},
        recording: nil
    }

  defp eligibility(%{participants: participants} = state) do
    %{
      "host" => state.host_participant_session_id,
      "status" => state.status,
      "participants" =>
        participants
        |> Enum.map(fn {id, participant} ->
          {id, {participant.role, participant.eligible_roles}}
        end)
        |> Map.new()
    }
  end

  defp eligibility(snapshot) do
    %{
      "host" => snapshot["host_participant_session_id"],
      "status" => snapshot["status"],
      "participants" =>
        snapshot["participants"]
        |> Enum.map(fn participant ->
          {participant["participant_session_id"],
           {participant["role"], participant["eligible_roles"]}}
        end)
        |> Map.new()
    }
  end

  defp field(event, key), do: Map.get(event, key, Map.get(event, Atom.to_string(key)))

  defp value(policy, key, default),
    do: Map.get(policy, key, Map.get(policy, Atom.to_string(key), default))
end
