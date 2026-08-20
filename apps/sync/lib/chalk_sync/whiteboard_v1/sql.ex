defmodule ChalkSync.WhiteboardV1.SQL do
  @moduledoc false

  def transaction_settings do
    """
    select
      set_config('lock_timeout', '750ms', true),
      set_config('statement_timeout', '2s', true),
      set_config('synchronous_commit', 'on', true)
    """
  end

  def lock_authority do
    """
    select
      participant.role,
      participant.capabilities,
      coalesce(permission.can_draw, 'drawWhiteboard' = any(participant.capabilities)) as can_draw
    from participants participant
    join episodes episode
      on episode.tenant_id = participant.tenant_id
      and episode.space_id = participant.space_id
      and episode.id = participant.episode_id
    left join sync_whiteboard_permissions permission
      on permission.tenant_id = participant.tenant_id
      and permission.episode_id = participant.episode_id
      and permission.participant_id = participant.id
    where participant.tenant_id = $1
      and participant.space_id = $2
      and participant.episode_id = $3
      and participant.id = $4
      and participant.generation = $5
      and participant.status = 'active'
      and episode.status = 'active'
    for update of participant
    """
  end

  def ensure_scene do
    """
    insert into sync_whiteboard_scenes (
      tenant_id, space_id, episode_id, scene_id
    )
    select $1, $2, $3, $4
    where not exists (
      select 1
      from sync_whiteboard_scenes
      where tenant_id = $1 and space_id = $2 and episode_id = $3 and is_current
    ) and $3::uuid is not null
    on conflict do nothing
    """
  end

  def lock_scene do
    """
    select scene_id, revision, app_state, coalesce(presenting_episode_id = $3, false) as is_presenting
    from sync_whiteboard_scenes
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and is_current
    for update
    """
  end

  def select_receipt do
    """
    select request_fingerprint, scene_id, revision, event_presenting
    from sync_whiteboard_operation_receipts
    where tenant_id = $1 and space_id = $2
      and participant_id = $3 and operation_id = $4
    """
  end

  def upsert_element do
    """
    insert into sync_whiteboard_elements (
      tenant_id, space_id, episode_id, scene_id,
      element_id, element_type, version, version_nonce,
      element_index, is_deleted, payload, encoded_bytes
    ) values (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10, $11, $12
    )
    on conflict (tenant_id, space_id, scene_id, element_id)
    do update set
      element_type = excluded.element_type,
      version = excluded.version,
      version_nonce = excluded.version_nonce,
      element_index = excluded.element_index,
      is_deleted = excluded.is_deleted,
      payload = excluded.payload,
      encoded_bytes = excluded.encoded_bytes,
      updated_at = now()
    where excluded.version > sync_whiteboard_elements.version
       or (
         excluded.version = sync_whiteboard_elements.version
         and excluded.version_nonce < sync_whiteboard_elements.version_nonce
       )
    """
  end

  def update_scene_head do
    """
    update sync_whiteboard_scenes scene
    set
      revision = revision + 1,
      element_count = aggregate.element_count,
      encoded_bytes = aggregate.encoded_bytes,
      updated_at = now()
    from (
      select count(*)::integer as element_count, coalesce(sum(encoded_bytes), 0)::bigint as encoded_bytes
      from sync_whiteboard_elements
      where tenant_id = $1 and space_id = $2 and scene_id = $4
    ) aggregate
    where scene.tenant_id = $1
      and scene.space_id = $2
      and $3::uuid is not null
      and scene.scene_id = $4
      and aggregate.element_count <= 10000
      and aggregate.encoded_bytes <= 67108864
    returning scene.revision, aggregate.element_count, aggregate.encoded_bytes
    """
  end

  def insert_receipt do
    """
    insert into sync_whiteboard_operation_receipts (
      tenant_id, space_id, episode_id,
      participant_id, submitted_generation,
      operation_id, request_fingerprint, operation_name,
      outcome, scene_id, revision, event_elements, event_presenting, event_encoded_bytes
    ) values (
      $1, $2, $3,
      $4, $5,
      $6, $7, $8,
      'committed', $9, $10, $11, $12, $13
    )
    """
  end

  def retire_scene do
    """
    update sync_whiteboard_scenes
    set is_current = false, updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and scene_id = $4 and is_current
    """
  end

  def insert_scene do
    """
    insert into sync_whiteboard_scenes (
      tenant_id, space_id, episode_id, scene_id, is_current, presenting_episode_id, revision
    ) select $1, $2, $3, $4, true, case when $5 then $3::uuid else null end, 0 where $3::uuid is not null
    """
  end

  def update_presentation do
    """
    update sync_whiteboard_scenes
    set
      presenting_episode_id = case when $5 then $3::uuid else null end,
      revision = revision + 1,
      updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and scene_id = $4 and is_current
    returning revision, coalesce(presenting_episode_id = $3, false) as is_presenting
    """
  end

  def upsert_permission do
    """
    insert into sync_whiteboard_permissions (
      tenant_id, space_id, episode_id,
      participant_id, can_draw, granted_by_participant_id
    )
    select $1, $2, $3, $4, $5, $6
    from participants
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and id = $4 and status = 'active'
    on conflict (tenant_id, space_id, participant_id)
    do update set
      can_draw = excluded.can_draw,
      granted_by_participant_id = excluded.granted_by_participant_id,
      updated_at = now()
    returning participant_id
    """
  end

  def snapshot_elements do
    """
    select
      element_id, element_type, version, version_nonce,
      element_index, is_deleted, payload
    from sync_whiteboard_elements
    where tenant_id = $1 and space_id = $2 and scene_id = $3
    order by element_index, element_id
    limit 10001
    """
  end

  def read_after do
    """
    select operation_name, operation_id, scene_id, revision, event_elements, event_presenting
    from sync_whiteboard_operation_receipts
    where tenant_id = $1 and episode_id = $2 and scene_id = $3 and revision > $4
      and operation_name in ('submit_update', 'set_presentation')
    order by revision
    limit 129
    """
  end

  def notify_head, do: "select pg_notify('chalk_whiteboard_v1_heads', $1)"
end
