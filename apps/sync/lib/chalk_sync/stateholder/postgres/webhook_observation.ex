defmodule ChalkSync.Stateholder.Postgres.WebhookObservation do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.Postgres.ExternalOperationClaims
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Telemetry
  alias ChalkSync.UUID
  alias ChalkSync.Webhooks.SQL, as: WebhookSQL

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

      _ ->
        :ok
    end
  rescue
    _exception -> :ok
  catch
    :exit, _reason -> :ok
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

  defp observe_webhook_production(episode, transition_key, transition) do
    case Postgrex.query(
           Database.connection(episode, 1),
           WebhookSQL.production_summary(),
           [Scope.uuid(episode.tenant_id), transition_key],
           timeout: 1_000
         ) do
      {:ok, %{rows: rows}} ->
        Enum.each(rows, &emit_webhook_observation(&1, transition))

      _ ->
        :ok
    end
  rescue
    _exception -> :ok
  catch
    :exit, _reason -> :ok
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
       when name in [:end_episode, :tenant_end_episode, :maximum_duration_expired],
       do: "episode.ended"

  defp lifecycle_webhook_event_name("participant_joined"), do: "participant.joined"
  defp lifecycle_webhook_event_name("participant_left"), do: "participant.left"
  defp lifecycle_webhook_event_name("episode_ended"), do: "episode.ended"
end
