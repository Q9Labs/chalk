defmodule ChalkSync.ProtocolV1Test do
  use ExUnit.Case, async: true

  alias ChalkSync.ProtocolV1
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.Stateholder.SessionKey

  test "decodes the control stream on a strict delivery acknowledgement" do
    digest = String.duplicate("a", 64)

    assert {:ok, {:delivery_ack, %{stream: :control, revision: 2, state_digest: ^digest}}} =
             ProtocolV1.decode(
               JSON.encode!(%{
                 "type" => "delivery_ack",
                 "stream" => "control",
                 "revision" => 2,
                 "state_digest" => digest
               })
             )
  end

  test "decodes the exact room-actions extension" do
    streams = %{
      "control" => %{"cursor" => nil},
      "media" => %{"cursor" => nil},
      "presence" => %{"cursor" => nil},
      "requests" => %{"cursor" => nil}
    }

    assert {:ok, {:hello, %{token: "token", cursor: nil}}} =
             ProtocolV1.decode(
               JSON.encode!(%{
                 "type" => "hello",
                 "protocol" => 1,
                 "token" => "token",
                 "streams" => streams
               })
             )

    assert {:ok,
            {:hello,
             %{
               token: "token",
               cursor: nil,
               room_actions: %{
                 after_sequence: "12",
                 retained_floor_sequence: "4"
               }
             }}} =
             ProtocolV1.decode(
               JSON.encode!(%{
                 "type" => "hello",
                 "protocol" => 1,
                 "token" => "token",
                 "streams" => streams,
                 "extensions" => [
                   %{
                     "name" => "room_actions_v2",
                     "chat_cursor" => %{
                       "after_sequence" => "12",
                       "retained_floor_sequence" => "4"
                     }
                   }
                 ]
               })
             )
  end

  test "adds the negotiated room-actions policy only to an extended welcome" do
    identity = %Identity{
      session: %SessionKey{
        tenant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c20",
        room_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
        session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22"
      },
      participant_session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      participant_session_generation: 1
    }

    recovery = %Recovery{
      mode: :up_to_date,
      head: %{
        revision: 0,
        state_schema_version: 1,
        digest: :binary.copy(<<0>>, 32)
      },
      snapshot: nil,
      events: []
    }

    legacy =
      identity
      |> ProtocolV1.recovery_welcome(
        recovery,
        "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24"
      )
      |> JSON.decode!()

    refute Map.has_key?(legacy, "extensions")

    extension = %{
      "name" => "room_actions_v2",
      "capabilities" => ["sendReaction", "sendChat"],
      "participant_capabilities" => %{
        identity.participant_session_id => ["sendReaction", "sendChat"]
      },
      "chat_head_sequence" => "8",
      "retained_floor_sequence" => "2",
      "read_receipts" => []
    }

    extended =
      identity
      |> ProtocolV1.recovery_welcome(
        recovery,
        "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24",
        %{room_actions_extension: extension}
      )
      |> JSON.decode!()

    assert extended["extensions"] == [extension]
  end
end
