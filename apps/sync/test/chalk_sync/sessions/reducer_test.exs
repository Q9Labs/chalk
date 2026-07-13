defmodule ChalkSync.Sessions.ReducerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Sessions.Reducer

  test "applies declarative changes and satisfies an already-current target" do
    state = host_state()

    assert {:change, raised, state} =
             Reducer.decide_command(state, "host", :set_hand_raised, %{"raised" => true})

    assert raised.name == "hand_raised"
    assert state.revision == 2
    assert state.participants["host"].hand_raised

    assert {:satisfied, ^state} =
             Reducer.decide_command(state, "host", :set_hand_raised, %{"raised" => true})

    assert {:change, renamed, state} =
             Reducer.decide_command(state, "host", :set_display_name, %{
               "displayName" => "Ada Lovelace"
             })

    assert renamed.name == "participant_display_name_changed"
    assert state.participants["host"].display_name == "Ada Lovelace"
  end

  test "changes admission policy and eligible participant roles" do
    state = host_state() |> join("guest", "Grace", "participant", ["participant", "cohost"])

    assert {:change, policy_event, state} =
             Reducer.decide_command(state, "host", :set_admission_policy, %{
               "policy" => "approval"
             })

    assert policy_event.name == "admission_policy_changed"
    assert state.admission_policy == "approval"

    assert {:change, role_event, state} =
             Reducer.decide_command(state, "host", :set_participant_role, %{
               "participantSessionId" => "guest",
               "role" => "cohost"
             })

    assert role_event.name == "participant_role_changed"
    assert state.participants["guest"].role == "cohost"

    assert {:change, demoted_event, demoted} =
             Reducer.decide_command(state, "host", :set_participant_role, %{
               "participantSessionId" => "guest",
               "role" => "participant"
             })

    assert demoted_event.base_revision == 4
    assert demoted.revision == 5
    assert demoted.participants["guest"].role == "participant"
  end

  test "rejects role and host targets outside the admitted eligible set" do
    state = host_state() |> join("guest", "Grace", "participant", ["participant"])

    assert Reducer.decide_command(state, "host", :set_participant_role, %{
             "participantSessionId" => "guest",
             "role" => "cohost"
           }) == {:error, :role_not_eligible}

    assert Reducer.decide_command(state, "host", :transfer_host, %{
             "participantSessionId" => "guest"
           }) == {:error, :invalid_target}
  end

  test "transfers host atomically and keeps exactly one derived host" do
    state = host_state() |> join("successor", "Grace", "cohost", ["host", "cohost"])

    assert {:change, event, transferred} =
             Reducer.decide_command(state, "host", :transfer_host, %{
               "participantSessionId" => "successor"
             })

    assert event.name == "host_transferred"
    assert transferred.host_participant_session_id == "successor"
    assert transferred.participants["successor"].role == "host"
    assert transferred.participants["host"].role == "cohost"
  end

  test "host leave requires transfer or promotes the longest-tenured cohost deterministically" do
    require_transfer =
      host_state()
      |> join("cohost", "Grace", "cohost", ["host", "cohost"])

    assert Reducer.decide_external(require_transfer, :participant_leave, %{
             "participant_session_id" => "host"
           }) == {:error, :host_transfer_required}

    promote = %{require_transfer | host_exit_policy: "promote_cohost"}

    promote =
      join(promote, "cohost-a", "A", "cohost", ["host", "cohost"], 2)

    assert {:change, event, next} =
             Reducer.decide_external(promote, :participant_leave, %{
               "participant_session_id" => "host"
             })

    assert event.name == "host_left_and_transferred"
    assert event.payload["successor_participant_session_id"] == "cohost"
    assert next.host_participant_session_id == "cohost"
    refute Map.has_key?(next.participants, "host")
  end

  test "snapshot round trip preserves immutable policy, roles, and stable digest" do
    state =
      host_state()
      |> join("guest", "عالیہ", "participant", ["participant", "cohost"])

    snapshot = Reducer.snapshot(state)
    assert {:ok, decoded} = Reducer.from_snapshot("session-a", snapshot)
    assert decoded == state
    assert Reducer.digest(decoded) == Reducer.digest(state)
    assert byte_size(Reducer.digest(state)) == 32

    reordered = %{state | participants: Map.new(Enum.reverse(Enum.to_list(state.participants)))}
    assert Reducer.digest(reordered) == Reducer.digest(state)
  end

  test "rejects non-empty snapshots without exactly one matching host" do
    snapshot = Reducer.snapshot(host_state())

    assert Reducer.from_snapshot(
             "session-a",
             Map.put(snapshot, "host_participant_session_id", nil)
           ) == {:error, :invalid_snapshot}

    duplicate_host =
      update_in(snapshot["participants"], fn [host] ->
        [host, %{host | "participant_session_id" => "other"}]
      end)

    assert Reducer.from_snapshot("session-a", duplicate_host) == {:error, :invalid_snapshot}
  end

  test "refuses a 501st participant" do
    state =
      Enum.reduce(1..499, host_state(), fn index, state ->
        join(state, "participant-#{index}", "Participant #{index}", "participant", ["participant"])
      end)

    assert Reducer.apply_lifecycle(state, :participant_joined, %{
             "participant_session_id" => "participant-500",
             "display_name" => "Participant 500",
             "role" => "participant",
             "eligible_roles" => ["participant"],
             "admission_revision" => 501
           }) == {:error, :capacity_exceeded}
  end

  defp host_state do
    Reducer.new("session-a")
    |> join("host", "Ada", "host", ["host", "cohost", "participant"], 1)
  end

  defp join(state, id, name, role, eligible_roles, admission_revision \\ nil) do
    {:ok, _event, next} =
      Reducer.apply_lifecycle(state, :participant_joined, %{
        "participant_session_id" => id,
        "display_name" => name,
        "role" => role,
        "eligible_roles" => eligible_roles,
        "admission_revision" => admission_revision || state.revision + 1
      })

    next
  end
end
