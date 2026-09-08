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

-- name: GetRecordingPresentationCompletionSource :one
with authority as (
    select jobs.tenant_id, reservations.space_id, jobs.episode_id,
        jobs.recording_id, pipelines.capture_epoch
    from recording_job_attempt_authorities attempts
    join recording_jobs jobs on jobs.id = attempts.job_id
    join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
    join recording_reservations reservations on reservations.id = pipelines.reservation_id
    where attempts.job_id = sqlc.arg(job_id)
      and attempts.attempt_count = sqlc.arg(attempt_count)
      and attempts.fencing_generation = sqlc.arg(fencing_generation)
      and attempts.capture_epoch = sqlc.arg(capture_epoch)
      and attempts.envelope_digest = sqlc.arg(envelope_digest)
      and attempts.lease_token = sqlc.arg(lease_token)
      and attempts.lease_owner = sqlc.arg(lease_owner)
      and jobs.kind = 'capture'
      and jobs.state = 'leased'
      and jobs.attempt_count = attempts.attempt_count
      and jobs.fencing_generation = attempts.fencing_generation
      and jobs.lease_token = sqlc.arg(lease_token)
      and jobs.lease_owner = sqlc.arg(lease_owner)
      and jobs.lease_expires_at > clock_timestamp()
      and pipelines.capture_epoch = attempts.capture_epoch
), source as (
    select sources.presentation_handle, sources.tenant_id, sources.space_id,
        sources.episode_id, sources.recording_id,
        authority.capture_epoch as capture_epoch, sources.capture_ready_at,
        sources.episode_control_start_revision, sources.episode_control_events,
        sources.episode_control_end_revision, sources.participant_facts,
        sources.chat_start_sequence, sources.chat_retained_floor_sequence,
        sources.initial_chat_messages, sources.whiteboard_start_revision,
        sources.whiteboard_events, sources.whiteboard_end_revision,
        sources.capture_plan_start_revision, sources.created_at,
        baselines.schema_version, baselines.profile_version,
        baselines.profile, baselines.space_name, baselines.episode_folded_state,
        baselines.whiteboard_snapshot, baselines.baseline_at
    from authority
    join recording_presentation_sources sources
      on sources.tenant_id = authority.tenant_id
     and sources.space_id = authority.space_id
     and sources.episode_id = authority.episode_id
     and sources.recording_id = authority.recording_id
     and sources.capture_epoch <= authority.capture_epoch
    join recording_presentation_baselines baselines using (presentation_handle)
), duration as (
    select coalesce(max(bundles.media_end_millis), 0)::bigint as duration_millis
    from authority
    left join recording_bundles bundles
      on bundles.tenant_id = authority.tenant_id
     and bundles.recording_id = authority.recording_id
     and bundles.capture_job_id = sqlc.arg(job_id)
), boundary as (
    select source.*, duration.duration_millis,
        cast(source.capture_ready_at + duration.duration_millis * interval '1 millisecond' as timestamptz) as ended_at
    from source cross join duration
)
select boundary.*,
    coalesce((
        select jsonb_agg(jsonb_build_object(
            'revision', plans.revision,
            'capture_epoch', plans.capture_epoch,
            'source_revision', plans.source_revision,
            'plan_bytes', encode(plans.plan_bytes, 'base64'),
            'plan_fingerprint', encode(plans.plan_fingerprint, 'hex'),
            'created_at', plans.created_at
        ) order by plans.revision)
        from (
            select row_number() over (
                    order by plans.capture_epoch, plans.revision, plans.plan_handle
                )::bigint as revision,
                plans.capture_epoch, plans.revision as source_revision,
                plans.plan_bytes, plans.plan_fingerprint, plans.created_at
            from recording_capture_plans plans
            where plans.tenant_id = boundary.tenant_id
              and plans.space_id = boundary.space_id
              and plans.episode_id = boundary.episode_id
              and plans.recording_id = boundary.recording_id
              and plans.capture_epoch >= (
                  select origins.capture_epoch
                  from recording_presentation_sources origins
                  where origins.presentation_handle = boundary.presentation_handle
              )
              and plans.capture_epoch <= boundary.capture_epoch
              and plans.created_at <= boundary.ended_at
            order by plans.capture_epoch, plans.revision, plans.plan_handle
            limit 100001
        ) plans
    ), '[]'::jsonb)::text as capture_plans_json,
    coalesce((
        select jsonb_agg(jsonb_build_object(
            'revision', events.revision,
            'event_name', events.event_name,
            'payload', events.payload,
            'created_at', events.created_at
        ) order by events.revision)
        from (
            select events.revision, events.event_name, events.payload, events.created_at
            from sync_control_events events
            where events.tenant_id = boundary.tenant_id
              and events.space_id = boundary.space_id
              and events.episode_id = boundary.episode_id
              and events.revision > boundary.episode_control_end_revision
              and events.created_at <= boundary.ended_at
            order by events.revision
            limit 100001
        ) events
    ), '[]'::jsonb)::text as episode_control_tail_events_json,
    coalesce((
        select jsonb_agg(jsonb_build_object(
            'message_id', messages.message_id,
            'sequence', messages.sequence,
            'participant_id', messages.participant_id,
            'participant_generation', messages.participant_generation,
            'display_name', messages.display_name,
            'message_text', messages.message_text,
            'created_at', messages.created_at,
            'attachments', coalesce((
                select jsonb_agg(jsonb_build_object(
                    'attachment_id', attachments.attachment_id,
                    'object_key', attachments.object_key,
                    'object_etag', attachments.immutable_object_identity,
                    'original_filename', attachments.original_filename,
                    'mime_type', attachments.mime_type,
                    'byte_length', attachments.byte_length,
                    'sha256', encode(attachments.sha256, 'hex')
                ) order by attachments.message_ordinal)
                from sync_chat_attachments attachments
                where attachments.tenant_id = messages.tenant_id
                  and attachments.space_id = messages.space_id
                  and attachments.message_sequence = messages.sequence
                  and attachments.status = 'attached'
            ), '[]'::jsonb)
        ) order by messages.sequence)
        from (
            select messages.*
            from sync_chat_messages messages
            where messages.tenant_id = boundary.tenant_id
              and messages.space_id = boundary.space_id
              and messages.episode_id = boundary.episode_id
              and messages.sequence > boundary.chat_start_sequence
              and messages.created_at <= boundary.ended_at
            order by messages.sequence
            limit 100001
        ) messages
    ), '[]'::jsonb)::text as chat_tail_messages_json,
    coalesce((
        select jsonb_agg(jsonb_build_object(
            'operation_name', receipts.operation_name,
            'operation_id', receipts.operation_id,
            'scene_id', receipts.scene_id,
            'revision', receipts.revision,
            'elements', receipts.event_elements,
            'presenting', receipts.event_presenting,
            'completed_at', receipts.completed_at
        ) order by receipts.completed_at, receipts.operation_id)
        from (
            select receipts.*
            from sync_whiteboard_operation_receipts receipts
            where receipts.tenant_id = boundary.tenant_id
              and receipts.space_id = boundary.space_id
              and receipts.episode_id = boundary.episode_id
              and receipts.completed_at > boundary.capture_ready_at
              and receipts.completed_at <= boundary.ended_at
            order by receipts.completed_at, receipts.operation_id
            limit 100001
        ) receipts
    ), '[]'::jsonb)::text as whiteboard_tail_events_json,
    coalesce((
        select jsonb_agg(jsonb_build_object(
            'file_id', files.file_id,
            'object_key', files.object_key,
            'object_etag', files.immutable_object_identity,
            'mime_type', files.mime_type,
            'byte_length', files.byte_length,
            'sha256', encode(files.sha256, 'hex')
        ) order by files.scene_id, files.file_id)
        from (
            select files.*
            from sync_whiteboard_files files
            where files.tenant_id = boundary.tenant_id
              and files.space_id = boundary.space_id
              and files.episode_id = boundary.episode_id
              and files.status = 'ready'
              and files.finalized_at <= boundary.ended_at
            order by files.scene_id, files.file_id
            limit 257
        ) files
    ), '[]'::jsonb)::text as whiteboard_files_json,
    coalesce((
        select jsonb_agg(jsonb_build_object(
            'reaction_id', reactions.reaction_id,
            'participant_id', reactions.participant_id,
            'participant_generation', reactions.participant_generation,
            'display_name', reactions.display_name,
            'reaction', reactions.reaction,
            'occurred_at', reactions.occurred_at,
            'expires_at', reactions.expires_at
        ) order by reactions.occurred_at, reactions.reaction_id)
        from (
            select reactions.*
            from recording_presentation_reactions reactions
            where reactions.tenant_id = boundary.tenant_id
              and reactions.recording_id = boundary.recording_id
              and reactions.presentation_handle = boundary.presentation_handle
              and reactions.occurred_at <= boundary.ended_at
            order by reactions.occurred_at, reactions.reaction_id
            limit 100001
        ) reactions
    ), '[]'::jsonb)::text as reactions_json
