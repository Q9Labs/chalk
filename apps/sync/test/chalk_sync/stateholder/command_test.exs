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

  test "validates all five declarative target shapes before fingerprinting" do
    targets = [
      {:set_hand_raised, %{"raised" => true}},
      {:set_display_name, %{"displayName" => "Ada"}},
      {:set_admission_policy, %{"policy" => "approval"}},
      {:set_participant_role,
       %{
         "participantSessionId" => "55555555-5555-4555-8555-555555555555",
         "role" => "cohost"
       }},
      {:transfer_host, %{"participantSessionId" => "55555555-5555-4555-8555-555555555555"}}
    ]

    Enum.each(targets, fn {name, payload} ->
      assert {:ok, %{name: ^name}} = Command.new("declarative_cmd1", name, payload)
    end)

    assert Command.new("declarative_cmd1", :set_display_name, %{"displayName" => " Ada "}) ==
             {:error, :invalid_payload}

    assert Command.new("declarative_cmd1", :set_participant_role, %{
             "participantSessionId" => "55555555-5555-4555-8555-555555555555",
             "role" => "host"
           }) == {:error, :invalid_payload}
  end
end
