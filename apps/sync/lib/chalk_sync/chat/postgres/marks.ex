defmodule ChalkSync.Chat.Postgres.Marks do
  @moduledoc """
  Read receipts and reactions: one transaction each under the Episode authority lock.
  """

  alias ChalkSync.Chat.Postgres.Store
  alias ChalkSync.Chat.Repository.Reactions
  alias ChalkSync.Chat.Repository.SQL
  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.Database
  alias ChalkSync.Database.TransactionSettings

  @transaction_timeout_ms TransactionSettings.transaction_timeout_ms()

  def record_read(identity, sequence) do
    case Integer.parse(sequence) do
      {parsed, ""} when parsed > 0 ->
        Postgrex.transaction(
          Database.connection(identity.episode),
          fn connection -> mark_read_transaction(connection, identity, parsed) end,
          timeout: @transaction_timeout_ms,
          commit_comment: "chalk sync chat read receipt"
        )
        |> Store.transaction_result()

      _ ->
        {:error, :invalid_payload}
    end
  end


  def set_reaction(identity, input) do
    case GeneratedV1.decode_client_frame(%{
           "type" => "chat_reaction_set",
           "request_id" => input.request_id,
           "message_id" => input.message_id,
           "emoji" => input.emoji,
           "on" => input.on
         }) do
      {:ok, _decoded} ->
        Postgrex.transaction(
          Database.connection(identity.episode),
          fn connection -> react_transaction(connection, identity, input) end,
          timeout: @transaction_timeout_ms,
          commit_comment: "chalk sync chat reaction"
        )
        |> Store.transaction_result()

      _ ->
        {:error, :invalid_payload}
    end
  end


  defp react_transaction(connection, identity, input) do
    Store.configure_transaction(connection)

    with {:ok, profile} <- Store.lock_authority(connection, identity),
         :ok <- Store.require_capability(profile, "sendChat") do
      Postgrex.query!(connection, SQL.lock_stream(), Store.space_params(identity.episode))
      Reactions.set(connection, identity, input)
    else
      {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
    end
  end


  defp mark_read_transaction(connection, identity, sequence) do
    Store.configure_transaction(connection)

    case Store.lock_authority(connection, identity) do
      {:ok, _profile} ->
        case Postgrex.query!(
               connection,
               SQL.lock_stream_for_read(),
               Store.space_params(identity.episode)
             ).rows do
          [[head, _floor]] when sequence <= head ->
            upsert_receipt(connection, identity, sequence)

          _ ->
            Postgrex.rollback(connection, {:error, :invalid_payload})
        end

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end


  defp upsert_receipt(connection, identity, sequence) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    params =
      Store.episode_params(identity.episode) ++
        [
          Store.uuid(identity.participant_id),
          identity.participant_generation,
          sequence,
          now
        ]

    case Postgrex.query!(connection, SQL.upsert_read_receipt(), params).rows do
      [row] ->
        %{outcome: :advanced, receipt: Store.receipt(row)}

      [] ->
        existing_params =
          Store.episode_params(identity.episode) ++
            [Store.uuid(identity.participant_id), identity.participant_generation]

        [row] = Postgrex.query!(connection, SQL.read_participant_receipt(), existing_params).rows
        %{outcome: :unchanged, receipt: Store.receipt(row)}
    end
  end
end
