defmodule ChalkSync.Presenting.RepositoryTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.Presenting.Housekeeping
  alias ChalkSync.Presenting.Repository
  alias ChalkSync.ProtocolV1
  alias ChalkSync.UUID

  setup %{connections: connections} do
    connection = hd(connections)

    fixture =
      ChalkSync.SyncPostgres.seed_episode(connection, 3, %{}, %{
        participants: [
          %{role: "owner"},
          %{role: "collaborator", capabilities: ["subscribe"]},
          %{role: "collaborator"}
        ]
      })

    on_exit(fn ->
      cleanup_presenting(connection, fixture.episode)
      ChalkSync.SyncPostgres.cleanup(connection, fixture.episode)
    end)

    {:ok,
     connection: connection,
     host: hd(fixture.identities),
     participant: Enum.at(fixture.identities, 1),
     presenter: List.last(fixture.identities)}
  end

  test "presenters add ordered documents, drive page and zoom, and reconnect state survives",
       ctx do
    first = attachment(ctx)
    second = attachment(ctx)

    assert {:error, "forbidden"} =
             Repository.command(ctx.participant, frame("present", first))

    assert {:ok, %{"kind" => "accepted", "revision" => 1}} =
             Repository.command(ctx.host, frame("present", first))

    assert {:ok, %{"kind" => "accepted", "revision" => 2}} =
             Repository.command(ctx.host, frame("present", second))

    assert {:ok, %{revision: 2, documents: [one, two]}} = Repository.read(ctx.participant)
    assert [first, second] == [one.document_id, two.document_id]
    assert one.page == 1
    assert one.zoom == 100

    assert {:ok, %{"kind" => "accepted", "revision" => 3}} =
             Repository.command(
               ctx.host,
               command(%{
                 "kind" => "set_state",
                 "document_id" => first,
                 "page" => 3,
                 "zoom" => 150
               })
             )

    assert {:ok, %{revision: 3, documents: [updated, _]}} = Repository.read(ctx.host)
    assert updated.page == 3
    assert updated.zoom == 150
  end

  test "only the presenter drives state, while stopScreenOthers can stop the document", ctx do
    document = attachment(ctx)

    assert {:ok, _} = Repository.command(ctx.presenter, frame("present", document))

    assert {:error, "forbidden"} =
             Repository.command(
               ctx.host,
               command(%{"kind" => "set_state", "document_id" => document, "page" => 2})
             )

    assert {:error, "not_active"} =
             Repository.command(
               %{ctx.presenter | participant_generation: 2},
               command(%{"kind" => "stop", "document_id" => document})
             )

    assert {:error, "forbidden"} =
             Repository.command(
               ctx.participant,
               command(%{"kind" => "stop", "document_id" => document})
             )

    assert {:ok, %{"kind" => "accepted"}} =
             Repository.command(ctx.host, command(%{"kind" => "stop", "document_id" => document}))

    assert {:ok, %{documents: []}} = Repository.read(ctx.host)
  end

  test "operation ids are idempotent and conflicts are rejected", ctx do
    document = attachment(ctx)
    operation = frame("present", document)
    assert {:ok, {:presenting, ^operation}} = ProtocolV1.decode(JSON.encode!(operation))
    assert {:ok, %{"revision" => 1}} = Repository.command(ctx.host, operation)
    assert {:ok, %{"revision" => 1}} = Repository.command(ctx.host, operation)

    conflict = put_in(operation["command"]["document_id"], UUID.generate())
    assert {:error, "operation_id_conflict"} = Repository.command(ctx.host, conflict)
  end

  test "present rejects an attachment that does not belong to the episode", ctx do
    assert {:error, "invalid_target"} =
             Repository.command(ctx.host, frame("present", UUID.generate()))

    foreign = ChalkSync.SyncPostgres.seed_episode(ctx.connection, 1)

    on_exit(fn ->
      cleanup_presenting(ctx.connection, foreign.episode)
      ChalkSync.SyncPostgres.cleanup(ctx.connection, foreign.episode)
    end)

    foreign_document = attachment(%{connection: ctx.connection, host: hd(foreign.identities)})

    assert {:error, "invalid_target"} =
             Repository.command(ctx.host, frame("present", foreign_document))

    assert {:ok, %{documents: []}} = Repository.read(ctx.host)
  end

  test "expired operation receipts are swept and fresh receipts stay", ctx do
    first = frame("present", attachment(ctx))
    second = frame("present", attachment(ctx))
    assert {:ok, %{"revision" => 1}} = Repository.command(ctx.host, first)
    assert {:ok, %{"revision" => 2}} = Repository.command(ctx.host, second)

    params = [
      UUID.dump!(ctx.host.episode.tenant_id),
      UUID.dump!(ctx.host.episode.space_id),
      UUID.dump!(ctx.host.episode.episode_id),
      Base.decode16!(String.replace(first["operation_id"], "-", ""), case: :lower)
    ]

    Postgrex.query!(
      ctx.connection,
      """
      update sync_presenting_receipts set expires_at_ms = 1
      where tenant_id = $1 and space_id = $2 and episode_id = $3 and operation_id = $4
      """,
      params
    )

    assert :ok = Housekeeping.sweep(ctx.connection)

    assert %{rows: [[1]]} =
             Postgrex.query!(
               ctx.connection,
               "select count(*) from sync_presenting_receipts where tenant_id = $1 and space_id = $2 and episode_id = $3",
               Enum.take(params, 3)
             )
  end

  test "the wire validator rejects extra fields and invalid page state", _ctx do
    valid = command(%{"kind" => "set_state", "document_id" => UUID.generate(), "page" => 2})
    assert {:ok, {:presenting, ^valid}} = ProtocolV1.decode(JSON.encode!(valid))

    assert {:error, :invalid_presenting_frame} =
             ProtocolV1.decode(JSON.encode!(Map.put(valid, "extra", true)))

    invalid = put_in(valid["command"]["page"], 0)
    assert {:error, :invalid_presenting_frame} = ProtocolV1.decode(JSON.encode!(invalid))
  end

  defp attachment(ctx, document \\ UUID.generate()) do
    identity = ctx.host

    Postgrex.query!(
      ctx.connection,
      """
      insert into presenting_documents (
        tenant_id, space_id, episode_id, document_id, attachment_id,
        created_by_participant_id, created_by_participant_generation,
        file_name, mime_type, byte_length, source_object_key, source_sha256, status
      ) values (
        $1, $2, $3, $4, $5,
        $6, $7,
        'document.pdf', 'application/pdf', 1024, $8, $9, 'preparing'
      )
      """,
      [
        UUID.dump!(identity.episode.tenant_id),
        UUID.dump!(identity.episode.space_id),
        UUID.dump!(identity.episode.episode_id),
        UUID.dump!(document),
        UUID.dump!(UUID.generate()),
        UUID.dump!(identity.participant_id),
        identity.participant_generation,
        "presenting-test/#{document}",
        <<1::256>>
      ]
    )

    document
  end

  defp frame(kind, document_id) do
    command(%{"kind" => kind, "document_id" => document_id})
  end

  defp command(command) do
    %{
      "type" => "presenting_command",
      "operation_id" => operation_id(System.system_time(:millisecond)),
      "command" => command
    }
  end

  defp operation_id(time_ms) do
    nonce = UUID.generate() |> String.replace("-", "")

    timestamp =
      time_ms |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(12, "0")

    "#{String.slice(timestamp, 0, 8)}-#{String.slice(timestamp, 8, 4)}-7#{String.slice(nonce, 0, 3)}-8#{String.slice(nonce, 3, 3)}-#{String.slice(nonce, 6, 12)}"
  end

  defp cleanup_presenting(connection, episode) do
    params = [UUID.dump!(episode.tenant_id), UUID.dump!(episode.space_id)]

    for table <- [
          "presenting_documents",
          "sync_presenting_receipts",
          "sync_presenting_documents",
          "sync_presenting_states"
        ] do
      Postgrex.query!(
        connection,
        "delete from #{table} where tenant_id = $1 and space_id = $2",
        params
      )
    end
  end
end
