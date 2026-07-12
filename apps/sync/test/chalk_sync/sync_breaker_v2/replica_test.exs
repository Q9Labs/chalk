defmodule ChalkSync.SyncBreakerV2.ReplicaTest do
  use ExUnit.Case, async: true

  alias ChalkSync.SyncBreakerV2.Replica

  test "requires exact next revision and matching v2 state digest" do
    expected = %Replica{
      revision: 1,
      participants: %{
        "participant-a" => %{"display_name" => "A", "hand_raised" => false}
      }
    }

    event = %{
      "type" => "event",
      "stream" => "control",
      "schema_version" => 1,
      "name" => "participant_joined",
      "base_revision" => 0,
      "revision" => 1,
      "payload" => %{"participant_session_id" => "participant-a", "display_name" => "A"},
      "resulting_state_digest" => Replica.digest_hex(expected)
    }

    assert {:ok, ^expected} = Replica.apply_event(Replica.new(), event)
    assert {:error, :revision_or_digest_mismatch} = Replica.apply_event(expected, event)
  end
end
