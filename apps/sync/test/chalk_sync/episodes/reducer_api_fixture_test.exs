defmodule ChalkSync.Episodes.ReducerAPIFixtureTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Episodes.Reducer

  @api_artifact Path.expand("../../fixtures/api_episode_snapshot_v1.json", __DIR__)

  test "accepts the current API-generated v1 snapshot and applies its pending join" do
    fixture = api_artifact()
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

  test "rejects an incompatible API snapshot" do
    fixture = api_artifact()
    snapshot = Map.put(fixture["folded_state"], "state_schema_version", 2)

    assert {:error, :invalid_snapshot} = Reducer.from_snapshot(fixture["episode_id"], snapshot)
  end

  test "rejects API snapshots with unknown fields" do
    fixture = api_artifact()
    snapshot = Map.put(fixture["folded_state"], "future_field", true)

    assert {:error, :invalid_snapshot} = Reducer.from_snapshot(fixture["episode_id"], snapshot)
  end

  defp api_artifact, do: @api_artifact |> File.read!() |> Jason.decode!()
end
