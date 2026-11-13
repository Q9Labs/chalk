-- name: InsertRecordingPresentationBaseline :one
with authority as (
    select reservations.tenant_id, reservations.space_id, reservations.episode_id,
        reservations.recording_id, spaces.name as space_name,
        control.control_revision, control.folded_state,
        coalesce(stream.head_sequence, 0)::bigint as chat_head_sequence,
        stream.retained_floor_sequence,
        least(sqlc.arg(baseline_at)::timestamptz, now()) as baseline_at
    from recording_pipelines pipelines
    join recording_reservations reservations on reservations.id = pipelines.reservation_id
    join spaces on spaces.tenant_id = reservations.tenant_id and spaces.id = reservations.space_id
    join sync_episode_control control
      on control.tenant_id = reservations.tenant_id
     and control.space_id = reservations.space_id
     and control.episode_id = reservations.episode_id
    left join sync_chat_streams stream
      on stream.tenant_id = reservations.tenant_id and stream.space_id = reservations.space_id
    where pipelines.recording_id = sqlc.arg(recording_id)
      and reservations.tenant_id = sqlc.arg(tenant_id)
      and reservations.space_id = sqlc.arg(space_id)
      and reservations.episode_id = sqlc.arg(episode_id)
), participant_snapshot as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'participant_id', participants.id,
        'generation', participants.generation,
        'status', participants.status,
        'joined_at', participants.joined_at,
        'left_at', participants.left_at
    ) order by participants.created_at, participants.id)
        filter (where participants.id is not null), '[]'::jsonb) as facts
    from authority
    left join participants
      on participants.tenant_id = authority.tenant_id
     and participants.space_id = authority.space_id
     and participants.episode_id = authority.episode_id
), whiteboard_snapshot as (
    select scene.scene_id, scene.revision,
        jsonb_build_object(
            'scene_id', scene.scene_id,
            'revision', scene.revision,
            'presenting', scene.presenting_episode_id = authority.episode_id,
            'app_state', scene.app_state,
            'elements', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', element.element_id,
                    'type', element.element_type,
                    'version', element.version,
                    'version_nonce', element.version_nonce,
                    'index', element.element_index,
                    'is_deleted', element.is_deleted,
                    'payload', element.payload
                ) order by element.element_index, element.element_id)
                from sync_whiteboard_elements element
                where element.tenant_id = scene.tenant_id
                  and element.space_id = scene.space_id
                  and element.episode_id = scene.episode_id
                  and element.scene_id = scene.scene_id), '[]'::jsonb)
        ) as snapshot
    from authority
    join sync_whiteboard_scenes scene
      on scene.tenant_id = authority.tenant_id
     and scene.space_id = authority.space_id
     and scene.episode_id = authority.episode_id
     and scene.is_current
)
insert into recording_presentation_baselines (
    presentation_handle, tenant_id, space_id, episode_id, recording_id,
    schema_version, profile_version, profile, space_name,
    episode_control_revision, episode_folded_state, participant_facts,
    chat_head_sequence, chat_retained_floor_sequence,
    whiteboard_scene_id, whiteboard_revision, whiteboard_snapshot, baseline_at
)
select sqlc.arg(presentation_handle), authority.tenant_id, authority.space_id,
    authority.episode_id, authority.recording_id, 'recording_presentation.v1',
    sqlc.arg(profile_version), sqlc.arg(profile)::jsonb, authority.space_name,
    authority.control_revision, authority.folded_state, participant_snapshot.facts,
    authority.chat_head_sequence, authority.retained_floor_sequence,
    whiteboard_snapshot.scene_id, whiteboard_snapshot.revision,
    whiteboard_snapshot.snapshot, authority.baseline_at
from authority cross join participant_snapshot left join whiteboard_snapshot on true
on conflict (recording_id) do nothing
returning *;

-- name: GetRecordingPresentationBaseline :one
select * from recording_presentation_baselines
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and episode_id = sqlc.arg(episode_id)
  and recording_id = sqlc.arg(recording_id);

