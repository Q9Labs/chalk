defmodule ChalkSync.WhiteboardV1.PostgresRepositoryReceiptsTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.PostgresRepository

  test "persists stable receipts, scene epochs, and drawing permissions", %{
    host: host,
    participant: participant
  } do
    assert {:ok,
            %{
              scene_id: scene_id,
              revision: 0,
              capabilities: ["drawWhiteboard", "manageWhiteboard"],
              participant_capabilities: ["drawWhiteboard", "manageWhiteboard"],
              can_draw: true,
              is_presenting: false
            }} =
             PostgresRepository.connect(host)

    assert {:ok,
            %{
              capabilities: [],
              participant_capabilities: [],
              can_draw: false
            }} = PostgresRepository.connect(participant)

    update = %{
      operation_id: "whiteboard-update-0001",
      scene_id: scene_id,
      elements: [element("shape-1", 1, 20)]
    }

    assert {:ok, %{outcome: :committed, revision: 1, scene_id: ^scene_id}} =
             PostgresRepository.commit_update(host, update)

    assert {:ok,
            [
              %{
                operation_id: "whiteboard-update-0001",
                revision: 1,
                scene_id: ^scene_id
              }
            ]} = PostgresRepository.read_after(participant, scene_id, 0)

    assert {:ok, %{outcome: :duplicate, revision: 1, scene_id: ^scene_id}} =
             PostgresRepository.commit_update(host, update)

    conflicting = %{update | elements: [element("shape-1", 2, 19)]}
    assert {:error, :operation_id_conflict} = PostgresRepository.commit_update(host, conflicting)

    assert {:ok, %{revision: 1, elements: [stored]}} = PostgresRepository.snapshot(participant)
    assert stored["id"] == "shape-1"
    assert stored["version"] == 1

    permission = %{
      operation_id: "whiteboard-permission-0001",
      participant_id: participant.participant_id,
      can_draw: false
    }

    assert {:ok, %{outcome: :committed, revision: 1}} =
             PostgresRepository.set_draw_permission(host, permission)

    denied_update = %{
      operation_id: "whiteboard-update-0002",
      scene_id: scene_id,
      elements: [element("shape-2", 1, 30)]
    }

    assert {:error, :permission_denied} =
             PostgresRepository.commit_update(participant, denied_update)

    presentation = %{operation_id: "whiteboard-presentation-0001", presenting: true}

    assert {:ok, %{outcome: :committed, scene_id: ^scene_id, revision: 2}} =
             PostgresRepository.set_presentation(host, presentation)

    presenter_id = host.participant_id

    assert {:ok, %{is_presenting: true, presenter_id: ^presenter_id}} =
             PostgresRepository.connect(participant)

    assert {:ok, %{outcome: :duplicate, revision: 2, presenting: true}} =
             PostgresRepository.set_presentation(host, presentation)

    second_update = %{denied_update | operation_id: "whiteboard-update-0003"}

    assert {:ok, %{outcome: :committed, revision: 3}} =
             PostgresRepository.commit_update(host, second_update)

    assert {:ok,
            [
              %{type: :presentation, revision: 2, presenting: true, presenter_id: ^presenter_id},
              %{type: :update, revision: 3}
            ]} = PostgresRepository.read_after(participant, scene_id, 1)

    clear = %{operation_id: "whiteboard-clear-0001", scene_id: scene_id}

    assert {:ok, %{outcome: :committed, scene_id: new_scene_id, revision: 0}} =
             PostgresRepository.clear(host, clear)

    assert new_scene_id != scene_id
    assert {:ok, %{presenter_id: ^presenter_id}} = PostgresRepository.connect(participant)

    assert {:ok, %{outcome: :committed}} =
             PostgresRepository.set_presentation(host, %{
               operation_id: "whiteboard-presentation-stop",
               presenting: false
             })

    assert {:ok, %{is_presenting: false, presenter_id: nil}} =
             PostgresRepository.connect(participant)

    assert {:ok, %{outcome: :committed}} =
             PostgresRepository.set_presentation(host, %{
               operation_id: "whiteboard-presentation-reopen",
               presenting: true
             })

    assert {:error, :stale_scene} = PostgresRepository.commit_update(host, denied_update)

    assert {:ok, %{scene_id: ^new_scene_id, revision: 2, elements: [], is_presenting: true}} =
             PostgresRepository.snapshot(host)
  end

  test "large periodic resends retain only scene changes and allow later strokes", %{
    connection: connection,
    host: host,
    participant: participant
  } do
    {:ok, %{scene_id: scene_id}} = PostgresRepository.connect(host)
    elements = Enum.map(1..200, &handwriting_element/1)
    assert byte_size(JSON.encode!(elements)) > 262_144

    elements
    |> Enum.chunk_every(20)
    |> Enum.with_index(1)
    |> Enum.each(fn {batch, index} ->
      assert {:ok, %{revision: ^index}} =
               PostgresRepository.commit_update(host, %{
                 operation_id: "handwriting-batch-#{index}",
                 scene_id: scene_id,
                 elements: batch
               })
    end)

    resend = %{operation_id: "handwriting-full-resend", scene_id: scene_id, elements: elements}

    assert {:ok, %{"revision" => "11"}, [empty_frame]} = Episode.submit_update(host, resend)
    assert empty_frame["elements"] == []
    assert GeneratedWhiteboardV1.valid_server_frame?(empty_frame)
    assert {:ok, [^empty_frame]} = Episode.read_after(participant, scene_id, 10)

    assert {:ok, [%{revision: 11, elements: []}]} =
             PostgresRepository.read_after(participant, scene_id, 10)

    assert [[2]] =
             Postgrex.query!(
               connection,
               """
               select event_encoded_bytes from sync_whiteboard_operation_receipts
               where participant_id = $1 and operation_id = $2
               """,
               [uuid(host.participant_id), resend.operation_id]
             ).rows

    assert {:ok, %{outcome: :duplicate, revision: 11}} =
             PostgresRepository.commit_update(host, resend)

    [first, second | rest] = elements
    edit = %{first | "version" => 2}
    deletion = %{second | "version" => 2, "is_deleted" => true}
    stroke = handwriting_element(201)

    mixed = %{
      resend
      | operation_id: "handwriting-mixed-update",
        elements: [edit, deletion | rest] ++ [stroke]
    }

    assert {:ok, %{revision: 12}} = PostgresRepository.commit_update(host, mixed)

    assert {:ok, [%{elements: [^edit, ^deletion, ^stroke]}]} =
             PostgresRepository.read_after(participant, scene_id, 11)

    losing = %{
      resend
      | operation_id: "handwriting-losing-update",
        elements: [first, %{edit | "version_nonce" => 100}]
    }

    assert {:ok, %{revision: 13}} = PostgresRepository.commit_update(host, losing)
    assert {:ok, [%{elements: []}]} = PostgresRepository.read_after(participant, scene_id, 12)
    assert {:ok, %{revision: 13, elements: stored}} = PostgresRepository.snapshot(participant)
    assert length(stored) == 201
    assert edit in stored
    assert deletion in stored
    assert stroke in stored
  end

  test "accepts genuinely changed multipart-sized handwriting events", %{
    connection: connection,
    host: host,
    participant: participant
  } do
    {:ok, %{scene_id: scene_id}} = PostgresRepository.connect(host)
    elements = Enum.map(1..200, &handwriting_element/1)
    bytes = byte_size(JSON.encode!(elements))
    assert bytes > 262_144
    assert bytes < 16_777_216

    update = %{operation_id: "handwriting-large-change", scene_id: scene_id, elements: elements}
    assert {:ok, %{revision: 1}} = PostgresRepository.commit_update(host, update)

    assert {:ok, [%{elements: ^elements}]} =
             PostgresRepository.read_after(participant, scene_id, 0)

    assert [[^bytes]] =
             Postgrex.query!(
               connection,
               """
               select event_encoded_bytes from sync_whiteboard_operation_receipts
               where participant_id = $1 and operation_id = $2
               """,
               [uuid(host.participant_id), update.operation_id]
             ).rows

    assert bytes * 3 > 2_097_152

    Enum.each(2..3, fn version ->
      changed = Enum.map(elements, &Map.put(&1, "version", version))

      assert {:ok, %{revision: ^version}} =
               PostgresRepository.commit_update(host, %{
                 update
                 | operation_id: "handwriting-large-change-#{version}",
                   elements: changed
               })
    end)

    assert {:error, :cursor_reset_required} =
             PostgresRepository.read_after(participant, scene_id, 0)

    assert {:ok, [%{revision: 3}]} = PostgresRepository.read_after(participant, scene_id, 2)
    assert {:ok, %{revision: 3, elements: stored}} = PostgresRepository.snapshot(participant)
    assert length(stored) == 200
    assert Enum.all?(stored, &(&1["version"] == 3))
  end

  defp handwriting_element(index) do
    points = Enum.map(1..150, fn point -> [point / 3, :math.sin(point / 5) * 20] end)

    %{
      "id" => "handwriting-#{index}",
      "type" => "freedraw",
      "version" => 1,
      "version_nonce" => 20,
      "index" => "a#{index}",
      "is_deleted" => false,
      "payload" => %{"x" => index * 10, "y" => 20, "points" => points}
    }
  end
end
