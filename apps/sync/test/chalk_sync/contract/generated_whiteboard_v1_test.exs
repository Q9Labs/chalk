defmodule ChalkSync.Contract.GeneratedWhiteboardV1Test do
  use ExUnit.Case, async: true

  alias ChalkSync.Contract.GeneratedWhiteboardV1

  @operation_id "operation-0000000001"
  @request_id "request-00000000001"
  @scene_id "10000000-0000-4000-8000-000000000001"
  @participant_id "20000000-0000-4000-8000-000000000002"

  test "decodes strict update and explicit clear operations" do
    element = %{
      "id" => "rectangle-1",
      "type" => "rectangle",
      "version" => 2,
      "version_nonce" => 4,
      "index" => "a0",
      "is_deleted" => false,
      "payload" => %{"x" => 10, "y" => 12}
    }

    assert {:ok, {:submit_update, update}} =
             GeneratedWhiteboardV1.decode_client_frame(%{
               "type" => "submit_update",
               "operation_id" => @operation_id,
               "scene_id" => @scene_id,
               "sync_all" => false,
               "elements" => [element]
             })

    assert update.elements == [element]

    assert {:ok, {:clear, %{operation_id: @operation_id, scene_id: @scene_id}}} =
             GeneratedWhiteboardV1.decode_client_frame(%{
               "type" => "clear",
               "operation_id" => @operation_id,
               "scene_id" => @scene_id
             })
  end

  test "rejects unknown fields and oversized batches" do
    assert {:error, :invalid_payload} =
             GeneratedWhiteboardV1.decode_client_frame(%{
               "type" => "clear",
               "operation_id" => @operation_id,
               "scene_id" => @scene_id,
               "unknown" => true
             })

    element = %{
      "id" => "rectangle-1",
      "type" => "rectangle",
      "version" => 2,
      "version_nonce" => 4,
      "index" => "a0",
      "is_deleted" => false,
      "payload" => %{}
    }

    assert {:error, :invalid_payload} =
             GeneratedWhiteboardV1.decode_client_frame(%{
               "type" => "submit_update",
               "operation_id" => @operation_id,
               "scene_id" => @scene_id,
               "sync_all" => true,
               "elements" => List.duplicate(element, 129)
             })

    assert {:ok, {:submit_update_part, part}} =
             GeneratedWhiteboardV1.decode_client_frame(%{
               "type" => "submit_update_part",
               "operation_id" => @operation_id,
               "scene_id" => @scene_id,
               "sync_all" => true,
               "part" => 1,
               "part_count" => 2,
               "element_count" => 129,
               "elements" => [element]
             })

    assert part.part == 1
    assert part.part_count == 2
    assert part.element_count == 129

    assert {:error, :invalid_payload} =
             GeneratedWhiteboardV1.decode_client_frame(%{
               "type" => "submit_update_part",
               "operation_id" => @operation_id,
               "scene_id" => @scene_id,
               "sync_all" => true,
               "part" => 2,
               "part_count" => 2,
               "element_count" => 129,
               "elements" => [element]
             })
  end

  test "validates fixed snapshot pages, capabilities, and receipts" do
    assert {:ok, {:hello, %{extensions: []}}} =
             GeneratedWhiteboardV1.decode_client_frame(%{
               "type" => "hello",
               "protocol" => "whiteboard-v1",
               "token" => "participant-token",
               "cursor" => nil
             })

    assert {:ok, {:hello, %{extensions: [%{"name" => "presentation_v1"}]}}} =
             GeneratedWhiteboardV1.decode_client_frame(%{
               "type" => "hello",
               "protocol" => "whiteboard-v1",
               "token" => "participant-token",
               "cursor" => nil,
               "extensions" => [%{"name" => "presentation_v1"}]
             })

    legacy_welcome = %{
      "type" => "welcome",
      "protocol" => "whiteboard-v1",
      "participant_id" => @participant_id,
      "participant_generation" => 1,
      "capabilities" => ["drawWhiteboard", "manageWhiteboard"],
      "participant_capabilities" => ["drawWhiteboard"],
      "scene_id" => @scene_id,
      "revision" => "7",
      "can_draw" => true
    }

    assert GeneratedWhiteboardV1.valid_server_frame?(legacy_welcome)

    assert legacy_welcome
           |> Map.put("presenting", false)
           |> GeneratedWhiteboardV1.valid_server_frame?()

    refute legacy_welcome
           |> Map.put("unexpected", true)
           |> GeneratedWhiteboardV1.valid_server_frame?()

    assert {:error, :invalid_hello} =
             GeneratedWhiteboardV1.decode_client_frame(%{
               "type" => "hello",
               "protocol" => "whiteboard-v1",
               "token" => "participant-token",
               "cursor" => nil,
               "extensions" => [%{"name" => "unknown"}]
             })

    assert GeneratedWhiteboardV1.valid_server_frame?(%{
             "type" => "presentation_updated",
             "scene_id" => @scene_id,
             "revision" => "8",
             "presenting" => false
           })

    assert {:ok, {:set_presentation, %{operation_id: @operation_id, presenting: true}}} =
             GeneratedWhiteboardV1.decode_client_frame(%{
               "type" => "set_presentation",
               "operation_id" => @operation_id,
               "presenting" => true
             })

    assert GeneratedWhiteboardV1.valid_server_frame?(%{
             "type" => "snapshot_page",
             "request_id" => @request_id,
             "scene_id" => @scene_id,
             "revision" => "7",
             "page" => 0,
             "page_count" => 1,
             "elements" => [],
             "app_state" => nil
           })

    assert GeneratedWhiteboardV1.valid_server_frame?(%{
             "type" => "commit",
             "operation_id" => @operation_id,
             "outcome" => "duplicate",
             "scene_id" => @scene_id,
             "revision" => "7"
           })

    assert GeneratedWhiteboardV1.valid_server_frame?(%{
             "type" => "update_part",
             "operation_id" => @operation_id,
             "scene_id" => @scene_id,
             "revision" => "8",
             "part" => 0,
             "part_count" => 2,
             "element_count" => 129,
             "elements" => []
           })
  end
end
