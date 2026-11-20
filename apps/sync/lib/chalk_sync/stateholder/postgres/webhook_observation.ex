defmodule ChalkSync.Stateholder.Postgres.WebhookObservation do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Obs
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.OperationTable
  alias ChalkSync.Stateholder.Postgres.ExternalOperationClaims
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Telemetry
  alias ChalkSync.UUID
  alias ChalkSync.Webhooks.SQL, as: WebhookSQL
  require OperationTable

  def participant_object([
        id,
        identity_id,
        space_id,
        episode_id,
        name,
        status,
        joined_at,
        left_at,
        updated_at
      ]) do
    %{
      id: UUID.load!(id),
      identity_id: Scope.nullable_uuid(identity_id),
      space_id: UUID.load!(space_id),
      episode_id: UUID.load!(episode_id),
      name: name,
      status: status,
      joined_at: joined_at,
      left_at: left_at,
      updated_at: updated_at
    }
  end

  def external_operation(
        episode,
        external_operation_id,
        %{result: :applied, delivery: :original}
      ) do
    Database.guard(
      fn ->
        case ExternalOperationClaims.read_operation(episode, external_operation_id) do
          {:ok, %{name: name} = operation}
          when name in [
                 :remove_participant,
                 :participant_leave,
                 :end_episode,
                 :tenant_end_episode,
                 :maximum_duration_expired
               ] ->
            event_name = external_webhook_event_name(name)

            observe_webhook_production(
              episode,
              "sync_external:#{operation.external_operation_id}:#{event_name}",
              "external_operation"
            )

            observe_episode_end(episode, name, operation.external_operation_id)

          _ ->
            :ok
        end
      end,
      :ok
    )
  end

  def external_operation(_episode, _external_operation_id, _decision), do: :ok

  def lifecycle(
        episode,
        lifecycle_intent_id,
        %{result: :applied, event: %{name: event_name}}
      )
      when event_name in ["participant_joined", "participant_left", "episode_ended"] do
    webhook_event_name = lifecycle_webhook_event_name(event_name)

    observe_webhook_production(
      episode,
      "sync_lifecycle:#{lifecycle_intent_id}:#{webhook_event_name}",
      "lifecycle_intent"
    )
  end

  def lifecycle(_episode, _lifecycle_intent_id, _decision), do: :ok

  # The Episode row is the one record of why a call ended, whichever operation
  # ended it. Only the finalizing call finds the row ended.
  defp observe_episode_end(episode, name, external_operation_id) do
    if OperationTable.is_episode_end_name(name),
      do: observe_ended_row(episode, external_operation_id),
      else: :ok
  end

  defp ended_context(nil, _trace_id, _span_id), do: nil

  defp ended_context(journey_id, trace_id, span_id),
    do: Observability.persisted_context(UUID.load!(journey_id), trace_id, span_id)

  @doc """
  Records the Episode's authoritative end as the registry fact sync.episode.ended, which diagnose reads as the end every
  seat's end screen is judged against (observability/rules/end.wrong_screen.mjs).
  """
  def record_episode_ended(episode, end_reason) do
    Obs.fact("sync.episode.ended", %{
      tenant_id: episode.tenant_id,
      space_id: episode.space_id,
      episode_id: episode.episode_id,
      end_reason: end_reason
    })
  end

  defp observe_ended_row(episode, external_operation_id) do
    Database.guard(
      fn ->
        case Postgrex.query(
               Database.alternate_connection(episode),
               """
               select episodes.end_reason, operations.journey_id, operations.producing_trace_id,
                      operations.producing_span_id
               from episodes
               join sync_external_operations operations
                 on operations.tenant_id = episodes.tenant_id
                and operations.episode_id = episodes.id
                and operations.external_operation_id = $4
               where episodes.tenant_id = $1 and episodes.space_id = $2 and episodes.id = $3
                 and episodes.status = 'ended'
               """,
               [
                 Scope.uuid(episode.tenant_id),
                 Scope.uuid(episode.space_id),
                 Scope.uuid(episode.episode_id),
                 Scope.uuid(external_operation_id)
               ],
               timeout: 1_000
             ) do
          {:ok, %{rows: [[end_reason, journey_id, trace_id, span_id]]}}
          when is_binary(end_reason) ->
            Observability.linked_phase(
              ended_context(journey_id, trace_id, span_id),
              "sync.episode.ended",
              %{
                episode_id: episode.episode_id,
                end_reason: end_reason
              }
            )

            record_episode_ended(episode, end_reason)

          _ ->
            :ok
        end
      end,
      :ok
    )
  end

  defp observe_webhook_production(episode, transition_key, transition) do
    Database.guard(
      fn ->
        departure_prefix =
          if String.ends_with?(transition_key, ":episode.ended"),
            do: "episode_end:#{episode.episode_id}:participant:",
            else: ""

        case Postgrex.query(
               Database.alternate_connection(episode),
               WebhookSQL.production_summary(),
               [Scope.uuid(episode.tenant_id), transition_key, departure_prefix],
               timeout: 1_000
             ) do
          {:ok, %{rows: rows}} ->
            Enum.each(rows, &emit_webhook_observation(&1, transition))

          _ ->
            :ok
        end
      end,
      :ok
    )
  end

  defp emit_webhook_observation(
         [event_name, api_version, journey_id, trace_id, span_id, delivery_count],
         transition
       ) do
    context = Observability.persisted_context(UUID.load!(journey_id), trace_id, span_id)

    attributes = %{
      api_version: api_version,
      event_name: event_name,
      producer: "sync",
      transition: transition
    }

    Observability.linked_phase(context, "sync.webhook.production.committed", attributes)

    Observability.linked_phase(context, "sync.webhook.fanout.queued", %{
      api_version: api_version,
      delivery_count: delivery_count,
      event_name: event_name,
      producer: "sync",
      transition: transition
    })

    Telemetry.execute(
      [:webhook, :production],
      %{count: 1},
      %{api_version: api_version, event_name: event_name, outcome: :committed}
    )

    Telemetry.execute(
      [:webhook, :fanout],
      %{count: delivery_count},
      %{api_version: api_version, event_name: event_name, outcome: :queued}
    )
  end

  defp external_webhook_event_name(name)
       when name in [:remove_participant, :participant_leave],
       do: "participant.left"

  defp external_webhook_event_name(name)
       when OperationTable.is_episode_end_name(name),
       do: "episode.ended"

  defp lifecycle_webhook_event_name("participant_joined"), do: "participant.joined"
  defp lifecycle_webhook_event_name("participant_left"), do: "participant.left"
  defp lifecycle_webhook_event_name("episode_ended"), do: "episode.ended"
end
