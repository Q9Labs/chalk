defmodule ChalkSync.Contract.GeneratedTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Contract.Generated

  test "exports the correlation, lifecycle, continuity, idempotency, close, and error metadata" do
    assert Generated.protocol_version() == 1

    assert Generated.client_commands() == %{
             "lower_hand" => :lower_hand,
             "raise_hand" => :raise_hand
           }

    assert %{"connection" => "closed", "reasons" => ["hello timeout", "hello required"]} =
             Generated.close_code(1002)

    metadata = Generated.metadata()

    assert get_in(metadata, ["correlation", "optionalTopLevelFields"]) == %{
             "journey_id" => %{"kind" => "string", "format" => "chalk-journey-id"},
             "traceparent" => %{"kind" => "string", "format" => "w3c-traceparent"},
             "tracestate" => %{"kind" => "string", "format" => "w3c-tracestate"}
           }

    assert get_in(metadata, ["continuity", "events", "rule"]) ==
             "revision_equals_base_revision_plus_one"

    assert get_in(metadata, ["continuity", "snapshotFallback", "welcomeMode"]) == "snapshot"
    assert get_in(metadata, ["idempotency", "duplicate"]) == "reuses_original_result"
    assert metadata["errorConnection"] == "open"
  end

  test "validates hello cursors and the client command allow-list" do
    assert {:ok, {:hello, %{token: "token", cursor: nil}}} =
             Generated.decode_client_frame(%{
               "type" => "hello",
               "protocol" => 1,
               "token" => "token"
             })

    assert {:ok, {:hello, %{cursor: 4}}} =
             Generated.decode_client_frame(%{
               "type" => "hello",
               "protocol" => 1,
               "token" => "token",
               "streams" => %{"control" => %{"cursor" => 4}}
             })

    assert {:ok,
            {:hello,
             %{
               token: "token",
               journey_id: "00000000-0000-4000-8000-000000000001",
               traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
               tracestate: "chalk=sync"
             }}} =
             Generated.decode_client_frame(%{
               "type" => "hello",
               "protocol" => 1,
               "token" => "token",
               "journey_id" => "00000000-0000-4000-8000-000000000001",
               "traceparent" => "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
               "tracestate" => "chalk=sync"
             })

    assert {:ok,
            {:command,
             %{
               command_id: "c-1",
               name: :lower_hand,
               payload: %{},
               journey_id: "00000000-0000-4000-8000-000000000001"
             }}} =
             Generated.decode_client_frame(%{
               "type" => "command",
               "command_id" => "c-1",
               "name" => "lower_hand",
               "journey_id" => "00000000-0000-4000-8000-000000000001"
             })

    assert {:ok,
            {:ping, %{traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}}} =
             Generated.decode_client_frame(%{
               "type" => "ping",
               "traceparent" => "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
             })

    assert {:error, :invalid_correlation_fields} =
             Generated.decode_client_frame(%{
               "type" => "ping",
               "journey_id" => 1
             })

    assert {:error, :invalid_cursor} =
             Generated.decode_client_frame(%{
               "type" => "hello",
               "protocol" => 1,
               "token" => "token",
               "streams" => %{"control" => %{"cursor" => -1}}
             })

    for streams <- ["bad", %{"control" => "bad"}] do
      assert {:error, :invalid_cursor} =
               Generated.decode_client_frame(%{
                 "type" => "hello",
                 "protocol" => 1,
                 "token" => "token",
                 "streams" => streams
               })
    end

    assert {:ok, {:command, %{name: :lower_hand, payload: %{}}}} =
             Generated.decode_client_frame(%{
               "type" => "command",
               "command_id" => "c-1",
               "name" => "lower_hand"
             })

    assert {:error, :unknown_command} =
             Generated.decode_client_frame(%{
               "type" => "command",
               "command_id" => "c-1",
               "name" => "join"
             })
  end

  test "validates every server frame family and exact event continuity" do
    snapshot = %{
      "type" => "welcome",
      "protocol" => 1,
      "participant_id" => "p1",
      "mode" => "snapshot",
      "snapshot" => %{
        "control_revision" => 1,
        "participants" => [
          %{"participant_id" => "p1", "display_name" => "Ada", "hand_raised" => false}
        ]
      }
    }

    event = %{
      "type" => "event",
      "stream" => "control",
      "name" => "hand_raised",
      "base_revision" => 1,
      "revision" => 2,
      "payload" => %{"participant_id" => "p1"}
    }

    replay = %{
      "type" => "welcome",
      "protocol" => 1,
      "participant_id" => "p1",
      "mode" => "replay",
      "control_revision" => 2,
      "events" => [event]
    }

    assert Generated.valid_server_frame?(snapshot)
    assert Generated.valid_server_frame?(replay)

    assert Generated.valid_server_frame?(
             Map.put(
               snapshot,
               "traceparent",
               "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
             )
           )

    refute Generated.valid_server_frame?(Map.put(snapshot, "traceparent", 1))

    assert Generated.valid_server_frame?(%{
             "type" => "ack",
             "command_id" => "c",
             "result" => "committed",
             "revision" => 2
           })

    assert Generated.valid_server_frame?(%{
             "type" => "ack",
             "command_id" => "c",
             "result" => "duplicate",
             "revision" => 2
           })

    assert Generated.valid_server_frame?(%{
             "type" => "ack",
             "command_id" => "c",
             "result" => "rejected",
             "reason" => "no_change"
           })

    assert Generated.valid_server_frame?(%{
             "type" => "error",
             "code" => "protocol_error",
             "message" => "unknown_type"
           })

    assert Generated.valid_server_frame?(%{"type" => "pong"})
    refute Generated.valid_server_frame?(%{event | "revision" => 3})
  end
end