from boundary;

-- name: InsertRecordingPresentation :one
insert into recording_presentations (
    presentation_handle, tenant_id, space_id, episode_id, recording_id,
    capture_epoch, schema_version, profile_version, duration_millis,
    presentation_sha256, presentation_object_key, presentation_object_version,
    presentation_object_etag, presentation_content_type, presentation_byte_size,
    asset_manifest_object_key, asset_manifest_object_version,
    asset_manifest_object_etag, asset_manifest_content_type,
    asset_manifest_byte_size, asset_manifest_sha256, frozen_at
) values (
    sqlc.arg(presentation_handle), sqlc.arg(tenant_id), sqlc.arg(space_id),
    sqlc.arg(episode_id), sqlc.arg(recording_id), sqlc.arg(capture_epoch),
    sqlc.arg(schema_version), sqlc.arg(profile_version), sqlc.arg(duration_millis),
    sqlc.arg(presentation_sha256), sqlc.arg(presentation_object_key),
    sqlc.arg(presentation_object_version), sqlc.arg(presentation_object_etag),
    sqlc.arg(presentation_content_type), sqlc.arg(presentation_byte_size),
    sqlc.arg(asset_manifest_object_key), sqlc.arg(asset_manifest_object_version),
    sqlc.arg(asset_manifest_object_etag), sqlc.arg(asset_manifest_content_type),
    sqlc.arg(asset_manifest_byte_size), sqlc.arg(asset_manifest_sha256),
    sqlc.arg(frozen_at)
)
on conflict (presentation_handle) do nothing
returning *;

