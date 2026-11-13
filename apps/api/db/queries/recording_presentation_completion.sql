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
