defmodule ChalkSync.WhiteboardV1.PostgresRepositoryFileReferenceTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.WhiteboardV1.PostgresRepository

  test "an image reference commits only once its scene's file has been finalized", %{
    connection: connection,
    host: host
  } do
    assert {:ok, %{scene_id: scene_id}} = PostgresRepository.connect(host)

    image =
      element("uploaded-image", 1, 20)
      |> Map.put("type", "image")
      |> Map.update!("payload", &Map.merge(&1, %{"fileId" => "frame", "status" => "saved"}))

    update = %{
      operation_id: "whiteboard-image-reference-1",
      scene_id: scene_id,
      elements: [image]
    }

    assert {:error, :invalid_payload} = PostgresRepository.commit_update(host, update)
    assert {:ok, %{revision: 0, elements: []}} = PostgresRepository.snapshot(host)

    file_params = [
      uuid(host.episode.tenant_id),
      uuid(host.episode.space_id),
      uuid(host.episode.episode_id),
      uuid(scene_id),
      uuid(host.participant_id),
      host.participant_generation
    ]

    Postgrex.query!(
      connection,
      """
      insert into sync_whiteboard_files(
        upload_id, tenant_id, space_id, episode_id, scene_id, participant_id, participant_generation,
        file_id, object_key, mime_type, byte_length, sha256, status, immutable_object_identity, expires_at, finalized_at
      )
      values (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6,
        'frame', gen_random_uuid()::text, 'image/png', 100, decode(repeat('00', 32), 'hex'),
        'ready', 'immutable', now() + interval '1 day', now()
      )
      """,
      file_params
    )

    assert {:ok, %{revision: 1}} = PostgresRepository.commit_update(host, update)
    assert {:ok, %{revision: 1, elements: [^image]}} = PostgresRepository.snapshot(host)

    assert %{rows: [[true]]} =
             Postgrex.query!(
               connection,
               """
               select referenced_at is not null from sync_whiteboard_files
               where tenant_id = $1 and space_id = $2 and scene_id = $3 and file_id = 'frame'
               """,
               [uuid(host.episode.tenant_id), uuid(host.episode.space_id), uuid(scene_id)]
             )
  end
end
