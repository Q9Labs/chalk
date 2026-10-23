defmodule ChalkSync.Episodes.AdmissionOrderCompatibilityTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Postgres.Control

  @fixture Path.expand(
             "../../../../../sdks/typescript/client/test/fixtures/admission-order-v1.json",
             __DIR__
           )

  test "the reader accepts both stored orders with the client's digest" do
    fixture = @fixture |> File.read!() |> JSON.decode!()
    episode = %{episode_id: fixture["episode_id"]}

    for %{"snapshot" => snapshot} <- fixture["stored_snapshots"] do
      control = %{
        state_schema_version: snapshot["state_schema_version"],
        revision: snapshot["control_revision"],
        folded_state: Map.delete(snapshot, "state_digest"),
        digest: Base.decode16!(snapshot["state_digest"], case: :lower)
      }

      assert {:ok, restored} = Control.validate_fold(episode, control)
      assert Reducer.wire_snapshot(restored) == snapshot
    end
  end

  test "retention replays legacy digests and rejects corruption" do
    fixture = @fixture |> File.read!() |> JSON.decode!()

    assert {:ok, initial} =
             Reducer.from_snapshot(
               fixture["episode_id"],
               Map.delete(fixture["initial_snapshot"], "state_digest")
             )

    for legacy_count <- [3, length(fixture["events"])] do
      fixture["events"]
      |> Enum.with_index()
      |> Enum.reduce(initial, fn {event, index}, state ->
        digest =
          if index < legacy_count do
            fixture["legacy_resulting_state_digests"]
            |> Enum.at(index)
            |> Base.decode16!(case: :lower)
          else
            {:ok, live} = Reducer.apply_event(state, event)
            Reducer.digest(live)
          end

        assert {:ok, next} = Reducer.replay_event(state, event, digest)
        assert Reducer.digest(next) == digest
        assert {:error, :event_digest_mismatch} = Reducer.replay_event(state, event, <<0::256>>)
        next
      end)
    end
  end
end
