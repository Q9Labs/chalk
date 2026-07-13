defmodule ChalkSync.Webhooks.SQL do
  @moduledoc false

  def ensure_tenant_state do
    "insert into webhook_tenant_state (tenant_id) values ($1) on conflict (tenant_id) do nothing"
  end

  def lock_tenant_state do
    "select tenant_id from webhook_tenant_state where tenant_id = $1 for update"
  end

  def matching_revisions do
    """
    select revision.id, revision.endpoint_id, revision.revision, revision.api_version
    from webhook_endpoints endpoint
    join webhook_endpoint_revisions revision
      on revision.tenant_id = endpoint.tenant_id
      and revision.endpoint_id = endpoint.id
      and revision.revision = endpoint.current_target_revision
    where endpoint.tenant_id = $1
      and endpoint.enabled
      and endpoint.deleted_at is null
      and $2 = any(revision.event_types)
    order by revision.api_version, endpoint.id
    """
  end

  def insert_event do
    """
    insert into webhook_events (
      id, tenant_id, event_name, api_version, occurred_at, body, body_sha256,
      semantic_transition_key, resource_type, resource_id, linked_user_id,
      journey_id, parent_journey_event_id, producing_trace_id, producing_span_id
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    on conflict (tenant_id, semantic_transition_key, api_version) do nothing
    returning id
    """
  end

  def insert_delivery do
    """
    insert into webhook_deliveries (
      id, tenant_id, event_id, endpoint_id, endpoint_revision_id,
      endpoint_revision, state, next_attempt_at, queued_journey_event_id
    ) values ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
    """
  end

  def next_journey_sequence do
    "select coalesce(max(sequence), -1) + 1 from observability_journey_events where journey_id = $1"
  end

  def insert_journey_event do
    """
    insert into observability_journey_events (
      event_id, journey_id, sequence, occurred_at, name, phase, state,
      origin_kind, first_observed_layer, upstream_visibility, parent_event_id,
      trace_id, span_id, attributes
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'sync', $9, $10, $11, $12, $13)
    """
  end

  def production_summary do
    """
    select
      event.event_name,
      event.api_version,
      event.journey_id,
      event.producing_trace_id,
      event.producing_span_id,
      count(delivery.id)
    from webhook_events event
    left join webhook_deliveries delivery
      on delivery.tenant_id = event.tenant_id and delivery.event_id = event.id
    where event.tenant_id = $1 and event.semantic_transition_key = $2
    group by
      event.event_name,
      event.api_version,
      event.journey_id,
      event.producing_trace_id,
      event.producing_span_id
    """
  end
end
