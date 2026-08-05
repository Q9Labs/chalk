defmodule ChalkSync.Episodes.ReducerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Episodes.Reducer

  test "applies declarative changes and satisfies an already-current target" do
    state = owner_state()

    assert {:change, raised, state} =
             Reducer.decide_command(state, "owner", :set_hand_raised, %{"raised" => true})

    assert raised.name == "hand_raised"
    assert state.participants["owner"].hand_raised

    assert {:satisfied, ^state} =
             Reducer.decide_command(state, "owner", :set_hand_raised, %{"raised" => true})

    assert {:change, renamed, state} =
             Reducer.decide_command(state, "owner", :set_display_name, %{
               "displayName" => "Ada Lovelace"
             })

    assert renamed.name == "participant_display_name_changed"
    assert state.participants["owner"].display_name == "Ada Lovelace"
  end

  test "changes admission policy and assigns a configured role" do
    state = owner_state() |> join("guest", "Grace", "observer")

    assert {:change, policy_event, state} =
             Reducer.decide_command(state, "owner", :set_admission_policy, %{"policy" => "knock"})

    assert policy_event.name == "admission_policy_changed"
    assert state.admission_policy == "knock"

    assert {:change, role_event, state} =
             Reducer.decide_command(state, "owner", :assign_roles, %{
               "participantId" => "guest",
               "role" => "collaborator"
             })

    assert role_event.name == "role_assigned"
    assert state.participants["guest"].role == "collaborator"
  end

  test "rejects assigning a role absent from the config snapshot" do
    state = owner_state() |> join("guest", "Grace", "observer")

    assert Reducer.decide_command(state, "owner", :assign_roles, %{
             "participantId" => "guest",
             "role" => "unknown"
           }) == {:error, :invalid_target}
  end

  test "leave removes only the selected participant" do
    state = owner_state() |> join("guest", "Grace", "observer")

    assert {:change, event, next} =
             Reducer.decide_external(state, :participant_leave, %{"participant_id" => "guest"})

    assert event.name == "participant_left"
    refute Map.has_key?(next.participants, "guest")
    assert Map.has_key?(next.participants, "owner")
  end

  test "snapshot round trip preserves configured roles and stable digest" do
    state = owner_state() |> join("guest", "عالیہ", "observer")
    snapshot = Reducer.snapshot(state)

    assert {:ok, decoded} = Reducer.from_snapshot("episode-a", snapshot)
    assert decoded == state
    assert Reducer.digest(decoded) == Reducer.digest(state)
    assert byte_size(Reducer.digest(state)) == 32

    reordered = %{state | participants: Map.new(Enum.reverse(Enum.to_list(state.participants)))}
    assert Reducer.digest(reordered) == Reducer.digest(state)
  end

  test "rejects a snapshot with projected capabilities that differ from role mapping" do
    snapshot = Reducer.snapshot(owner_state())

    corrupted =
      update_in(snapshot["participants"], fn [owner] ->
        [%{owner | "capabilities" => ["raiseHand"]}]
      end)

    assert Reducer.from_snapshot("episode-a", corrupted) == {:error, :invalid_snapshot}
  end

  test "refuses a 501st participant" do
    state =
      Enum.reduce(1..499, owner_state(), fn index, current ->
        join(current, "participant-#{index}", "Participant #{index}", "observer")
      end)

    assert Reducer.apply_lifecycle(state, :participant_joined, %{
             "participant_id" => "participant-500",
             "display_name" => "Participant 500",
             "role" => "observer",
             "admission_revision" => 501
           }) == {:error, :capacity_exceeded}
  end

  defp owner_state do
    Reducer.new("episode-a")
    |> join("owner", "Ada", "owner")
  end

  defp join(state, id, name, role) do
    {:ok, _event, next} =
      Reducer.apply_lifecycle(state, :participant_joined, %{
        "participant_id" => id,
        "display_name" => name,
        "role" => role,
        "admission_revision" => state.revision + 1
      })

    next
  end
end
