defmodule ChalkSync.ScreenAnnotation.SQL do
  @moduledoc false

  alias ChalkSync.WhiteboardV1.SQL, as: Whiteboard

  def episode_status do
    "select status from episodes where tenant_id = $1 and space_id = $2 and id = $3"
  end

  def lock_episode do
    """
    select status from episodes
    where tenant_id = $1 and space_id = $2 and id = $3
    for no key update
    """
  end

  def lock_publication_head do
    """
    select sequence from provider_operation_observation_heads
    where tenant_id = $1 and episode_id = $3 and $2::uuid is not null for share
    """
  end

  def lock_lease do
    """
    select lease_id from sync_screen_share_leases
    where tenant_id = $1 and space_id = $2 and episode_id = $3 for share
    """
  end

  def read do
    """
    with actor as (#{Whiteboard.drawing_authority()}),
    screens as (
      select item->>'publication_id' as publication_id
      from provider_operation_observation_heads head
      join provider_operation_observations observation
        using (tenant_id, episode_id, incarnation, sequence)
      cross join lateral jsonb_array_elements(observation.publications) item
      where head.tenant_id = $1 and head.episode_id = $3
        and item->>'source' = 'screen' and item->>'enabled' = 'true'
        and item->>'participant_id' = (
          select owner_participant_id::text from sync_screen_share_leases
          where tenant_id = $1 and space_id = $2 and episode_id = $3
        )
        and not exists (
          select 1 from sync_media_pauses pause
          where pause.tenant_id = $1 and pause.space_id = $2 and pause.episode_id = $3
            and pause.participant_id::text = item->>'participant_id' and pause.source = 'screen'
            and pause.publication_id = item->>'publication_id'
        )
    )
    select actor.name, actor.capabilities, actor.can_draw, actor.draw_policy, actor.explicit_grant,
           lease.owner_participant_id::text, lease.owner_generation,
           (extract(epoch from least(lease.renewed_until, lease.hard_expires_at)) * 1000)::bigint,
           (select min(publication_id) from screens having count(*) = 1),
           layer.layer_id::text, layer.publication_id, layer.sharer_id::text, layer.sharer_generation,
           layer.frame, layer.revision, layer.fence, layer.paused, layer.marks,
           layer.requests, layer.history, layer.last_change,
           (extract(epoch from clock_timestamp()) * 1000)::bigint
    from actor
    left join sync_screen_share_leases lease
      on lease.tenant_id = $1 and lease.space_id = $2 and lease.episode_id = $3
      and lease.status = 'active' and least(lease.renewed_until, lease.hard_expires_at) > clock_timestamp()
    left join sync_screen_annotation_layers layer
      on layer.tenant_id = $1 and layer.space_id = $2 and layer.episode_id = $3
    """
  end

  def lock_layer do
    """
    select layer_id from sync_screen_annotation_layers
    where tenant_id = $1 and space_id = $2 and episode_id = $3 for update
    """
  end

  def create_layer do
    """
    insert into sync_screen_annotation_layers (
      tenant_id, space_id, episode_id, layer_id, publication_id, sharer_id, sharer_generation, frame,
      journey_id, parent_event_id, producing_trace_id, producing_span_id
    )
    select $1, $2, $3, $4, $5, $6, $7, $8, parent.journey_id, parent.parent_journey_event_id, $9, $10
    from (values (true)) anchor(present)
    left join lateral (
      select intent.journey_id, intent.parent_journey_event_id
      from sync_lifecycle_intents intent
      where intent.tenant_id = $1 and intent.space_id = $2 and intent.episode_id = $3
        and intent.status = 'applied' and intent.journey_id is not null
      order by intent.applied_revision asc limit 1
    ) parent on anchor.present
    """
  end

  def delete_layer do
    """
    delete from sync_screen_annotation_layers
    where tenant_id = $1 and space_id = $2 and episode_id = $3
    """
  end

  def update_layer do
    """
    update sync_screen_annotation_layers
    set revision = $4, fence = $5, paused = $6, marks = $7, requests = $8, history = $9, last_change = $10, next_expiry_at_ms = $11
    where tenant_id = $1 and space_id = $2 and episode_id = $3
    """
  end

  def receipt do
    """
    select fingerprint, revision from sync_screen_annotation_receipts
    where layer_id = $1 and participant_id = $2 and generation = $3 and operation_id = $4
    """
  end

  def purge_receipts do
    "delete from sync_screen_annotation_receipts where layer_id = $1 and expires_at_ms <= $2"
  end

  def receipt_count do
    """
    select count(*), count(*) filter (where participant_id = $2 and generation = $3)
    from sync_screen_annotation_receipts where layer_id = $1
    """
  end

  def store_receipt do
    """
    insert into sync_screen_annotation_receipts
      (layer_id, participant_id, generation, operation_id, fingerprint, revision, expires_at_ms)
    values ($1, $2, $3, $4, $5, $6, $7)
    """
  end
end
