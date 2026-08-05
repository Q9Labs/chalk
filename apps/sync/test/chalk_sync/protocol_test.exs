defmodule ChalkSync.ProtocolV1Test do
  use ExUnit.Case, async: true

  alias ChalkSync.Contract.GeneratedV1
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

  test "reserves the full correlation object budget for near-limit chat pages" do
    limits = GeneratedV1.limits()
    reserve = limits["correlationReservedBytes"]
    producer_limit = limits["chatPageEncodedBytes"] - reserve
    frame = near_limit_chat_page(producer_limit)
    correlation = maximum_correlation()
    correlated = Map.merge(frame, correlation)
    oversized = put_last_message_text(frame, producer_limit - byte_size(JSON.encode!(frame)) + 1)

    assert byte_size(JSON.encode!(correlation)) == reserve
    assert byte_size(JSON.encode!(frame)) == producer_limit
    assert byte_size(JSON.encode!(correlated)) <= limits["chatPageEncodedBytes"]
    assert GeneratedV1.valid_server_frame?(frame)
    assert GeneratedV1.valid_server_frame?(correlated)
    assert ProtocolV1.encode!(frame) |> byte_size() == producer_limit
    assert ProtocolV1.encode!(correlated) |> byte_size() <= limits["chatPageEncodedBytes"]
    refute GeneratedV1.valid_server_frame?(oversized)
    assert_raise ArgumentError, fn -> ProtocolV1.encode!(oversized) end
  end

  defp near_limit_chat_page(target_bytes) do
    messages =
      Enum.map(0..30, fn index ->
        chat_message(index, if(index == 30, do: 0, else: 4_000))
      end)

    frame = %{
      "type" => "chat_page",
      "request_id" => "chat-page-request-01",
      "outcome" => "loaded",
      "messages" => messages,
      "has_more" => false,
      "head_sequence" => "8",
      "retained_floor_sequence" => "1"
    }

    put_last_message_text(frame, target_bytes - byte_size(JSON.encode!(frame)))
  end

  defp put_last_message_text(frame, additional_bytes) when additional_bytes >= 0 do
    update_in(frame, ["messages", Access.at(-1), "text"], fn text ->
      text <> String.duplicate("x", additional_bytes)
    end)
  end

  defp chat_message(index, text_length) do
    %{
      "type" => "chat_message",
      "message_id" =>
        "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c#{String.pad_leading(Integer.to_string(index + 23), 2, "0")}",
      "client_message_id" =>
        "chat-message-id-#{String.pad_leading(Integer.to_string(index), 2, "0")}",
      "sequence" => Integer.to_string(index + 1),
      "participant_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4cff",
      "display_name" => "name",
      "text" => String.duplicate("x", text_length),
      "attachments" => [],
      "created_at" => "2026-08-05T00:00:00Z"
    }
  end

  defp maximum_correlation do
    %{
      "journey_id" => "00000000-0000-4000-8000-000000000042",
      "traceparent" => "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
      "tracestate" => "a=" <> String.duplicate("\\", 256) <> ",b=" <> String.duplicate("\\", 251)
    }
  end
end
