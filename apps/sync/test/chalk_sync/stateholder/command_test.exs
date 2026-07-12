defmodule ChalkSync.Stateholder.CommandTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Stateholder.Command

  test "normalizes supported command names and fingerprints intent" do
    assert {:ok, first} = Command.new("command_id_00001", "raise_hand", %{})
    assert {:ok, second} = Command.new("command_id_00001", :raise_hand, %{})
    assert first.fingerprint == second.fingerprint
    assert first.name == :raise_hand
  end

  test "rejects malformed IDs, unknown commands, and loose payloads" do
    assert Command.new("short", :raise_hand, %{}) == {:error, :invalid_command_id}
    assert Command.new("command_id_00001", :invented, %{}) == {:error, :unknown_command}

    assert Command.new("command_id_00001", :raise_hand, %{"extra" => true}) ==
             {:error, :invalid_payload}
  end
end
