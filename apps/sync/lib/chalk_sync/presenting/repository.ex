defmodule ChalkSync.Presenting.Repository do
  @moduledoc "Transactional per-Episode Stage Document authority."

  alias ChalkSync.Contract.GeneratedPresentingV1, as: Schema
  alias ChalkSync.Database
  alias ChalkSync.Presenting.Protocol
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.PostgresRepository.Store

  @limits Schema.limits()

  def read(identity) do
    connection = Database.connection(identity.episode)
    params = context(identity)

    with {:ok, %{rows: rows}} <- Postgrex.query(connection, state_sql(), params, log: nil),
         {:ok, %{rows: documents}} <-
           Postgrex.query(connection, documents_sql(), params, log: nil) do
      revision =
        case rows do
          [[revision]] -> revision
          [] -> 0
        end

      {:ok, %{revision: revision, documents: Enum.map(documents, &document/1)}}
    else
      _ -> {:retryable, :storage_unavailable}
    end
  end

  def command(identity, frame) do
    Store.transaction(identity, fn connection ->
      params = context(identity)

      with %{rows: [["active"]]} <- Postgrex.query!(connection, lock_episode_sql(), params),
           %{rows: [[_capabilities]]} <-
             Postgrex.query!(
               connection,
               lock_participant_sql(),
               params ++ [uuid(identity.participant_id), identity.participant_generation]
             ) do
        Postgrex.query!(connection, ensure_state_sql(), params, log: nil)
        Postgrex.query!(connection, lock_state_sql(), params, log: nil)
        commit(connection, identity, frame)
      else
        _ -> {:error, "not_active"}
      end
    end)
  end

  defp commit(connection, identity, frame) do
    with {:ok, expires} <- Protocol.operation_time(frame, System.system_time(:millisecond)),
         {:ok, operation_bytes} <- Protocol.operation_bytes(frame["operation_id"]),
         {:ok, actor} <- actor(connection, identity),
         {:ok, state} <- locked_state(connection, identity) do
      key =
        context(identity) ++
          [uuid(identity.participant_id), identity.participant_generation, operation_bytes]

      fingerprint = Store.fingerprint(frame["command"])

      case Postgrex.query!(connection, receipt_sql(), key, log: nil).rows do
        [[^fingerprint, revision]] ->
          {:ok, %{"kind" => "accepted", "revision" => revision}}

        [[_different, _revision]] ->
          {:error, "operation_id_conflict"}

        [] ->
          write_command(connection, identity, state, actor, frame, %{
            key: key,
            fingerprint: fingerprint,
            expires: expires
          })
      end
    else
      {:error, reason} when is_binary(reason) -> {:error, reason}
      _ -> {:error, "invalid_target"}
    end
  end

  defp write_command(connection, identity, state, actor, frame, operation) do
    case apply_command(state, actor, frame["command"]) do
      {:ok, documents} ->
        revision = state.revision + 1
        params = context(identity)
        Postgrex.query!(connection, update_revision_sql(), params ++ [revision], log: nil)
        Postgrex.query!(connection, delete_documents_sql(), params, log: nil)

        Enum.with_index(documents, 1)
        |> Enum.each(fn {document, position} ->
          Postgrex.query!(
            connection,
            insert_document_sql(),
            params ++
              [
                uuid(document.document_id),
                uuid(document.presenter_id),
                document.presenter_generation,
                position,
                document.page,
                document.zoom,
                document.started_at_ms
              ],
            log: nil
          )
        end)

        Postgrex.query!(
          connection,
          insert_receipt_sql(),
          operation.key ++ [operation.fingerprint, revision, operation.expires],
          log: nil
        )

        {:ok, %{"kind" => "accepted", "revision" => revision}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp apply_command(state, actor, %{"kind" => "present", "document_id" => document_id}) do
    cond do
      not actor.can_present ->
        {:error, "forbidden"}

      Enum.any?(state.documents, &(&1.document_id == document_id)) ->
        {:ok, state.documents}

      length(state.documents) >= @limits["maxDocuments"] ->
        {:error, "capacity"}

      true ->
        document = %{
          document_id: document_id,
          presenter_id: actor.id,
          presenter_generation: actor.generation,
          page: 1,
          zoom: 100,
          started_at_ms: System.system_time(:millisecond)
        }

        {:ok, state.documents ++ [document]}
    end
  end

  defp apply_command(
         state,
         actor,
         %{"kind" => "set_state", "document_id" => document_id} = command
       ) do
    case Enum.find_index(state.documents, &(&1.document_id == document_id)) do
      nil ->
        {:error, "invalid_target"}

      index ->
        document = Enum.at(state.documents, index)

        if document.presenter_id == actor.id and document.presenter_generation == actor.generation do
          page = Map.get(command, "page", document.page)
          zoom = Map.get(command, "zoom", document.zoom)
          {:ok, List.replace_at(state.documents, index, %{document | page: page, zoom: zoom})}
        else
          {:error, "forbidden"}
        end
    end
  end

  defp apply_command(state, actor, %{"kind" => "stop", "document_id" => document_id}) do
    case Enum.find(state.documents, &(&1.document_id == document_id)) do
      nil ->
        {:ok, state.documents}

      document ->
        own =
          document.presenter_id == actor.id and document.presenter_generation == actor.generation

        if own or actor.can_stop_others do
          {:ok, Enum.reject(state.documents, &(&1.document_id == document_id))}
        else
          {:error, "forbidden"}
        end
    end
  end

  defp actor(connection, identity) do
    case Postgrex.query!(
           connection,
           actor_sql(),
           context(identity) ++ [uuid(identity.participant_id), identity.participant_generation],
           log: nil
         ).rows do
      [[capabilities]] ->
        {:ok,
         %{
           id: identity.participant_id,
           generation: identity.participant_generation,
           can_present: "publishScreen" in capabilities,
           can_stop_others: "stopScreenOthers" in capabilities
         }}

      [] ->
        {:error, "not_active"}
    end
  end

  defp locked_state(connection, identity) do
    with {:ok, %{rows: [[revision]]}} <-
           Postgrex.query(connection, lock_state_sql(), context(identity), log: nil),
         {:ok, %{rows: rows}} <-
           Postgrex.query(connection, documents_sql(), context(identity), log: nil) do
      {:ok, %{revision: revision, documents: Enum.map(rows, &document/1)}}
    else
      _ -> {:error, "invalid_state"}
    end
  end

  defp document([document_id, presenter_id, presenter_generation, page, zoom, started_at_ms]) do
    %{
      document_id: UUID.load!(document_id),
      presenter_id: UUID.load!(presenter_id),
      presenter_generation: presenter_generation,
      page: page,
      zoom: zoom,
      started_at_ms: started_at_ms
    }
  end

  defp state_sql,
    do:
      "select revision from sync_presenting_states where tenant_id = $1 and space_id = $2 and episode_id = $3"

  defp lock_state_sql, do: state_sql() <> " for update"

  defp ensure_state_sql,
    do:
      "insert into sync_presenting_states (tenant_id, space_id, episode_id) values ($1, $2, $3) on conflict do nothing"

  defp update_revision_sql,
    do:
      "update sync_presenting_states set revision = $4 where tenant_id = $1 and space_id = $2 and episode_id = $3"

  defp delete_documents_sql,
    do:
      "delete from sync_presenting_documents where tenant_id = $1 and space_id = $2 and episode_id = $3"

  defp documents_sql do
    """
    select document_id, presenter_id, presenter_generation, page, zoom, started_at_ms
    from sync_presenting_documents
    where tenant_id = $1 and space_id = $2 and episode_id = $3
    order by position
    """
  end

  defp insert_document_sql do
    """
    insert into sync_presenting_documents
      (tenant_id, space_id, episode_id, document_id, presenter_id, presenter_generation, position, page, zoom, started_at_ms)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    """
  end

  defp lock_episode_sql do
    """
    select status from episodes
    where tenant_id = $1 and space_id = $2 and id = $3
    for no key update
    """
  end

  defp lock_participant_sql do
    """
    select capabilities from participants
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4 and generation = $5 and status = 'active'
    for no key update
    """
  end

  defp actor_sql do
    """
    select capabilities from participants
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4 and generation = $5 and status = 'active'
    """
  end

  defp receipt_sql do
    """
    select fingerprint, revision from sync_presenting_receipts
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and actor_id = $4 and actor_generation = $5 and operation_id = $6
    """
  end

  defp insert_receipt_sql do
    """
    insert into sync_presenting_receipts
      (tenant_id, space_id, episode_id, actor_id, actor_generation, operation_id, fingerprint, revision, expires_at_ms)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    """
  end

  defp context(identity),
    do: [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.episode.episode_id)
    ]

  defp uuid(value), do: UUID.dump!(value)
end
