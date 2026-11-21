defmodule ChalkSync.ScreenAnnotation.Repository do
  @moduledoc "Transactional publication, generation, draw-policy and fence authority for screen annotations."

  alias ChalkSync.Contract.GeneratedScreenAnnotationV1, as: Schema
  alias ChalkSync.Database
  alias ChalkSync.Observability
  alias ChalkSync.ScreenAnnotation.{Attachment, Authority, Layer, Protocol, SQL}
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.PostgresRepository.{Mutations, Store}
  alias ChalkSync.WhiteboardV1.SQL, as: WhiteboardSQL

  @limits Schema.limits()
  @max_actor_receipts 240

  def read(identity) do
    case Authority.read(Database.connection(identity.episode), identity) do
      {:ok, actor, share, layer, now} ->
        {:ok, actor, Authority.valid_layer(layer, share, now), now, share}

      failure ->
        failure
    end
  end

  def command(identity, frame, context \\ nil, attachment \\ nil) do
    Store.transaction(identity, fn connection ->
      params = Store.context(identity)

      with %{rows: [["active"]]} <- Postgrex.query!(connection, SQL.lock_episode(), params),
           {:ok, _authority, _scene} <- Store.locked_scene(connection, identity) do
        Postgrex.query!(connection, SQL.lock_publication_head(), params)
        Postgrex.query!(connection, SQL.lock_lease(), params)
        Postgrex.query!(connection, SQL.lock_layer(), params)
        commit(connection, identity, frame, context, attachment)
      else
        _ -> {:error, "not_active"}
      end
    end)
  end

  defp commit(connection, identity, frame, context, attachment) do
    with {:ok, actor, share, stored, now} <- Authority.read(connection, identity),
         {:ok, expires} <- Protocol.operation_time(frame, now),
         layer = Authority.valid_layer(stored, share, now),
         :ok <- authorize_attachment(layer, attachment, frame["command"], now) do
      actor = Map.put(actor, :operation_id, frame["operation_id"])

      case frame["command"] do
        %{"kind" => "bind"} = bind ->
          bind(
            connection,
            identity,
            %{share: share, layer: layer, stored: stored, context: context},
            actor,
            bind
          )

        command ->
          mutate(connection, identity, layer, actor, frame, command, now, expires)
      end
    end
  end

  defp authorize_attachment(_layer, nil, _command, _now), do: :ok

  defp authorize_attachment(layer, attachment, command, now) do
    if Attachment.matches?(layer, attachment, now) and Attachment.allowed_command?(command),
      do: :ok,
      else: {:error, "forbidden"}
  end

  defp bind(connection, identity, state, actor, bind) do
    with %{owner: owner, generation: generation, publication: publication} <- state.share,
         true <-
           owner == actor.id and generation == actor.generation and
             publication == bind["publication_id"] do
      store_binding(connection, identity, state, actor, bind)
    else
      _ -> {:error, "invalid_target"}
    end
  end

  defp store_binding(_connection, _identity, %{layer: %{} = layer}, _actor, _bind),
    do: {:ok, accepted(layer)}

  defp store_binding(connection, identity, state, actor, bind) do
    params = Store.context(identity)
    id = UUID.generate()
    trace = Observability.observed_operation_context(state.context)

    if state.stored, do: Postgrex.query!(connection, SQL.delete_layer(), params, log: nil)

    Postgrex.query!(
      connection,
      SQL.create_layer(),
      params ++
        [
          Store.uuid(id),
          state.share.publication,
          Store.uuid(actor.id),
          actor.generation,
          bind["frame"],
          trace.producing_trace_id,
          trace.producing_span_id
        ],
      log: nil
    )

    {:ok, %{"kind" => "accepted", "layer_id" => id, "revision" => 1}}
  end

  defp mutate(
         connection,
         identity,
         %{binding: %{"layer_id" => id}} = layer,
         actor,
         %{"layer_id" => id} = frame,
         command,
         now,
         expires
       ) do
    {:ok, operation_bytes} = Protocol.operation_bytes(frame["operation_id"])
    key = [Store.uuid(id), Store.uuid(actor.id), actor.generation, operation_bytes]
    fingerprint = Store.fingerprint(Map.take(frame, ["layer_id", "fence", "command"]))

    case Postgrex.query!(connection, SQL.receipt(), key, log: nil).rows do
      [[^fingerprint, revision]] ->
        {:ok, %{"kind" => "accepted", "layer_id" => id, "revision" => revision}}

      [[_different, _revision]] ->
        {:error, "operation_id_conflict"}

      [] ->
        write_command(connection, identity, layer, actor, command, %{
          key: key,
          fingerprint: fingerprint,
          fence: frame["fence"],
          now: now,
          expires: expires
        })
    end
  end

  defp mutate(_connection, _identity, _layer, _actor, _frame, _command, _now, _expires),
    do: {:error, "stale_layer"}

  defp write_command(connection, identity, layer, actor, command, op) do
    with true <- op.fence == layer.fence,
         :ok <- receipt_capacity(connection, op.key, command, actor, layer, op.now),
         {:ok, next} <- transition(connection, identity, layer, command, actor, op.now) do
      Postgrex.query!(
        connection,
        SQL.store_receipt(),
        op.key ++ [op.fingerprint, next.revision, op.expires], log: nil)

      {:ok, accepted(next)}
    else
      false -> {:error, "stale_fence"}
      failure -> failure
    end
  end

  defp receipt_capacity(
         connection,
         [layer_id, actor_id, generation, _operation],
         command,
         actor,
         layer,
         now
       ) do
    Postgrex.query!(connection, SQL.purge_receipts(), [layer_id, now], log: nil)

    [[total, from_actor]] =
      Postgrex.query!(connection, SQL.receipt_count(), [layer_id, actor_id, generation], log: nil).rows

    max = @limits["operationReceiptsPerLayer"]

    moderation =
      (actor.manager or actor.id == layer.binding["sharer_id"]) and
        command["kind"] in ~w(clear pause erase set_policy set_draw_permission decide_draw)

    cond do
      total >= max -> {:error, "capacity"}
      moderation -> :ok
      from_actor >= @max_actor_receipts -> {:error, "rate_limited"}
      total >= max - @limits["moderationReceiptReserve"] -> {:error, "rate_limited"}
      true -> :ok
    end
  end

  defp transition(connection, identity, layer, command, actor, now) do
    case Layer.apply(layer, command, actor, now) do
      {:ok, ^layer} ->
        {:ok, layer}

      {:ok, next} ->
        if fits?(next, actor) do
          Postgrex.query!(
            connection,
            SQL.update_layer(),
            Store.context(identity) ++
              [
                next.revision,
                next.fence,
                next.paused,
                next.marks,
                next.requests,
                next.history,
                next.last_change
              ],
            log: nil
          )

          {:ok, next}
        else
          {:error, "capacity"}
        end

      {:grant, participant_id, allow} ->
        with :ok <- validate_grant(actor.draw_policy),
             :ok <-
               Mutations.store_permission(connection, identity, actor.draw_policy, %{
                 participant_id: participant_id,
                 can_draw: allow
               }),
             :ok <- Store.notify_access(connection, identity) do
          after_access_write(connection, identity)
        end

      {:policy, policy} ->
        store_policy(connection, identity, layer, actor, policy)

      failure ->
        failure
    end
  end

  defp store_policy(_connection, _identity, layer, %{draw_policy: policy}, policy),
    do: {:ok, layer}

  defp store_policy(connection, identity, _layer, actor, policy) do
    Postgrex.query!(
      connection,
      WhiteboardSQL.upsert_draw_policy(),
      Store.context(identity) ++ [policy, Store.uuid(actor.id)],
      log: nil
    )

    with :ok <- Store.notify_access(connection, identity),
         do: after_access_write(connection, identity)
  end

  defp validate_grant("hosts"), do: {:error, "forbidden"}
  defp validate_grant(_policy), do: :ok

  defp after_access_write(connection, identity) do
    with {:ok, _actor, share, layer, now} <- Authority.read(connection, identity),
         %{} = layer <- Authority.valid_layer(layer, share, now),
         do: {:ok, layer},
         else: (_ -> {:error, "stale_layer"})
  end

  defp fits?(layer, actor) do
    # Leave room for recipient-specific access, timestamps and correlation.
    state = Layer.snapshot(layer, %{actor | manager: true})

    byte_size(JSON.encode!(state)) <= @limits["stateBytes"] - 2048 and
      byte_size(JSON.encode!(layer.history)) <= @limits["stateBytes"]
  end

  defp accepted(layer),
    do: %{
      "kind" => "accepted",
      "layer_id" => layer.binding["layer_id"],
      "revision" => layer.revision
    }
end
