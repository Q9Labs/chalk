defmodule ChalkSync.WhiteboardV1.SocketTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.SocketWhiteboardV1

  @participant_id "20000000-0000-4000-8000-000000000002"
  @scene_id "10000000-0000-4000-8000-000000000001"

  defmodule Repository do
    def read_after(_identity, scene_id, 4) do
      {:ok,
       [
         %{
           type: :presentation,
           operation_id: "whiteboard-presentation-0001",
           scene_id: scene_id,
           revision: 5,
           presenting: true
         }
       ]}
    end
  end

  setup do
    previous = Application.get_env(:chalk_sync, :whiteboard_v1_repository)
    Application.put_env(:chalk_sync, :whiteboard_v1_repository, Repository)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :whiteboard_v1_repository, previous),
        else: Application.delete_env(:chalk_sync, :whiteboard_v1_repository)
    end)
  end

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
      episode: %EpisodeKey{
        tenant_id: "30000000-0000-4000-8000-000000000003",
        space_id: "40000000-0000-4000-8000-000000000004",
        episode_id: "50000000-0000-4000-8000-000000000005"
      },
      participant_id: @participant_id,
      participant_generation: 1
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
                  "participant_id" => @participant_id,
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

  test "delivers presentation frames only to negotiated sockets" do
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    legacy = %{
      initial
      | phase: :live,
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        presentation_negotiated: false
    }

    frame = %{
      "type" => "presentation_updated",
      "scene_id" => @scene_id,
      "revision" => "5",
      "presenting" => true
    }

    assert {:ok, ^legacy} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, legacy)

    negotiated = %{legacy | presentation_negotiated: true}

    assert {:push, {:text, encoded}, advanced} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, negotiated)

    assert JSON.decode!(encoded) == frame
    assert advanced.revision == 5
  end

  test "repairs a missed presentation notification from the durable head" do
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    state = %{
      initial
      | phase: :live,
        identity: identity(),
        scene_id: @scene_id,
        revision: 4,
        presentation_negotiated: true
    }

    assert {:push, {:text, encoded}, repaired} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_head, @scene_id, 5},
               state
             )

    assert JSON.decode!(encoded) == %{
             "type" => "presentation_updated",
             "scene_id" => @scene_id,
             "revision" => "5",
             "presenting" => true
           }

    assert repaired.revision == 5

    legacy = %{state | presentation_negotiated: false}

    assert {:push, {:text, legacy_encoded}, _legacy_repair} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_head, @scene_id, 5},
               legacy
             )

    assert JSON.decode!(legacy_encoded) == %{
             "type" => "reset_required",
             "scene_id" => @scene_id,
             "reason" => "gap"
           }
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
      episode: %EpisodeKey{
        tenant_id: "30000000-0000-4000-8000-000000000003",
        space_id: "40000000-0000-4000-8000-000000000004",
        episode_id: "50000000-0000-4000-8000-000000000005"
      },
      participant_id: @participant_id,
      participant_generation: 1
    }
  end
end
