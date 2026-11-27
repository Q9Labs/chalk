defmodule ChalkSync.Presenting.RepositoryFixtures do
  @moduledoc false

  alias ChalkSync.UUID

  def attachment(ctx, document \\ UUID.generate(), status \\ "preparing") do
    identity = ctx.host

    Postgrex.query!(
      ctx.connection,
      """
      insert into presenting_documents (
        tenant_id, space_id, episode_id, document_id, attachment_id,
        created_by_participant_id, created_by_participant_generation,
        file_name, mime_type, byte_length, source_object_key, source_sha256, status, failure_code
      ) values (
        $1, $2, $3, $4, $5,
        $6, $7,
        'document.pdf', 'application/pdf', 1024, $8, $9, $10, case when $10 = 'failed' then 'render_failed' else null end
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
        <<1::256>>,
        status
      ]
    )

    document
  end

  def frame(kind, document_id) do
    command(%{"kind" => kind, "document_id" => document_id})
  end

  def command(command) do
    %{
      "type" => "presenting_command",
      "operation_id" => operation_id(System.system_time(:millisecond)),
      "command" => command
    }
  end

  def operation_id(time_ms) do
    nonce = UUID.generate() |> String.replace("-", "")

    timestamp =
      time_ms |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(12, "0")

    "#{String.slice(timestamp, 0, 8)}-#{String.slice(timestamp, 8, 4)}-7#{String.slice(nonce, 0, 3)}-8#{String.slice(nonce, 3, 3)}-#{String.slice(nonce, 6, 12)}"
  end

  def cleanup_presenting(connection, episode) do
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