-- name: InsertRecordingPresentationSource :one
with baseline as (
    select baselines.* from recording_presentation_baselines baselines
    where baselines.tenant_id = sqlc.arg(tenant_id)
      and baselines.space_id = sqlc.arg(space_id)
      and baselines.episode_id = sqlc.arg(episode_id)
      and baselines.recording_id = sqlc.arg(recording_id)
      and baselines.baseline_at <= sqlc.arg(capture_ready_at)::timestamptz
), pipeline as (
    select pipelines.recording_id
    from recording_pipelines pipelines
    where pipelines.recording_id = sqlc.arg(recording_id)
      and pipelines.tenant_id = sqlc.arg(tenant_id)
      and pipelines.capture_epoch = sqlc.arg(capture_epoch)
      and pipelines.capture_ready_at = sqlc.arg(capture_ready_at)
), control_delta as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'revision', events.revision, 'event_name', events.event_name,
        'payload', events.payload, 'created_at', events.created_at
    ) order by events.revision) filter (where events.revision is not null), '[]'::jsonb) as events,
    coalesce(max(events.revision), baseline.episode_control_revision)::bigint as end_revision
    from baseline
    left join sync_control_events events
      on events.tenant_id = baseline.tenant_id
     and events.space_id = baseline.space_id
     and events.episode_id = baseline.episode_id
     and events.revision > baseline.episode_control_revision
     and events.created_at <= sqlc.arg(capture_ready_at)
    group by baseline.episode_control_revision
), participant_snapshot as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'participant_id', participants.id,
        'generation', participants.generation,
        'status', participants.status,
        'joined_at', participants.joined_at,
        'left_at', participants.left_at
    ) order by participants.created_at, participants.id)
        filter (where participants.id is not null), '[]'::jsonb) as facts
    from baseline
    left join participants
      on participants.tenant_id = baseline.tenant_id
     and participants.space_id = baseline.space_id
     and participants.episode_id = baseline.episode_id
), chat_snapshot as (
    select coalesce(max(stream.head_sequence), 0)::bigint as head_sequence,
        max(stream.retained_floor_sequence)::bigint as retained_floor_sequence,
        coalesce(jsonb_agg(messages.body order by messages.sequence)
            filter (where messages.sequence is not null), '[]'::jsonb) as messages
    from baseline
    left join sync_chat_streams stream
      on stream.tenant_id = baseline.tenant_id and stream.space_id = baseline.space_id
    left join lateral (
        select message.sequence, jsonb_build_object(
            'message_id', message.message_id,
            'sequence', message.sequence,
            'participant_id', message.participant_id,
            'participant_generation', message.participant_generation,
            'display_name', message.display_name,
            'message_text', message.message_text,
            'created_at', message.created_at,
            'attachments', coalesce((select jsonb_agg(jsonb_build_object(
                'attachment_id', attachment.attachment_id,
                'object_key', attachment.object_key,
                'immutable_object_identity', attachment.immutable_object_identity,
                'original_filename', attachment.original_filename,
                'mime_type', attachment.mime_type,
                'byte_length', attachment.byte_length,
                'sha256', encode(attachment.sha256, 'hex')
            ) order by attachment.message_ordinal)
            from sync_chat_attachments attachment
            where attachment.tenant_id = message.tenant_id
              and attachment.space_id = message.space_id
              and attachment.message_sequence = message.sequence
              and attachment.status = 'attached'), '[]'::jsonb)
        ) as body
        from sync_chat_messages message
        where message.tenant_id = baseline.tenant_id
          and message.space_id = baseline.space_id
          and message.episode_id = baseline.episode_id
          and message.created_at <= sqlc.arg(capture_ready_at)
        order by message.sequence desc
        limit 100
    ) messages on true
), whiteboard_delta as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'operation_name', receipts.operation_name,
        'operation_id', receipts.operation_id,
        'scene_id', receipts.scene_id,
        'revision', receipts.revision,
        'elements', receipts.event_elements,
        'presenting', receipts.event_presenting,
        'completed_at', receipts.completed_at
    ) order by receipts.completed_at, receipts.operation_id)
        filter (where receipts.operation_id is not null), '[]'::jsonb) as events,
    coalesce(max(receipts.revision), baseline.whiteboard_revision, 0)::bigint as end_revision
    from baseline
    left join sync_whiteboard_operation_receipts receipts
      on receipts.tenant_id = baseline.tenant_id
     and receipts.space_id = baseline.space_id
     and receipts.episode_id = baseline.episode_id
     and receipts.completed_at > baseline.baseline_at
     and receipts.completed_at <= sqlc.arg(capture_ready_at)
    group by baseline.whiteboard_revision
), capture_plan_head as (
    select coalesce(max(plans.revision), 0)::bigint as revision
    from baseline
    left join recording_capture_plans plans
      on plans.tenant_id = baseline.tenant_id
     and plans.space_id = baseline.space_id
     and plans.episode_id = baseline.episode_id
     and plans.recording_id = baseline.recording_id
     and plans.capture_epoch = sqlc.arg(capture_epoch)
     and plans.created_at <= sqlc.arg(capture_ready_at)
)
insert into recording_presentation_sources (
    presentation_handle, tenant_id, space_id, episode_id, recording_id,
    capture_epoch, capture_ready_at,
    episode_control_start_revision, episode_control_events, episode_control_end_revision,
    participant_facts, chat_start_sequence, chat_retained_floor_sequence,
    initial_chat_messages, whiteboard_start_revision, whiteboard_events,
    whiteboard_end_revision, capture_plan_start_revision
)
select baseline.presentation_handle, baseline.tenant_id, baseline.space_id,
    baseline.episode_id, baseline.recording_id, sqlc.arg(capture_epoch),
    sqlc.arg(capture_ready_at), baseline.episode_control_revision,
    control_delta.events, control_delta.end_revision, participant_snapshot.facts,
    chat_snapshot.head_sequence, chat_snapshot.retained_floor_sequence,
    chat_snapshot.messages, coalesce(baseline.whiteboard_revision, 0),
    whiteboard_delta.events, whiteboard_delta.end_revision, capture_plan_head.revision
from baseline join pipeline on pipeline.recording_id = baseline.recording_id
cross join control_delta cross join participant_snapshot cross join chat_snapshot
cross join whiteboard_delta cross join capture_plan_head
on conflict (presentation_handle) do nothing
returning *;

-- name: GetRecordingPresentationSource :one
select sources.*, baselines.schema_version, baselines.profile_version,
    baselines.profile, baselines.space_name, baselines.episode_folded_state,
    baselines.participant_facts as baseline_participant_facts,
    baselines.whiteboard_snapshot, baselines.baseline_at
from recording_presentation_sources sources
join recording_presentation_baselines baselines using (presentation_handle)
where sources.tenant_id = sqlc.arg(tenant_id)
  and sources.space_id = sqlc.arg(space_id)
  and sources.episode_id = sqlc.arg(episode_id)
  and sources.recording_id = sqlc.arg(recording_id)
  and sources.capture_epoch = sqlc.arg(capture_epoch);
