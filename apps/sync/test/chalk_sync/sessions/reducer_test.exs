defmodule ChalkSync.Sessions.ReducerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Sessions.Reducer

  test "applies lifecycle and commands as one exact event chain" do
    state = Reducer.new("session-a")

    assert {:ok, joined, state} =
             Reducer.apply_lifecycle(state, :participant_joined, %{
               "participant_session_id" => "participant-a",
               "display_name" => "Ada"
             })

    assert {joined.base_revision, joined.revision} == {0, 1}

    assert {:ok, raised, state} =
             Reducer.decide_command(state, "participant-a", :raise_hand, %{})

    assert {raised.base_revision, raised.revision} == {1, 2}
    assert state.participants["participant-a"].hand_raised

    assert {:ok, left, state} =
             Reducer.apply_lifecycle(state, :participant_left, %{
               "participant_session_id" => "participant-a"
             })

    assert {left.base_revision, left.revision} == {2, 3}
    assert state.participants == %{}
  end

  test "rejects a supplied noncontiguous revision" do
    event = %{
      name: "participant_joined",
      base_revision: 0,
      revision: 5,
      payload: %{"participant_session_id" => "participant-a", "display_name" => "Ada"}
    }

    assert Reducer.apply_event(Reducer.new("session-a"), event) == {:error, :revision_gap}
  end

  test "returns explicit errors for unknown events, payloads, and transitions" do
    state = Reducer.new("session-a")

    assert Reducer.apply_event(state, %{
             name: "invented",
             base_revision: 0,
             revision: 1,
             payload: %{}
           }) == {:error, :unknown_event}

    assert Reducer.apply_lifecycle(state, :participant_joined, %{
             "participant_session_id" => "participant-a",
             "display_name" => "Ada",
             "extra" => true
           }) == {:error, :invalid_payload}

    assert Reducer.decide_command(state, "missing", :raise_hand, %{}) ==
             {:error, :not_joined}
  end

  test "session end clears participants and is terminal" do
    {:ok, _event, state} =
      Reducer.apply_lifecycle(Reducer.new("session-a"), :participant_joined, %{
        "participant_session_id" => "participant-a",
        "display_name" => "Ada"
      })

    assert {:ok, event, ended} = Reducer.apply_lifecycle(state, :session_ended, %{})
    assert event.name == "session_ended"
    assert ended.status == "ended"
    assert ended.participants == %{}

    assert Reducer.decide_command(ended, "participant-a", :raise_hand, %{}) ==
             {:error, :session_ended}
  end

  test "snapshot order and digest are independent of map insertion order" do
    first = %Reducer{
      session_id: "session-a",
      revision: 9,
      participants: %{
        "participant-b" => %{display_name: "Bo", hand_raised: false},
        "participant-a" => %{display_name: "عالیہ", hand_raised: true}
      }
    }

    second = %Reducer{
      session_id: "session-a",
      revision: 9,
      participants: Map.new(Enum.reverse(Enum.to_list(first.participants)))
    }

    assert Reducer.snapshot(first) == Reducer.snapshot(second)
    assert Reducer.digest(first) == Reducer.digest(second)
    assert byte_size(Reducer.digest(first)) == 32
  end

  test "snapshot round trip validates exact schema" do
    state = Reducer.new("session-a")
    assert {:ok, ^state} = Reducer.from_snapshot("session-a", Reducer.snapshot(state))

    invalid = Map.put(Reducer.snapshot(state), "unexpected", true)
    assert Reducer.from_snapshot("session-a", invalid) == {:error, :invalid_snapshot}
  end

  test "refuses a 501st active participant in events and snapshots" do
    participants =
      Map.new(1..500, fn index ->
        {"participant-#{index}", %{display_name: "Participant #{index}", hand_raised: false}}
      end)

    state = %Reducer{session_id: "session-a", revision: 500, participants: participants}

    assert Reducer.apply_lifecycle(state, :participant_joined, %{
             "participant_session_id" => "participant-501",
             "display_name" => "Participant 501"
           }) == {:error, :capacity_exceeded}

    oversized =
      state
      |> Reducer.snapshot()
      |> Map.update!("participants", fn encoded ->
        encoded ++
          [
            %{
              "participant_session_id" => "participant-501",
              "display_name" => "Participant 501",
              "hand_raised" => false
            }
          ]
      end)

    assert Reducer.from_snapshot("session-a", oversized) == {:error, :invalid_snapshot}
  end
end
