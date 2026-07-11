defmodule ChalkSync.Contract.GeneratedTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Contract.Generated

  test "exports the protocol lifecycle, continuity, idempotency, close, and error metadata" do
    assert Generated.protocol_version() == 1

    assert Generated.client_commands() == %{
             "lower_hand" => :lower_hand,
             "raise_hand" => :raise_hand
           }

    assert %{"connection" => "closed", "reasons" => ["hello timeout", "hello required"]} =
             Generated.close_code(1002)

    metadata = Generated.metadata()

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
