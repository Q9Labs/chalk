defmodule ChalkSync.WhiteboardV1.SocketTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.Transport.SocketWhiteboardV1

  @participant_id "20000000-0000-4000-8000-000000000002"
  @scene_id "10000000-0000-4000-8000-000000000001"

  test "enforces the hello deadline and strict text framing" do
    assert {:ok, state} = SocketWhiteboardV1.init(%{})

    assert {:stop, :normal, {1008, "hello timeout"}, ^state} =
             SocketWhiteboardV1.handle_info(:hello_timeout, state)

    assert {:stop, :normal, {1009, "text frames only"}, ^state} =
             SocketWhiteboardV1.handle_in({<<1, 2>>, [opcode: :binary]}, state)

    assert {:push, {:text, ~s({"type":"pong"})}, ^state} =
             SocketWhiteboardV1.handle_in(
               {~s({"type":"ping"}), [opcode: :text]},
               state
             )
  end

  test "does not echo a participant cursor or replay an applied update" do
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    identity = %Identity{
      session: %SessionKey{
        tenant_id: "30000000-0000-4000-8000-000000000003",
        room_id: "40000000-0000-4000-8000-000000000004",
        session_id: "50000000-0000-4000-8000-000000000005"
      },
      participant_session_id: @participant_id,
      participant_session_generation: 1
    }

    state = %{
      initial
      | phase: :live,
        identity: identity,
        scene_id: @scene_id,
        revision: 4
    }

    assert {:ok, ^state} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_frame,
                %{
                  "type" => "cursor",
                  "participant_session_id" => @participant_id,
                  "display_name" => "Ada",
                  "x" => 1,
                  "y" => 2,
                  "occurred_at" => "2026-07-29T12:00:00Z"
                }},
               state
             )

    assert {:ok, ^state} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_frame,
                %{
                  "type" => "update",
                  "operation_id" => "operation-0000000001",
                  "scene_id" => @scene_id,
                  "revision" => "4",
                  "elements" => []
                }},
               state
             )
  end

  test "keeps a multipart update private until complete and fails an expired assembly" do
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    state = %{
      initial
      | phase: :live,
        identity: identity(),
        display_name: "Ada",
        scene_id: @scene_id,
        revision: 4
    }

    frame =
      JSON.encode!(%{
        "type" => "submit_update_part",
        "operation_id" => "operation-0000000001",
        "scene_id" => @scene_id,
        "sync_all" => true,
        "part" => 0,
        "part_count" => 2,
        "element_count" => 2,
        "elements" => [
          %{
            "id" => "element-1",
            "type" => "rectangle",
            "version" => 1,
            "version_nonce" => 1,
            "index" => "a0",
            "is_deleted" => false,
            "payload" => %{}
          }
        ]
      })

    assert {:ok, pending} =
             SocketWhiteboardV1.handle_in({frame, [opcode: :text]}, state)

    assert pending.multipart.operation_id == "operation-0000000001"
    assert map_size(pending.multipart.parts) == 1
    Process.cancel_timer(pending.multipart_timer)

    assert {:push, {:text, failure}, expired} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_multipart_timeout, "operation-0000000001"},
               pending
             )

    assert expired.multipart == nil
    assert expired.multipart_timer == nil

    assert JSON.decode!(failure) == %{
             "type" => "operation_error",
             "correlation_id" => "operation-0000000001",
             "operation" => "submit_update",
             "code" => "overloaded",
             "recoverable" => true,
             "message" => "Whiteboard temporarily overloaded"
           }
  end

  defp identity do
    %Identity{
      session: %SessionKey{
        tenant_id: "30000000-0000-4000-8000-000000000003",
        room_id: "40000000-0000-4000-8000-000000000004",
        session_id: "50000000-0000-4000-8000-000000000005"
      },
      participant_session_id: @participant_id,
      participant_session_generation: 1
    }
  end
end
