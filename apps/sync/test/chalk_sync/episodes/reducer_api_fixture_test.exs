defmodule ChalkSync.Episodes.ReducerAPIFixtureTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Episodes.Reducer

  @fixture Path.expand("../../fixtures/api_episode_snapshot_v1.json", __DIR__)

  test "accepts the API-created v1 snapshot and applies its pending join" do
    fixture = @fixture |> File.read!() |> Jason.decode!()
    snapshot = fixture["folded_state"]

    assert {:ok, state} = Reducer.from_snapshot(fixture["episode_id"], snapshot)
    assert Reducer.digest(state) == Base.decode16!(fixture["state_digest"], case: :lower)
    assert Reducer.snapshot_bytes(state) == fixture["snapshot_bytes"]

    assert state.role_capabilities["facilitator"] == [
             "publishAudio",
             "publishVideo",
             "subscribe",
             "raiseHand",
             "sendChat"
           ]

    assert {:ok, event, next} =
             Reducer.apply_lifecycle(state, :participant_joined, fixture["pending_intent"])

    assert event.name == "participant_joined"
    assert event.base_revision == 0
    assert event.revision == 1
    assert next.participants[fixture["pending_intent"]["participant_id"]].role == "facilitator"
  end
end
