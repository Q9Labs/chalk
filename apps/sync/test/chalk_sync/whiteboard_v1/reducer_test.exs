defmodule ChalkSync.WhiteboardV1.ReducerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.WhiteboardV1.Reducer

  @fixture_path Path.expand(
                  "../../../../../packages/whiteboard/src/collab/fixtures/excalidraw-0.18.1-reducer-golden.json",
                  __DIR__
                )

  test "matches the Excalidraw 0.18.1 reducer golden" do
    fixture = @fixture_path |> File.read!() |> JSON.decode!()

    assert Reducer.merge(fixture["current"], fixture["incoming"]) == fixture["expected"]
  end

  test "a full sync does not delete absent elements" do
    fixture = @fixture_path |> File.read!() |> JSON.decode!()
    assert Reducer.merge(fixture["current"], []) == fixture["current"]
  end
end
