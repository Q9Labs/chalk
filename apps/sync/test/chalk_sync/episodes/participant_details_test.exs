defmodule ChalkSync.Episodes.ParticipantDetailsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Postgres.ParticipantDetails

  @participant_id "6f7b1f63-b1f6-4d6e-9444-4c88a342bd01"
  @join %{
    "participant_id" => @participant_id,
    "display_name" => "Participant",
    "role" => "owner",
    "admission_revision" => 1
  }
  @master_join_keys ["admission_revision", "display_name", "participant_id", "role"]
  @master_participant_keys [
    "admission_revision",
    "capabilities",
    "display_name",
    "hand_raised",
    "participant_id",
    "role"
  ]

  test "durable join payloads and snapshots keep the previous release's exact shape" do
    state = Reducer.new("episode", %{})
    {:ok, event, next} = Reducer.apply_lifecycle(state, :participant_joined, @join)

    assert event.payload |> Map.keys() |> Enum.sort() == @master_join_keys
    refute Map.has_key?(event.payload, "identity_kind")

    [participant] = Reducer.snapshot(next)["participants"]
    assert participant |> Map.keys() |> Enum.sort() == @master_participant_keys
    refute Map.has_key?(participant, "identity_kind")
    assert {:ok, restored} = Reducer.from_snapshot("episode", Reducer.snapshot(next))
    assert Reducer.digest(restored) == Reducer.digest(next)
  end

  test "wire identity metadata is not accepted into durable control state" do
    state = Reducer.new("episode", %{})

    assert {:error, :invalid_payload} =
             Reducer.apply_lifecycle(
               state,
               :participant_joined,
               Map.put(@join, "identity_kind", "agent")
             )

    assert {:error, :invalid_payload} =
             Reducer.apply_lifecycle(
               state,
               :participant_joined,
               Map.put(@join, "description", "AI teammate")
             )
  end

  test "durable participant identity details overlay wire snapshots and join events" do
    state = Reducer.new("episode", %{})
    {:ok, event, next} = Reducer.apply_lifecycle(state, :participant_joined, @join)
    details = %{@participant_id => %{"identity_kind" => "agent", "description" => "AI teammate"}}

    [participant] =
      next
      |> Reducer.snapshot()
      |> ParticipantDetails.overlay_snapshot(details)
      |> Map.fetch!("participants")

    assert participant["identity_kind"] == "agent"
    assert participant["description"] == "AI teammate"
    assert ParticipantDetails.overlay_event(event, details).payload["identity_kind"] == "agent"

    assert ParticipantDetails.overlay_event(event, details).payload["description"] ==
             "AI teammate"

    assert Reducer.digest(next) == Reducer.digest(next)
  end
end
