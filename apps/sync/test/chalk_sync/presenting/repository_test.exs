defmodule ChalkSync.Presenting.RepositoryTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

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
    first = UUID.generate()
    second = UUID.generate()

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
    document = UUID.generate()

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
    document = UUID.generate()
    operation = frame("present", document)
    assert {:ok, {:presenting, ^operation}} = ProtocolV1.decode(JSON.encode!(operation))
    assert {:ok, %{"revision" => 1}} = Repository.command(ctx.host, operation)
    assert {:ok, %{"revision" => 1}} = Repository.command(ctx.host, operation)

    conflict = put_in(operation["command"]["document_id"], UUID.generate())
    assert {:error, "operation_id_conflict"} = Repository.command(ctx.host, conflict)
  end

  test "the wire validator rejects extra fields and invalid page state", _ctx do
    valid = command(%{"kind" => "set_state", "document_id" => UUID.generate(), "page" => 2})
    assert {:ok, {:presenting, ^valid}} = ProtocolV1.decode(JSON.encode!(valid))

    assert {:error, :invalid_presenting_frame} =
             ProtocolV1.decode(JSON.encode!(Map.put(valid, "extra", true)))

    invalid = put_in(valid["command"]["page"], 0)
    assert {:error, :invalid_presenting_frame} = ProtocolV1.decode(JSON.encode!(invalid))
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
