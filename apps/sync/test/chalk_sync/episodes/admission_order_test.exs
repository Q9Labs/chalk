defmodule ChalkSync.Episodes.AdmissionOrderTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Episodes.Reducer

  @fixture Path.expand(
             "../../fixtures/admission_order_v1.json",
             __DIR__
           )

  test "digest follows client arrival order even when the second knock's id sorts first" do
    fixture = @fixture |> File.read!() |> JSON.decode!()
    initial = fixture["initial_snapshot"] |> Map.delete("state_digest")
    assert {:ok, state} = Reducer.from_snapshot(fixture["episode_id"], initial)

    Enum.reduce(fixture["events"], state, fn event, state ->
      assert {:ok, next} = Reducer.apply_event(state, event)
      assert Base.encode16(Reducer.digest(next), case: :lower) == event["resulting_state_digest"]

      # Recovery must keep the snapshot's order before the next live event.
      assert {:ok, restored} =
               Reducer.from_snapshot(fixture["episode_id"], Reducer.snapshot(next))

      assert Reducer.digest(restored) == Reducer.digest(next)
      restored
    end)
  end
end
