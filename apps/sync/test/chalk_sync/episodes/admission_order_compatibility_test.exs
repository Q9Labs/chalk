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
end
