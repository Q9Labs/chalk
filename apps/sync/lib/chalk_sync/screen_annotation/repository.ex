defmodule ChalkSync.ScreenAnnotation.Repository do
  @moduledoc "Transactional publication, generation, draw-policy and fence authority for screen annotations."

  alias ChalkSync.Contract.GeneratedScreenAnnotationV1, as: Schema
  alias ChalkSync.Observability
  alias ChalkSync.Database
  alias ChalkSync.ScreenAnnotation.{Layer, Protocol, SQL}
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.PostgresRepository.{Mutations, Store}
  alias ChalkSync.WhiteboardV1.SQL, as: WhiteboardSQL

  @limits Schema.limits()
  @max_actor_receipts 240

  def read(identity) do
    case read(Database.connection(identity.episode), identity) do
      {:ok, actor, share, layer, now} ->
        {:ok, actor, valid_layer(layer, share, now), now, share}

      failure ->
        failure
    end
  end

  def command(identity, frame, context \\ nil) do
    Store.transaction(identity, fn connection ->
      params = Store.context(identity)

      with %{rows: [["active"]]} <- Postgrex.query!(connection, SQL.lock_episode(), params),
           {:ok, _authority, _scene} <- Store.locked_scene(connection, identity) do
        Postgrex.query!(connection, SQL.lock_publication_head(), params)
        Postgrex.query!(connection, SQL.lock_lease(), params)
        Postgrex.query!(connection, SQL.lock_layer(), params)
        commit(connection, identity, frame, context)
      else
        _ -> {:error, "not_active"}
      end
    end)
  end

  defp read(connection, identity) do
    params =
      Store.context(identity) ++
        [Store.uuid(identity.participant_id), identity.participant_generation]

    case Postgrex.query(connection, SQL.read(), params, log: nil) do
      {:ok, %{rows: [row]}} -> decode(row, identity)
      {:ok, %{rows: []}} -> {:error, "not_active"}
      {:error, _reason} -> {:retryable, :storage_unavailable}
    end
  end

  defp decode([name, capabilities, draw?, policy, explicit | row], identity) do
    [owner, generation, until, publication | row] = row

    [
      id,
      bound_publication,
      sharer,
      bound_generation,
      frame,
      revision,
      fence,
      paused,
      marks,
      requests,
      history,
      last_change,
      now
    ] = row

    actor = %{
      id: identity.participant_id,
      generation: identity.participant_generation,
      author: Layer.contributor(identity.participant_id, name),
      manager: "manageWhiteboard" in capabilities,
      can_draw: draw?,
      draw_policy: policy,
      explicit_grant: explicit
    }

    share =
      if is_binary(publication) and is_binary(owner) and
           generation_matches?(publication, generation) do
        %{owner: owner, generation: generation, publication: publication, until: until}
      end

    layer =
      if id do
        %{
          binding: %{
            "layer_id" => id,
            "publication_id" => bound_publication,
            "sharer_id" => sharer,
            "frame" => frame
          },
          generation: bound_generation,
          revision: revision,
          fence: fence,
          paused: paused,
          marks: marks,
          requests: requests,
          history: history,
          last_change: last_change
        }
      end

    {:ok, actor, share, layer, now}
  end

  # The provider's v1 publication reference is the generation witness. A legacy
  # reference may still be played, but cannot prove ownership for annotation.
  defp generation_matches?("chalk_pub_v1." <> encoded, generation) do
    with {:ok, payload} <- Base.url_decode64(encoded, padding: false),
         {:ok, %{"g" => ^generation, "c" => connection, "t" => track, "m" => mid}} <-
           JSON.decode(payload) do
      Enum.all?([connection, track, mid], &(is_binary(&1) and &1 != ""))
    else
      _ -> false
    end
  end

  defp generation_matches?(_publication, _generation), do: false

  defp valid_layer(
         %{
           binding: %{"publication_id" => publication, "sharer_id" => owner},
           generation: generation
         } = layer,
         %{publication: publication, owner: owner, generation: generation},
         now
       ),
       do: Layer.prune(layer, now)

  defp valid_layer(_layer, _share, _now), do: nil

  defp commit(connection, identity, frame, context) do
    with {:ok, actor, share, stored, now} <- read(connection, identity),
         {:ok, expires} <- Protocol.operation_time(frame, now) do
      layer = valid_layer(stored, share, now)
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

  defp bind(connection, identity, state, actor, bind) do
    with %{owner: owner, generation: generation, publication: publication} <- state.share,
         true <-
           owner == actor.id and generation == actor.generation and
             publication == bind["publication_id"] do
      if state.layer do
        {:ok, accepted(state.layer)}
      else
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
              publication,
              Store.uuid(owner),
              generation,
              bind["frame"],
              trace.producing_trace_id,
              trace.producing_span_id
            ],
          log: nil
        )

        {:ok, %{"kind" => "accepted", "layer_id" => id, "revision" => 1}}
      end
    else
      _ -> {:error, "invalid_target"}
    end
  end

  defp mutate(_connection, _identity, nil, _actor, _frame, _command, _now, _expires),
    do: {:error, "stale_layer"}

  defp mutate(connection, identity, layer, actor, frame, command, now, expires) do
    layer_id = layer.binding["layer_id"]

    if frame["layer_id"] == layer_id do
      {:ok, operation_bytes} = Protocol.operation_bytes(frame["operation_id"])

      key = [
        Store.uuid(layer_id),
        Store.uuid(actor.id),
        actor.generation,
        operation_bytes
      ]

      fingerprint = Store.fingerprint(Map.take(frame, ["layer_id", "fence", "command"]))

      case Postgrex.query!(connection, SQL.receipt(), key, log: nil).rows do
        [[^fingerprint, revision]] ->
          {:ok, %{"kind" => "accepted", "layer_id" => layer_id, "revision" => revision}}

        [[_different, _revision]] ->
          {:error, "operation_id_conflict"}

        [] ->
          with true <- frame["fence"] == layer.fence,
               :ok <- receipt_capacity(connection, key, command, actor, layer, now),
               {:ok, next} <- transition(connection, identity, layer, command, actor, now) do
            Postgrex.query!(
              connection,
              SQL.store_receipt(),
              key ++ [fingerprint, next.revision, expires],
              log: nil
            )

            {:ok, accepted(next)}
          else
            false -> {:error, "stale_fence"}
            failure -> failure
          end
      end
    else
      {:error, "stale_layer"}
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
        if actor.draw_policy == policy do
          {:ok, layer}
        else
          Postgrex.query!(
            connection,
            WhiteboardSQL.upsert_draw_policy(),
            Store.context(identity) ++ [policy, Store.uuid(actor.id)],
            log: nil
          )

          with :ok <- Store.notify_access(connection, identity) do
            after_access_write(connection, identity)
          end
        end

      failure ->
        failure
    end
  end

  defp validate_grant("hosts"), do: {:error, "forbidden"}
  defp validate_grant(_policy), do: :ok

  defp after_access_write(connection, identity) do
    with {:ok, _actor, share, layer, now} <- read(connection, identity),
         %{} = layer <- valid_layer(layer, share, now),
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
