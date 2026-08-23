defmodule ChalkSync.ProtocolV1Test do
  use ExUnit.Case, async: true

  alias ChalkSync.ProtocolV1
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Recovery

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

  test "decodes the exact space-actions extension" do
    streams = %{
      "control" => %{"cursor" => nil},
      "media" => %{"cursor" => nil},
      "presence" => %{"cursor" => nil},
      "requests" => %{"cursor" => nil}
    }

    assert {:ok, {:hello, %{token: "token", cursor: nil, correlation: %{}}}} =
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
               correlation: %{},
               collaboration: %{
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
                     "name" => "collaboration_v1",
                     "chat_cursor" => %{
                       "after_sequence" => "12",
                       "retained_floor_sequence" => "4"
                     }
                   }
                 ]
               })
             )
  end

  test "normalizes validated hello correlation fields into a string-keyed envelope" do
    streams = %{
      "control" => %{"cursor" => nil},
      "media" => %{"cursor" => nil},
      "presence" => %{"cursor" => nil},
      "requests" => %{"cursor" => nil}
    }

    assert {:ok,
            {:hello,
             %{
               token: "token",
               cursor: nil,
               correlation: %{
                 "journey_id" => "00000000-0000-4000-8000-000000000042",
                 "traceparent" => "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                 "tracestate" => "vendor=value"
               }
             }}} =
             ProtocolV1.decode(
               JSON.encode!(%{
                 "type" => "hello",
                 "protocol" => 1,
                 "token" => "token",
                 "streams" => streams,
                 "journey_id" => "00000000-0000-4000-8000-000000000042",
                 "traceparent" => "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                 "tracestate" => "vendor=value"
               })
             )

    assert {:error, :invalid_hello} =
             ProtocolV1.decode(
               JSON.encode!(%{
                 "type" => "hello",
                 "protocol" => 1,
                 "token" => "token",
                 "streams" => streams,
                 "traceparent" => "00-00000000000000000000000000000000-00f067aa0ba902b7-01"
               })
             )
  end

  test "adds the negotiated space-actions policy only to an extended welcome" do
    identity = %Identity{
      episode: %EpisodeKey{
        tenant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c20",
        space_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
        episode_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22"
      },
      participant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      participant_generation: 1
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
      "name" => "collaboration_v1",
      "capabilities" => ["sendReaction", "sendChat"],
      "participant_capabilities" => %{
        identity.participant_id => ["sendReaction", "sendChat"]
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
        %{collaboration_extension: extension}
      )
      |> JSON.decode!()

    assert extended["extensions"] == [extension]
  end
end
