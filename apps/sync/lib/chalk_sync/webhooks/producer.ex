defmodule ChalkSync.Webhooks.Producer do
  @moduledoc false

  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID
  alias ChalkSync.Webhooks.Event
  alias ChalkSync.Webhooks.SQL

  @spec produce(term(), SessionKey.t(), map(), map()) :: :ok
  def produce(connection, %SessionKey{} = session, intent, object) do
    source = %{
      transition_key: "sync_lifecycle:#{intent.id}:#{webhook_event_name(intent.name)}",
      event_name: webhook_event_name(intent.name),
      journey_id: intent.journey_id,
      parent_journey_event_id: intent.parent_journey_event_id,
      producing_trace_id: intent.producing_trace_id,
      producing_span_id: intent.producing_span_id
    }

    produce_source(connection, session, source, object)
  end

  @spec produce_external(term(), SessionKey.t(), map(), map(), map()) :: :ok
  def produce_external(connection, %SessionKey{} = session, external, event, object)
      when event.name in ["participant_left", "host_left_and_transferred", "session_ended"] do
    event_name = webhook_event_name(event.name)

    source = %{
      transition_key: "sync_external:#{external.external_operation_id}:#{event_name}",
      event_name: event_name,
      journey_id: Map.get(external, :journey_id),
      parent_journey_event_id: Map.get(external, :parent_journey_event_id),
      producing_trace_id: Map.get(external, :producing_trace_id),
      producing_span_id: Map.get(external, :producing_span_id)
    }

    produce_source(connection, session, source, object)
  end

  def produce_external(_connection, %SessionKey{}, _external, _event, _object), do: :ok

  defp produce_source(connection, session, source, object) do
    event_name = source.event_name
    tenant_id = UUID.dump!(session.tenant_id)
    Postgrex.query!(connection, SQL.ensure_tenant_state(), [tenant_id])
    [[^tenant_id]] = Postgrex.query!(connection, SQL.lock_tenant_state(), [tenant_id]).rows

    revisions =
      Postgrex.query!(connection, SQL.matching_revisions(), [tenant_id, event_name]).rows

    produce_versions(connection, session, source, object, event_name, revisions)
  end

  defp produce_versions(connection, session, intent, object, event_name, revisions) do
    revisions
    |> Enum.group_by(fn [_revision_id, _endpoint_id, _revision, api_version] -> api_version end)
    |> Enum.each(fn {api_version, version_revisions} ->
      produce_version(
        connection,
        session,
        intent,
        object,
        event_name,
        api_version,
        version_revisions
      )
    end)
  end

  defp produce_version(connection, session, intent, object, event_name, 1, revisions) do
    event_id = UUID.generate()
    occurred_at = event_name |> occurred_at(object) |> Event.normalize_timestamp!()
    body = Event.encode!(event_id, event_name, session.tenant_id, occurred_at, object)
    journey_id = intent.journey_id || UUID.generate()
    event_journey_id = UUID.generate()
    transition_key = intent.transition_key

    params = [
      UUID.dump!(event_id),
      UUID.dump!(session.tenant_id),
      event_name,
      1,
      occurred_at,
      body,
      :crypto.hash(:sha256, body),
      transition_key,
      resource_type(event_name),
      UUID.dump!(object.id),
      nullable_uuid(Map.get(object, :user_id)),
      UUID.dump!(journey_id),
      nullable_uuid(journey_parent(intent)),
      intent.producing_trace_id,
      intent.producing_span_id
    ]

    case Postgrex.query!(connection, SQL.insert_event(), params).rows do
      [[_id]] ->
        sequence = next_journey_sequence(connection, journey_id)

        insert_journey_event(connection, %{
          id: event_journey_id,
          journey_id: journey_id,
          sequence: sequence,
          occurred_at: occurred_at,
          name: "webhook.event.committed",
          phase: "persistence",
          state: "committed",
          origin_kind: origin_kind(intent),
          visibility: upstream_visibility(intent),
          parent_id: journey_parent(intent),
          trace_id: intent.producing_trace_id,
          span_id: intent.producing_span_id,
          attributes: %{"api_version" => 1, "event" => event_name, "webhook_event_id" => event_id}
        })

        insert_deliveries(
          connection,
          session,
          revisions,
          event_id,
          %{
            event_journey_id: event_journey_id,
            journey_id: journey_id,
            occurred_at: occurred_at,
            first_sequence: sequence + 1,
            source: intent
          }
        )

      [] ->
        :ok
    end
  end

  defp insert_deliveries(
         connection,
         session,
         revisions,
         event_id,
         context
       ) do
    Enum.with_index(revisions, context.first_sequence)
    |> Enum.each(fn {revision, sequence} ->
      [revision_id, endpoint_id, revision_number, _api_version] = revision
      delivery_id = UUID.generate()
      queued_journey_event_id = UUID.generate()

      Postgrex.query!(connection, SQL.insert_delivery(), [
        UUID.dump!(delivery_id),
        UUID.dump!(session.tenant_id),
        UUID.dump!(event_id),
        endpoint_id,
        revision_id,
        revision_number,
        context.occurred_at,
        UUID.dump!(queued_journey_event_id)
      ])

      insert_journey_event(connection, %{
        id: queued_journey_event_id,
        journey_id: context.journey_id,
        sequence: sequence,
        occurred_at: context.occurred_at,
        name: "webhook.delivery.queued",
        phase: "delivery",
        state: "queued",
        origin_kind: origin_kind(context.source),
        visibility: upstream_visibility(context.source),
        parent_id: context.event_journey_id,
        trace_id: context.source.producing_trace_id,
        span_id: context.source.producing_span_id,
        attributes: %{"delivery_id" => delivery_id, "endpoint_id" => UUID.load!(endpoint_id)}
      })
    end)
  end

  defp next_journey_sequence(connection, journey_id) do
    [[sequence]] =
      Postgrex.query!(connection, SQL.next_journey_sequence(), [UUID.dump!(journey_id)]).rows

    sequence
  end

  defp insert_journey_event(connection, event) do
    Postgrex.query!(connection, SQL.insert_journey_event(), [
      UUID.dump!(event.id),
      UUID.dump!(event.journey_id),
      event.sequence,
      event.occurred_at,
      event.name,
      event.phase,
      event.state,
      event.origin_kind,
      event.visibility,
      nullable_uuid(event.parent_id),
      event.trace_id,
      event.span_id,
      event.attributes
    ])
  end

  defp webhook_event_name("participant_joined"), do: "participant.joined"
  defp webhook_event_name("participant_left"), do: "participant.left"
  defp webhook_event_name("host_left_and_transferred"), do: "participant.left"
  defp webhook_event_name("session_ended"), do: "session.ended"

  defp occurred_at("participant.joined", object), do: object.joined_at
  defp occurred_at("participant.left", object), do: object.left_at
  defp occurred_at("session.ended", object), do: object.ended_at

  defp resource_type(event_name) when event_name in ["participant.joined", "participant.left"],
    do: "participant"

  defp resource_type("session.ended"), do: "session"

  defp upstream_visibility(%{journey_id: nil}), do: "unknown"
  defp upstream_visibility(_intent), do: "visible"

  defp origin_kind(%{journey_id: nil}), do: "background_worker"
  defp origin_kind(_intent), do: "server"

  defp journey_parent(%{journey_id: nil}), do: nil
  defp journey_parent(intent), do: intent.parent_journey_event_id

  defp nullable_uuid(nil), do: nil
  defp nullable_uuid(value) when is_binary(value), do: UUID.dump!(value)
end