-- name: InsertRecordingPresentationAsset :one
insert into recording_presentation_assets (
    presentation_handle, tenant_id, recording_id, ordinal, asset_id, asset_kind,
    object_key, object_version, object_etag, content_type, byte_size, sha256
) values (
    sqlc.arg(presentation_handle), sqlc.arg(tenant_id), sqlc.arg(recording_id),
    sqlc.arg(ordinal), sqlc.arg(asset_id), sqlc.arg(asset_kind),
    sqlc.arg(object_key), sqlc.arg(object_version), sqlc.arg(object_etag),
    sqlc.arg(content_type), sqlc.arg(byte_size), sqlc.arg(sha256)
)
on conflict (presentation_handle, ordinal) do nothing
returning *;

-- name: GetRecordingPresentationForRender :one
select presentations.presentation_handle, presentations.schema_version,
    presentations.profile_version, presentations.duration_millis,
    presentations.presentation_sha256, sources.capture_ready_at,
    presentations.presentation_object_key, presentations.presentation_object_version,
    presentations.presentation_object_etag, presentations.presentation_content_type,
    presentations.presentation_byte_size,
    presentations.asset_manifest_object_key, presentations.asset_manifest_object_version,
    presentations.asset_manifest_object_etag, presentations.asset_manifest_content_type,
    presentations.asset_manifest_byte_size, presentations.asset_manifest_sha256
from recording_presentations presentations
join recording_presentation_sources sources using (presentation_handle)
where presentations.tenant_id = sqlc.arg(tenant_id)
  and presentations.space_id = sqlc.arg(space_id)
  and presentations.episode_id = sqlc.arg(episode_id)
  and presentations.recording_id = sqlc.arg(recording_id)
  and presentations.presentation_handle = sqlc.arg(presentation_handle)
  and presentations.capture_epoch = sqlc.arg(capture_epoch);

-- name: ListRecordingPresentationAssetsForRender :many
select ordinal, asset_id, asset_kind, object_key, object_version,
    object_etag, content_type, byte_size, sha256
from recording_presentation_assets
where tenant_id = sqlc.arg(tenant_id)
  and recording_id = sqlc.arg(recording_id)
  and presentation_handle = sqlc.arg(presentation_handle)
order by ordinal;

-- name: InsertActiveRecordingPresentationReaction :one
insert into recording_presentation_reactions (
    reaction_id, presentation_handle, tenant_id, space_id, episode_id,
    recording_id, participant_id, participant_generation, display_name,
    reaction, occurred_at, expires_at
)
select sqlc.arg(reaction_id), sources.presentation_handle, sources.tenant_id,
    sources.space_id, sources.episode_id, sources.recording_id,
    sqlc.arg(participant_id), sqlc.arg(participant_generation),
    sqlc.arg(display_name), sqlc.arg(reaction), sqlc.arg(occurred_at),
    sqlc.arg(expires_at)
from recording_presentation_sources sources
join sync_recordings recordings
  on recordings.tenant_id = sources.tenant_id
 and recordings.space_id = sources.space_id
 and recordings.episode_id = sources.episode_id
 and recordings.recording_id = sources.recording_id
where sources.tenant_id = sqlc.arg(tenant_id)
  and sources.space_id = sqlc.arg(space_id)
  and sources.episode_id = sqlc.arg(episode_id)
  and recordings.status in ('recording', 'stopping')
  and sqlc.arg(occurred_at)::timestamptz >= sources.capture_ready_at
on conflict (reaction_id) do nothing
returning *;

-- name: ListRecordingPresentationReactions :many
select * from recording_presentation_reactions
where tenant_id = sqlc.arg(tenant_id)
  and recording_id = sqlc.arg(recording_id)
  and presentation_handle = sqlc.arg(presentation_handle)
  and occurred_at <= sqlc.arg(ended_at)
order by occurred_at, reaction_id;
