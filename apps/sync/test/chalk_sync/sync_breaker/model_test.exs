defmodule ChalkSync.SyncBreaker.ModelTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreaker.Model
  alias ChalkSync.SyncBreaker.Operation

  test "applies independent control transitions and remembers command outcomes" do
    join = Operation.new(1, "p1", "c-1", :join, %{display_name: "Ada"})
    raise = Operation.new(2, "p1", "c-2", :raise_hand)
    no_change = Operation.new(3, "p1", "c-3", :raise_hand)

    assert {:committed, joined, state} = Model.apply(Model.new(), join)

    assert joined == %{
             name: "participant_joined",
             base_revision: 0,
             revision: 1,
             payload: %{"participant_id" => "p1", "display_name" => "Ada"}
           }

    assert {:committed, raised, state} = Model.apply(state, raise)
    assert {:duplicate, 2, ^state} = Model.apply(state, raise)
    assert {:rejected, :no_change, _state} = Model.apply(state, no_change)

    assert Model.snapshot(state) == %{
             "control_revision" => 2,
             "participants" => [
               %{"participant_id" => "p1", "display_name" => "Ada", "hand_raised" => true}
             ]
           }

    assert {:ok, replayed} = Model.replay(Model.new(), [joined, raised])
    assert Model.snapshot(replayed) == Model.snapshot(state)
  end

  test "rejects event gaps and parses only complete snapshots" do
    event = %{
      name: "hand_raised",
      base_revision: 1,
      revision: 2,
      payload: %{"participant_id" => "p1"}
    }

    assert {:error, :revision_gap} = Model.apply_event(Model.new(), event)
    assert {:error, :invalid_snapshot} = Model.from_snapshot(%{"control_revision" => 1})
  end

  test "rejects semantically invalid event transitions" do
    joined = %{
      name: "participant_joined",
      base_revision: 0,
      revision: 1,
      payload: %{"participant_id" => "p1", "display_name" => "Ada"}
    }

    assert {:ok, state} = Model.apply_event(Model.new(), joined)

    assert {:error, :unknown_event} =
             Model.apply_event(state, %{joined | base_revision: 1, revision: 2})

    assert {:error, :unknown_event} =
             Model.apply_event(state, %{
               name: "hand_lowered",
               base_revision: 1,
               revision: 2,
               payload: %{"participant_id" => "p1"}
             })

    assert {:error, :unknown_event} =
             Model.apply_event(state, %{
               name: "participant_left",
               base_revision: 1,
               revision: 2,
               payload: %{"participant_id" => "missing"}
             })
  end

  test "rejects snapshots with duplicate participant IDs" do
    participant = %{
      "participant_id" => "p1",
      "display_name" => "Ada",
      "hand_raised" => false
    }

    assert {:error, :invalid_snapshot} =
             Model.from_snapshot(%{
               "control_revision" => 1,
               "participants" => [participant, participant]
             })
  end
end
