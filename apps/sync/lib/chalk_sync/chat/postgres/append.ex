defmodule ChalkSync.Chat.Postgres.Append do
  @moduledoc """
  Appends a chat message in one transaction: idempotent replay, rate and attachment checks, insert.
  """

  alias ChalkSync.Chat.Postgres.Append.Checks
  alias ChalkSync.Chat.Postgres.Store
  alias ChalkSync.Chat.Postgres.Store
  alias ChalkSync.Chat.Repository.Message
  alias ChalkSync.Chat.Repository.SQL
  alias ChalkSync.Database
  alias ChalkSync.Database.TransactionSettings
  alias ChalkSync.UUID

  @transaction_timeout_ms TransactionSettings.transaction_timeout_ms()

  def append_transaction(identity, input, fingerprint) do
    Postgrex.transaction(
      Database.connection(identity.episode),
      fn connection -> append_in_transaction(connection, identity, input, fingerprint) end,
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync chat append"
    )
  end

  defp append_in_transaction(connection, identity, input, fingerprint) do
    Store.configure_transaction(connection)

    case Store.select_idempotent(connection, identity, input.client_message_id) do
      nil ->
        append_after_authorization(connection, identity, input, fingerprint)

      existing ->
        idempotent_result(connection, existing, fingerprint)
    end
  end

  defp append_after_authorization(connection, identity, input, fingerprint) do
    with {:ok, profile} <- Store.lock_authority(connection, identity),
         :ok <- Store.require_capability(profile, "sendChat"),
         :ok <- Checks.early_checks(connection, identity, input) do
      params = Store.space_params(identity.episode)
      Postgrex.query!(connection, SQL.insert_stream(), params)

      [[head_sequence, _floor, _count, _bytes]] =
        Postgrex.query!(connection, SQL.lock_stream(), params).rows

      append_after_stream_lock(
        connection,
        identity,
        profile.display_name,
        input,
        fingerprint,
        head_sequence
      )
    else
      {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp append_after_stream_lock(
         connection,
         identity,
         display_name,
         input,
         fingerprint,
         head_sequence
       ) do
    case Store.select_idempotent(connection, identity, input.client_message_id) do
      nil ->
        Checks.observe(input, :attachment_commit_observer)

        case Checks.attachments(
               connection,
               identity,
               input.attachment_ids,
               SQL.lock_attachments()
             ) do
          {:ok, attachments} ->
            append_new_message(
              connection,
              identity,
              display_name,
              input,
              attachments,
              fingerprint,
              head_sequence + 1
            )

          {:error, reason} ->
            Postgrex.rollback(connection, {:error, reason})
        end

      existing ->
        idempotent_result(connection, existing, fingerprint)
    end
  end

  defp idempotent_result(_connection, {message, fingerprint}, fingerprint) do
    %{outcome: :duplicate, message: message}
  end

  defp idempotent_result(connection, {_message, _other_fingerprint}, _fingerprint) do
    Postgrex.rollback(connection, {:error, :client_message_id_conflict})
  end

  defp append_new_message(
         connection,
         identity,
         display_name,
         input,
         attachments,
         fingerprint,
         sequence
       ) do
    [[now]] = Postgrex.query!(connection, SQL.database_now(), []).rows

    message = %{
      message_id: UUID.generate(),
      client_message_id: input.client_message_id,
      sequence: Integer.to_string(sequence),
      participant_id: identity.participant_id,
      display_name: display_name,
      text: input.text,
      attachments: attachments,
      created_at: now |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    }

    encoded_bytes = Message.encoded_bytes(message)
    params = Store.space_params(identity.episode)

    with :ok <- Checks.within_person_caps(connection, identity, encoded_bytes),
         [[^sequence]] <-
           Postgrex.query!(connection, SQL.reserve_message(), params ++ [sequence, encoded_bytes]).rows do
      insert_message(connection, identity, message, fingerprint, encoded_bytes, sequence)
      attach_files(connection, identity, message, sequence)
      %{outcome: :committed, message: message}
    else
      {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
      [] -> Postgrex.rollback(connection, {:error, :overloaded})
    end
  end

  defp insert_message(connection, identity, message, fingerprint, encoded_bytes, sequence) do
    Postgrex.query!(
      connection,
      SQL.insert_message(),
      Store.episode_params(identity.episode) ++
        [
          sequence,
          Store.uuid(message.message_id),
          Store.uuid(identity.participant_id),
          identity.participant_generation,
          message.client_message_id,
          fingerprint,
          message.display_name,
          message.text,
          encoded_bytes,
          Message.iso_datetime(message.created_at)
        ]
    )
  end

  defp attach_files(connection, identity, message, sequence) do
    message.attachments
    |> Enum.with_index()
    |> Enum.each(fn {attachment, ordinal} ->
      rows =
        Postgrex.query!(
          connection,
          SQL.attach_message_files(),
          Store.episode_params(identity.episode) ++
            [
              sequence,
              ordinal,
              Message.iso_datetime(message.created_at),
              Store.uuid(attachment.attachment_id),
              Store.uuid(identity.participant_id),
              identity.participant_generation
            ]
        ).rows

      if rows == [], do: Postgrex.rollback(connection, {:error, :attachment_not_ready})
    end)
  end

  def resolve_uncertain_append(identity, client_message_id, fingerprint) do
    Database.guard(
      fn ->
        connection = Database.alternate_connection(identity.episode)

        case Store.select_idempotent(connection, identity, client_message_id) do
          {message, ^fingerprint} -> {:ok, %{outcome: :duplicate, message: message}}
          {_message, _other_fingerprint} -> {:error, :client_message_id_conflict}
          nil -> {:error, :dependency_unavailable}
        end
      end,
      {:error, :dependency_unavailable}
    )
  end
end
