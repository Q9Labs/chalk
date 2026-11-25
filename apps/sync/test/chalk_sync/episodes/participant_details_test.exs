defmodule ChalkSync.Episodes.ParticipantDetailsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Episodes.Reducer

  @join %{
    "participant_id" => "6f7b1f63-b1f6-4d6e-9444-4c88a342bd01",
    "display_name" => "Participant",
    "role" => "owner",
    "admission_revision" => 1
  }

  test "participant identity kind is wire metadata and does not change the control digest" do
    state = Reducer.new("episode", %{})

    {:ok, _plain_event, plain} = Reducer.apply_lifecycle(state, :participant_joined, @join)

    detailed_join = Map.put(@join, "identity_kind", "agent")
    {:ok, event, detailed} = Reducer.apply_lifecycle(state, :participant_joined, detailed_join)

    assert event.payload["identity_kind"] == "agent"
    assert Reducer.digest(detailed) == Reducer.digest(plain)

    assert Enum.any?(
             Reducer.snapshot(detailed)["participants"],
             &(&1["identity_kind"] == "agent")
           )
  end

  test "participant identity kind survives a snapshot round trip" do
    state = Reducer.new("episode", %{})

    {:ok, _event, detailed} =
      Reducer.apply_lifecycle(
        state,
        :participant_joined,
        Map.put(@join, "identity_kind", "agent")
      )

    snapshot = Reducer.snapshot(detailed)
    assert {:ok, restored} = Reducer.from_snapshot("episode", snapshot)

    assert Enum.any?(
             Reducer.snapshot(restored)["participants"],
             &(&1["identity_kind"] == "agent")
           )

    assert Reducer.digest(restored) == Reducer.digest(detailed)
  end

  test "participant identity kind is limited to the attendance vocabulary" do
    state = Reducer.new("episode", %{})

    assert {:error, :invalid_payload} =
             Reducer.apply_lifecycle(
               state,
               :participant_joined,
               Map.put(@join, "identity_kind", "service")
             )
  end
end
