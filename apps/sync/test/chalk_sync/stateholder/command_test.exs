defmodule ChalkSync.Stateholder.CommandTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Stateholder.Command

  test "normalizes supported command names and fingerprints intent" do
    payload = %{"raised" => true}
    assert {:ok, first} = Command.new("command_id_00001", "set_hand_raised", payload)
    assert {:ok, second} = Command.new("command_id_00001", :set_hand_raised, payload)
    assert first.fingerprint == second.fingerprint
    assert first.name == :set_hand_raised
  end

  test "rejects malformed IDs, unknown commands, and loose payloads" do
    assert Command.new("short", :set_hand_raised, %{"raised" => true}) ==
             {:error, :invalid_command_id}

    assert Command.new("command_id_00001", :invented, %{}) == {:error, :unknown_command}
    assert Command.new("command_id_00001", :raise_hand, %{}) == {:error, :unknown_command}

    assert Command.new("command_id_00001", :set_hand_raised, %{"extra" => true}) ==
             {:error, :invalid_payload}
  end

  test "validates all five declarative target shapes before fingerprinting" do
    targets = [
      {:set_hand_raised, %{"raised" => true}},
      {:set_display_name, %{"displayName" => "Ada"}},
      {:set_admission_policy, %{"policy" => "knock"}},
      {:assign_roles,
       %{
         "participantId" => "55555555-5555-4555-8555-555555555555",
         "role" => "cohost"
       }}
    ]

    Enum.each(targets, fn {name, payload} ->
      assert {:ok, %{name: ^name}} = Command.new("declarative_cmd1", name, payload)
    end)

    assert Command.new("declarative_cmd1", :set_display_name, %{"displayName" => " Ada "}) ==
             {:error, :invalid_payload}

    assert Command.new("declarative_cmd1", :assign_roles, %{
             "participantId" => "55555555-5555-4555-8555-555555555555",
             "role" => " observer "
           }) == {:error, :invalid_payload}
  end
end
