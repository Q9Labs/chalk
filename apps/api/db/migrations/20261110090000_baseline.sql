-- Baseline of every migration through 20261110090000, the newest one in the last production release.
-- It was produced by `pg_dump --schema-only` of a database migrated through that version, with the
-- seed rows the squashed migrations inserted. Databases already at or past this version skip it.
-- +goose Up
-- +goose StatementBegin
do $$
begin
    if to_regclass('tenants') is not null then
        raise exception 'this database predates the baseline: migrate it through 20261110090000 with a release from before the squash first';
    end if;
end
$$;
-- +goose StatementEnd
set local check_function_bodies = false;
-- +goose StatementBegin
CREATE FUNCTION bind_public_arrival_media_connection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if new.state = 'admitted' and new.provider_subject is not null and
       (TG_OP = 'INSERT' or old.state is distinct from new.state or
        old.provider_subject is distinct from new.provider_subject or
        old.participant_generation is distinct from new.participant_generation or
        old.participant_id is distinct from new.participant_id) then
        update participants set media_connection_id = new.provider_subject,
            media_connection_generation = new.participant_generation
        where tenant_id = new.tenant_id and episode_id = new.episode_id
          and id = new.participant_id and generation = new.participant_generation;
    end if;
    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION chat_person_participant_ids(p_tenant_id uuid, p_space_id uuid, p_participant_id uuid) RETURNS TABLE(participant_id uuid)
    LANGUAGE sql STABLE
    AS $$
    select sibling.id
    from participants sender
    join participants sibling
        on sibling.tenant_id = sender.tenant_id
        and sibling.space_id = sender.space_id
        and coalesce(sibling.account_id, sibling.identity_id, sibling.id)
            = coalesce(sender.account_id, sender.identity_id, sender.id)
    where sender.tenant_id = p_tenant_id
        and sender.space_id = p_space_id
        and sender.id = p_participant_id
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION complete_participant_join_seat() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if new.status='left' then
        update participant_join_seats
        set state=case when state='joined' or new.first_joined_at is not null then 'left' else 'cancelled' end, updated_at=now()
        where participant_id=new.id and generation=new.generation and state in ('pending','joined');
    end if;
    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION enforce_sync_entry_ownership(target_release text) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
    perform 1 from sync_entry_rollout where singleton for update;
    if (select enforced from sync_entry_rollout where singleton) then return; end if;
    if target_release is null or length(target_release)=0 then
        raise exception 'entry enforcement requires a release identity';
    end if;
    -- A provider call outlives its claiming transaction. Drain it while all
    -- sockets still use compatibility semantics, before issuing owned entries.
    if exists (select 1 from sync_external_operations where operation_name='participant_leave'
               and status='pending' and attempt_count > 0) then
        raise exception 'entry enforcement requires claimed Leaves to finish' using errcode='55000';
    end if;
    update sync_entry_rollout set enforced=true,enforced_at=clock_timestamp(),release_id=target_release
      where singleton;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION guard_canonical_public_admission_decision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
    canonical_state text;
begin
    select case when status = 'admitted' then 'approved' else status end
      into canonical_state
      from sync_admission_requests
      where tenant_id = new.tenant_id and space_id = new.space_id
        and admission_request_id = new.request_handle;
    if found and new.state <> canonical_state then
        raise exception 'canonical admission decisions are owned by Sync'
            using errcode = '23514';
    end if;
    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION guard_tenant_media_plane_approval() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if coalesce(current_setting('chalk.operator_write', true), '') = 'on' then
        return new;
    end if;
    if tg_op = 'INSERT' or new.default_media_plane is distinct from old.default_media_plane then
        new.default_media_plane_approved := false;
    else
        new.default_media_plane_approved := old.default_media_plane_approved;
    end if;
    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION notify_provider_publication_observation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
    episode_space_id uuid;
begin
    select space_id into episode_space_id
    from episodes
    where tenant_id = new.tenant_id and id = new.episode_id;

    if episode_space_id is not null then
        perform pg_notify(
            'chalk_media_publications',
            new.tenant_id::text || ':' || episode_space_id::text || ':' || new.episode_id::text
        );
    end if;
    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION protect_immutable_episode_policy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
    old_binding jsonb := old.config_snapshot -> 'media_plane_binding';
    new_binding jsonb := new.config_snapshot -> 'media_plane_binding';
    placement constant text[] := array['node', 'node_incarnation', 'placement_reason', 'generation', 'previous_allocations'];
begin
    if new.config_snapshot is distinct from old.config_snapshot then
        if not coalesce(
            (new.config_snapshot - 'media_plane_binding') = (old.config_snapshot - 'media_plane_binding')
            and jsonb_typeof(old_binding) = 'object'
            and jsonb_typeof(new_binding) = 'object'
            and old_binding ->> 'provider' = 'chalk_sfu'
            and (new_binding - placement) = (old_binding - placement)
            and coalesce((new_binding ->> 'generation')::bigint, 0) = coalesce((old_binding ->> 'generation')::bigint, 0) + 1,
            false
        ) then
            raise exception 'Episode config_snapshot is immutable';
        end if;
    end if;

    if new.deadline_at is distinct from old.deadline_at
        then
        if new.deadline_generation <> old.deadline_generation + 1 then
            raise exception 'Episode deadline mutation must advance generation exactly once';
        end if;
    elsif new.deadline_generation is distinct from old.deadline_generation then
            raise exception 'Episode deadline generation cannot change without a deadline mutation';
    end if;

    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION protect_recording_bundle_allocation_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if old.id <> new.id
        or old.tenant_id <> new.tenant_id
        or old.episode_id <> new.episode_id
        or old.recording_id <> new.recording_id
        or old.job_id <> new.job_id
        or old.object_handle <> new.object_handle
        or old.reservation_request_id <> new.reservation_request_id
        or old.allocation_version <> new.allocation_version
        or old.attempt_count <> new.attempt_count
        or old.fencing_generation <> new.fencing_generation
        or old.capture_epoch <> new.capture_epoch
        or old.envelope_digest <> new.envelope_digest
        or old.sequence_number <> new.sequence_number
        or old.object_key <> new.object_key
        or old.encryption_context_digest <> new.encryption_context_digest
        or old.created_at <> new.created_at then
        raise exception 'recording bundle allocation authority is immutable';
    end if;

    if old.state = 'reserved' and new.state = 'allocated' then
        return new;
    end if;

    if old.state = 'allocated' and new.state = 'allocated' then
        if old.expected_byte_size is distinct from new.expected_byte_size
            or old.expected_checksum is distinct from new.expected_checksum
            or old.content_type is distinct from new.content_type
            or old.expires_at is distinct from new.expires_at
            or old.codec is distinct from new.codec
            or old.layer is distinct from new.layer
            or old.monotonic_start_millis is distinct from new.monotonic_start_millis
            or old.monotonic_end_millis is distinct from new.monotonic_end_millis
            or old.media_start_millis is distinct from new.media_start_millis
            or old.media_end_millis is distinct from new.media_end_millis
            or old.object_version is not null
            or old.object_etag is not null
            or old.object_checksum is not null
            or old.manifest_digest is not null
            or old.committed_at is not null then
            raise exception 'recording bundle allocation upload facts are immutable';
        end if;
        return new;
    end if;

    if old.state = 'allocated' and new.state = 'committed' then
        if old.upload_token_hash is distinct from new.upload_token_hash
            or old.expected_byte_size is distinct from new.expected_byte_size
            or old.expected_checksum is distinct from new.expected_checksum
            or old.content_type is distinct from new.content_type
            or old.expires_at is distinct from new.expires_at
            or old.codec is distinct from new.codec
            or old.layer is distinct from new.layer
            or old.monotonic_start_millis is distinct from new.monotonic_start_millis
            or old.monotonic_end_millis is distinct from new.monotonic_end_millis
            or old.media_start_millis is distinct from new.media_start_millis
            or old.media_end_millis is distinct from new.media_end_millis then
            raise exception 'recording bundle allocation upload facts are immutable';
        end if;
        return new;
    end if;

    raise exception 'recording bundle allocation state transition is invalid';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION protect_recording_capture_command() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if old.signaling_handle is distinct from new.signaling_handle
        or old.capture_epoch is distinct from new.capture_epoch
        or old.sequence is distinct from new.sequence
        or old.recording_id is distinct from new.recording_id
        or old.plan_revision is distinct from new.plan_revision
        or old.operation_kind is distinct from new.operation_kind
        or old.idempotency_key is distinct from new.idempotency_key
        or old.request_bytes is distinct from new.request_bytes
        or old.request_fingerprint is distinct from new.request_fingerprint
        or old.created_at is distinct from new.created_at then
        raise exception 'recording capture command authority is immutable';
    end if;
    if old.state in ('completed', 'terminal', 'ambiguous') then
        raise exception 'terminal recording capture command is immutable';
    end if;
    if not (
        (old.state = 'queued' and new.state = 'leased')
        or (old.state = 'retryable' and new.state = 'leased')
        or (old.state = 'leased' and new.state = 'queued')
        or (old.state = 'leased' and new.state in ('completed', 'retryable', 'terminal', 'ambiguous'))
    ) then
        raise exception 'invalid recording capture command transition from % to %', old.state, new.state;
    end if;
    new.updated_at = now();
    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION protect_recording_capture_connection_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if old.signaling_handle is distinct from new.signaling_handle
        or old.capture_epoch is distinct from new.capture_epoch
        or old.tenant_id is distinct from new.tenant_id
        or old.space_id is distinct from new.space_id
        or old.episode_id is distinct from new.episode_id
        or old.recording_id is distinct from new.recording_id
        or old.job_id is distinct from new.job_id
        or old.attempt_count is distinct from new.attempt_count
        or old.fencing_generation is distinct from new.fencing_generation
        or old.envelope_digest is distinct from new.envelope_digest then
        raise exception 'recording capture connection authority is immutable';
    end if;
    new.updated_at = now();
    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION protect_recording_data_key_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    raise exception 'recording data keys are append-only';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION protect_recording_render_allocation_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if old.id <> new.id
        or old.reservation_request_id <> new.reservation_request_id
        or old.allocation_version <> new.allocation_version
        or old.tenant_id <> new.tenant_id
        or old.episode_id <> new.episode_id
        or old.recording_id <> new.recording_id
        or old.render_job_id <> new.render_job_id
        or old.render_input_handle <> new.render_input_handle
        or old.object_handle <> new.object_handle
        or old.attempt_count <> new.attempt_count
        or old.fencing_generation <> new.fencing_generation
        or old.capture_epoch <> new.capture_epoch
        or old.envelope_digest <> new.envelope_digest
        or old.purpose <> new.purpose
        or old.object_key <> new.object_key
        or old.created_at <> new.created_at then
        raise exception 'recording render allocation authority is immutable';
    end if;
    if old.state = 'reserved' and new.state = 'allocated' then
        return new;
    end if;
    if old.state = 'allocated' and new.state = 'allocated'
        and old.expected_content_type = new.expected_content_type
        and old.expected_byte_size = new.expected_byte_size
        and old.expected_sha256 = new.expected_sha256
        and old.expected_duration_millis is not distinct from new.expected_duration_millis
        and old.object_version is null and new.object_version is null then
        return new;
    end if;
    if old.state = 'allocated' and new.state = 'committed'
        and old.expected_content_type = new.expected_content_type
        and old.expected_byte_size = new.expected_byte_size
        and old.expected_sha256 = new.expected_sha256
        and old.expected_duration_millis is not distinct from new.expected_duration_millis
        and old.upload_token_hash = new.upload_token_hash
        and old.upload_expires_at = new.upload_expires_at then
        return new;
    end if;
    raise exception 'recording render allocation state transition is invalid';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_backfill_terminal_capture_source_cleanup() RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
    terminal_capture record;
begin
    for terminal_capture in
        select jobs.recording_id, coalesce(jobs.terminal_at, jobs.updated_at) as terminal_at
        from recording_jobs jobs
        where jobs.kind = 'capture'
          and jobs.state = 'terminal_failure'
          and exists (
              select 1 from recording_bundle_allocations allocations
              where allocations.recording_id = jobs.recording_id
                and allocations.state in ('allocated', 'committed')
          )
    loop
        perform recording_enqueue_terminal_capture_source_cleanup(
            terminal_capture.recording_id, terminal_capture.terminal_at
        );
    end loop;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_capture_completion_attempts(target_job_id uuid) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
    select count(*)::integer from recording_job_attempt_authorities authority
    where authority.job_id = target_job_id
      and (convert_from(authority.envelope_bytes, 'UTF8')::jsonb ->> 'completion_only')::boolean is true
      and not exists (
          select 1 from recording_capture_publication_failures failure
          where failure.job_id = authority.job_id and failure.attempt_count = authority.attempt_count
            and failure.fencing_generation = authority.fencing_generation
      );
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_capture_completion_available(target_recording_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM recording_pipelines pipeline
        JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
        JOIN sync_recordings recording ON recording.recording_id = pipeline.recording_id
            AND recording.tenant_id = pipeline.tenant_id
        WHERE pipeline.recording_id = target_recording_id
          AND pipeline.stop_requested_at IS NOT NULL
          AND pipeline.capture_ready_at IS NOT NULL
          AND (
              recording_capture_stop_confirmed(target_recording_id) OR (
                  recording_capture_salvage_deadline(target_recording_id) > clock_timestamp()
                  AND EXISTS (SELECT 1 FROM recording_bundles bundle WHERE bundle.recording_id = pipeline.recording_id)
                  AND EXISTS (SELECT 1 FROM recording_data_keys key WHERE key.recording_id = pipeline.recording_id
                              AND key.capture_epoch = pipeline.capture_epoch)
              )
          )
    );
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_capture_salvage_deadline(target_recording_id uuid) RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    AS $$
    SELECT pipeline.stop_requested_at + recording_deferred_retention_seconds(episode.config_snapshot) * interval '1 second'
    FROM recording_pipelines pipeline
    JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
    JOIN episodes episode ON episode.id = job.episode_id
    WHERE pipeline.recording_id = target_recording_id
      AND NOT recording_capture_stop_confirmed(target_recording_id);
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_capture_stop_confirmed(target_recording_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM recording_pipelines pipeline
        JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
        JOIN sync_recordings recording ON recording.recording_id = pipeline.recording_id AND recording.tenant_id = pipeline.tenant_id
        JOIN sync_external_operations operation ON operation.tenant_id = job.tenant_id
            AND operation.episode_id = job.episode_id AND operation.recording_id = job.recording_id
        WHERE pipeline.recording_id = target_recording_id AND recording.status = 'stopped'
          AND operation.payload ->> 'stopOperationId' = recording.stop_external_operation_id::text
          AND operation.payload -> 'captureEpoch' = to_jsonb(pipeline.capture_epoch)
          AND operation.operation_name = 'recording_capture_stopped' AND operation.status = 'applied'
    );
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_deferred_retention_seconds(config_snapshot jsonb) RETURNS bigint
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    select coalesce(
        nullif((config_snapshot -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint, 0),
        2592000
    );
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_drain_capture_stop_publications(observed_at timestamp with time zone, batch_size integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
    obligation record;
    attempted integer := 0;
begin
    for obligation in
        select recording_id from recording_capture_stop_publications
        where resolved_at is null and next_attempt_at <= observed_at
        order by next_attempt_at, recording_id
        for update skip locked limit greatest(0, least(batch_size, 100))
    loop
        perform recording_try_publish_capture_stop(obligation.recording_id, observed_at);
        attempted := attempted + 1;
    end loop;
    return attempted;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_enqueue_terminal_capture_source_cleanup(source_recording_id uuid, stopped_at timestamp with time zone) RETURNS void
    LANGUAGE sql
    AS $$
    insert into transcription_cleanup_jobs (
        id, tenant_id, recording_id, transcript_id, object_key, object_kind, due_at
    )
    select gen_random_uuid(), objects.tenant_id, source_recording_id, null,
        objects.object_key, 'recording_source', stopped_at +
            (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second')
    from (
        select allocations.tenant_id, allocations.object_key
        from recording_bundle_allocations allocations
        where allocations.recording_id = source_recording_id
          and allocations.state in ('allocated', 'committed')
        union
        select presentations.tenant_id, presentations.presentation_object_key
        from recording_presentations presentations
        where presentations.recording_id = source_recording_id
        union
        select presentations.tenant_id, presentations.asset_manifest_object_key
        from recording_presentations presentations
        where presentations.recording_id = source_recording_id
        union
        select assets.tenant_id, assets.object_key
        from recording_presentations presentations
        join recording_presentation_assets assets
          on assets.presentation_handle = presentations.presentation_handle
        where presentations.recording_id = source_recording_id
    ) objects
    join recordings on recordings.id = source_recording_id
    join episodes on episodes.id = recordings.episode_id
    on conflict (recording_id, object_key) do nothing;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_publish_completed_capture_stop(source_recording_id uuid, trace_id text, span_id text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
begin
    insert into recording_capture_stop_publications(recording_id, stop_operation_id, capture_epoch, producing_trace_id, producing_span_id)
    select pipeline.recording_id, pipeline.stop_operation_id, pipeline.capture_epoch, trace_id, span_id
    from recording_pipelines pipeline
    join sync_external_operations source on source.tenant_id = pipeline.tenant_id
        and source.recording_id = pipeline.recording_id and source.external_operation_id = pipeline.stop_operation_id
        and source.operation_name = 'stop_recording' and source.status in ('pending', 'applied')
    where pipeline.recording_id = source_recording_id and pipeline.capture_completed_at is not null
        and pipeline.capture_epoch > 0
    on conflict (recording_id) do nothing;
    perform recording_try_publish_capture_stop(source_recording_id, clock_timestamp());
    return true;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_terminal_capture_source_cleanup_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    perform recording_enqueue_terminal_capture_source_cleanup(new.recording_id, coalesce(new.terminal_at, new.updated_at));
    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_transcription_source_window_seconds(config_snapshot jsonb) RETURNS bigint
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    select least(
        recording_deferred_retention_seconds(config_snapshot),
        coalesce((config_snapshot -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint, 0)
    );
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION recording_try_publish_capture_stop(target_recording_id uuid, observed_at timestamp with time zone) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
    obligation recording_capture_stop_publications%rowtype;
begin
    select * into obligation from recording_capture_stop_publications
    where recording_id = target_recording_id and resolved_at is null for update;
    if not found then return; end if;

    -- Completed media, not a live recorder lease, authorizes this retry. A
    -- replaced stop/epoch or an already queued callback retires the obligation.
    if not exists (
        select 1 from recording_pipelines pipeline
        join sync_recordings recording on recording.tenant_id = pipeline.tenant_id
            and recording.recording_id = pipeline.recording_id
        join sync_external_operations source on source.tenant_id = recording.tenant_id
            and source.space_id = recording.space_id and source.episode_id = recording.episode_id
            and source.recording_id = recording.recording_id
            and source.external_operation_id = obligation.stop_operation_id
            and source.operation_name = 'stop_recording' and source.status in ('pending', 'applied')
        where pipeline.recording_id = obligation.recording_id and pipeline.capture_completed_at is not null
            and pipeline.stop_operation_id = obligation.stop_operation_id and pipeline.capture_epoch = obligation.capture_epoch
            and recording.status = 'stopping' and recording.stop_external_operation_id = obligation.stop_operation_id
            and not exists (
                select 1 from sync_external_operations operation
                where operation.tenant_id = recording.tenant_id and operation.episode_id = recording.episode_id
                    and operation.operation_name = 'recording_capture_stopped' and operation.recording_id = recording.recording_id
                    and operation.status in ('pending', 'applied')
                    and operation.payload ->> 'stopOperationId' = obligation.stop_operation_id::text
                    and operation.payload ->> 'captureEpoch' = obligation.capture_epoch::text
            )
    ) then
        update recording_capture_stop_publications set resolved_at = observed_at, last_error_code = null
        where recording_id = target_recording_id;
        return;
    end if;

    -- Sync records the intent before dispatching the stop to the API. Media
    -- can finish before Sync commits that source operation's applied result.
    if exists (
        select 1 from sync_external_operations source
        join recording_pipelines pipeline on pipeline.tenant_id = source.tenant_id
            and pipeline.recording_id = source.recording_id
        where pipeline.recording_id = target_recording_id
            and source.external_operation_id = obligation.stop_operation_id and source.status = 'pending'
    ) then
        update recording_capture_stop_publications
        set attempt_count = least(attempt_count, 9223372036854775806) + 1, last_error_code = 'source_pending',
            next_attempt_at = observed_at + least(300, 5 * power(2, least(attempt_count, 6))::integer) * interval '1 second'
        where recording_id = target_recording_id;
        return;
    end if;

    -- Retry counters saturate at bigint max; publication has no attempt budget.
    -- Only the outbox insert is a subtransaction. Its failure cannot undo the
    -- completed capture, released reservation, or durable retry obligation.
    begin
        insert into sync_external_operations (
            tenant_id, space_id, episode_id, external_operation_id, request_key,
            request_fingerprint, operation_name, recording_id, payload, fence_active,
            journey_id, parent_journey_event_id, producing_trace_id, producing_span_id
        )
        select recording.tenant_id, recording.space_id, recording.episode_id, gen_random_uuid(),
            'capture_complete_recovery_' || recording.recording_id::text || '_' || obligation.capture_epoch::text,
            sha256(convert_to(payload.value::text, 'UTF8')), 'recording_capture_stopped', recording.recording_id,
            payload.value, false, source.journey_id, source.parent_journey_event_id,
            obligation.producing_trace_id, obligation.producing_span_id
        from sync_recordings recording
        join sync_external_operations source on source.tenant_id = recording.tenant_id
            and source.space_id = recording.space_id and source.episode_id = recording.episode_id
            and source.recording_id = recording.recording_id and source.external_operation_id = obligation.stop_operation_id
            and source.operation_name = 'stop_recording' and source.status = 'applied'
        cross join lateral (
            select jsonb_build_object('recordingId', recording.recording_id::text,
                'stopOperationId', obligation.stop_operation_id::text, 'captureEpoch', obligation.capture_epoch) as value
        ) payload
        where recording.recording_id = obligation.recording_id and recording.status = 'stopping'
            and recording.stop_external_operation_id = obligation.stop_operation_id
        on conflict (tenant_id, episode_id, operation_name, request_key) do nothing;
    exception when query_canceled or others then
        update recording_capture_stop_publications
        set attempt_count = least(attempt_count, 9223372036854775806) + 1, last_error_code = SQLSTATE,
            next_attempt_at = observed_at + least(300, 5 * power(2, least(attempt_count, 6))::integer) * interval '1 second'
        where recording_id = target_recording_id;
        return;
    end;
    update recording_capture_stop_publications
    set attempt_count = least(attempt_count, 9223372036854775806) + 1, resolved_at = observed_at, last_error_code = null
    where recording_id = target_recording_id;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION reject_recording_bundle_allocation_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    raise exception 'recording bundle allocations are append-only';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION reject_recording_capture_plan_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    raise exception 'recording capture plans are append-only';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION reject_recording_capture_queue_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    raise exception 'recording capture signaling authority cannot be deleted or truncated';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION reject_recording_completion_recovery_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    raise exception 'recording completion recoveries are append-only';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION reject_recording_job_attempt_authority_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    raise exception 'recording job attempt authorities are append-only';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION reject_recording_object_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    raise exception 'recording object facts are immutable';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION reject_recording_presentation_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    raise exception 'recording presentation authority is append-only';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION reject_recording_render_authority_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    raise exception 'recording render authority is append-only';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION require_sync_entry_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare enabled boolean;
begin
    select enforced into strict enabled from sync_entry_rollout where singleton for share;
    if enabled and current_setting('chalk.entry_writer', true) is distinct from '1' then
        -- A still-current compatibility socket may request Leave. Only the new
        -- consumer can claim/finalize it; old provider dispatch remains fenced.
        if tg_table_name='sync_external_operations' and tg_op='INSERT' then
            if not exists (select 1 from participant_join_seats
                           where participant_id=new.target_participant_id
                             and generation=new.target_participant_generation
                             and confirmed_entry_generation > 0) then
                return new;
            end if;
        end if;
        raise exception 'Sync entry writer upgrade required' using errcode='55000';
    end if;
    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION space_public_invite_code(handle bytea) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
    select string_agg(chr(97 + get_byte(digest, i) % 26), '' order by i)
    from (select sha256('chalk/public-invite/code/v1'::bytea || handle) as digest) hashed,
         generate_series(0, 9) as i
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION space_public_invite_words(handle bytea) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
    select string_agg(words[1 + ((get_byte(digest, (i * 10) / 8)::bigint * 65536
        + get_byte(digest, (i * 10) / 8 + 1) * 256
        + get_byte(digest, (i * 10) / 8 + 2)) >> (14 - (i * 10) % 8) & 1023)], '-' order by i)
    from (select sha256('chalk/public-invite/words/v1'::bytea || handle) as digest,
        array['abacus','able','accent','acorn','acoustic','acre','acrobat','active','actor','adore','aerial','agenda','agent','agile','ahead','aim','airport','album','alike','alive','almond','aloe','aloha','alone','alpaca','alto','alumni','amber','amend','ample','amuse','anchor','angle','animal','anthem','antique','anvil','apple','april','apron','aqua','arcade','arctic','area','arena','arise','aroma','array','art','artist','aspire','astute','atlas','atom','attach','attain','attic','audio','autumn','avenue','avocado','awake','award','awning','bacon','badge','bagel','baked','baker','bakery','bamboo','banana','banjo','banner','barge','barn','basil','basket','batch','baton','beacon','beetle','blank','blanket','blaze','blend','blink','blog','blossom','bluebird','boat','bobcat','bolt','bonsai','bonus','book','booth','boots','boss','botany','both','bottle','boulder','bounce','bowler','branch','breeze','brick','bright','brim','bring','brisk','broil','bronze','brook','broom','brush','bubble','bucket','budget','buffalo','builder','bulb','bulk','bunch','bundle','bunny','busy','butter','button','buzz','cabana','cable','cactus','cake','calm','cameo','camera','camper','campus','canal','canary','candle','candy','canopy','canyon','cape','captain','carbon','card','cargo','carrot','carry','cartoon','case','castle','catalog','cedar','celery','chair','charm','cheer','cheese','chef','cherry','chess','chief','chill','chip','chunk','churn','cinema','circle','circus','citrus','city','civic','civil','claim','clamp','clap','clasp','class','clay','clean','clear','clever','click','cling','clip','cloak','clock','clone','closet','cloth','cloud','clover','clump','coach','coast','coat','cobalt','cocoa','coconut','coffee','coil','cola','cold','colony','comfy','comic','compass','concert','condor','cone','cookie','cope','copper','copy','coral','cork','corner','cosmic','cost','cotton','couch','cover','craft','crane','crate','crave','crawl','crayon','create','cricket','crisp','crop','crowd','crown','crumb','crust','crystal','cub','cube','cupcake','curl','curry','cursor','curve','cut','cycle','daffodil','daily','daisy','dance','dash','date','dawn','deal','debug','decaf','deck','decor','delta','deluxe','denim','depth','desk','device','dial','diary','dice','dig','dime','diner','dinner','disco','dish','dock','doing','doll','dolphin','domain','dome','donut','dot','down','dragon','dragonfly','drama','draw','drawing','dress','dried','drift','drill','drive','drizzle','drove','drum','dry','duck','duke','duo','dusk','dust','duty','eagle','early','earth','easel','east','echo','eclipse','edge','editor','eel','effort','elder','elf','elk','elm','email','ember','emblem','emboss','emerald','encore','energy','engine','enrich','enter','entry','equal','equator','eraser','errand','even','evolve','exact','exit','expert','fable','fabric','fact','factory','falcon','fall','fame','family','fancy','feast','feather','feed','fence','fern','ferry','fetch','fiber','fiddle','figure','film','filter','final','finale','finch','firefly','fit','five','flag','flame','flap','flick','flight','flip','float','flock','flower','foam','fog','foil','folk','font','food','forest','fossil','found','fountain','fox','frame','fresh','fridge','friend','from','front','frost','fruit','gala','galaxy','game','gap','garage','garden','garlic','gave','gazebo','gear','gecko','gem','gerbil','giant','gift','gig','ginger','giraffe','glacier','glad','glass','glide','glitter','glory','gloss','glove','glow','glue','goal','going','golden','golf','good','gown','grab','grain','granite','grant','grape','graph','grasp','grass','gravy','green','greet','grew','grid','grill','grip','groom','groove','guide','guitar','gulf','gummy','gush','habit','half','hamster','happy','harvest','hatch','haven','hazel','hazy','heap','heat','hedge','helium','helmet','help','heron','hickory','holiday','honey','horizon','hub','hula','hull','human','humid','hurry','hut','ice','iceberg','icing','icon','igloo','image','insect','iron','island','item','ivory','ivy','jacket','jaguar','jam','jasmine','jazz','jelly','jersey','jet','jigsaw','job','jog','jolly','jolt','journal','joy','judge','juice','juicy','july','jumbo','jump','jungle','keep','kettle','kilt','king','kite','kitten','kiwi','koala','ladder','lady','lagoon','lake','lamp','land','lantern','laptop','large','latch','laurel','lavender','leaflet','legend','lemon','length','lens','leopard','letter','lettuce','level','lever','library','lid','life','lift','lilac','lily','limit','line','linen','lint','lion','liquid','list','little','lively','lizard','lobster','locket','lotus','luggage','lumber','lunar','lunch','lyric','magnet','maker','mango','manor','many','map','maple','marble','marine','market','mascot','mash','match','math','meadow','melon','mercury','meteor','mitten','mocha','monkey','mop','mosaic','motor','motto','mount','mouse','move','movie','mud','muffin','mug','mural','muse','museum','mushroom','music','nacho','nail','name','nap','napkin','nature','neat','nectar','neon','nest','net','next','nickel','noodle','nugget','nutmeg','nylon','oak','oasis','oat','oatmeal','ocean','octagon','octopus','oil','olive','onion','opal','open','opera','orchid','origami','otter','outdoor','outer','oval','oven','owl','oxygen','oyster','ozone','pace','packet','pager','palace','palm','panda','panther','pantry','pants','papaya','paper','parade','parcel','park','parrot','parsley','party','pasta','pastel','patch','path','patio','pebble','pecan','pelican','pencil','penguin','penny','pepper','perch','petal','photo','picnic','pigeon','pillow','plank','plant','plaza','plenty','pluck','plug','plus','pod','poem','poet','point','polar','polka','polo','pond','pony','poppy','portal','poster','pouch','pound','power','press','print','prism','prize','proof','pug','pull','pulp','pulse','puma','pupil','puppet','puppy','purse','push','puzzle','quiet','quilt','quota','quote','race','rack','radar','radio','radish','raft','rail','rake','rally','ramp','ranch','range','ranger','rank','raven','reach','react','recap','relax','relay','relic','remix','repay','reply','rerun','reset','rhyme','ribbon','rice','rich','ride','rinse','ripple','rise','river','robe','robin','rock','rocket','rope','rover','royal','ruby','rug','rule','rush','safari','sage','salad','salon','salsa','salt','sample','sandy','satin','say','scale','scan','scarf','scoop','scoot','scope','score','scout','scrap','screen','script','scrub','scuba','scuff','sedan','send','serve','seven','shack','shade','shaky','shape','shed','sheep','shelf','shell','shine','shiny','ship','shirt','shop','shore','sift','silk','silly','silver','simple','single','sip','size','skate','sketch','skid','skip','skirt','sky','slab','slack','slate','sled','sleek','sleep','slice','slick','sling','slip','slush','small','smile','snack','snap','snowy','speak','speed','spend','spent','spill','spiny','spoke','sponge','spool','spoon','sport','spot','spout','spray','spring','sprint','sprout','spruce','spur','squad','squid','stack','staff','stage','stall','stamp','stand','staple','start','state','statue','steam','steep','stem','step','stereo','stew','stick','sting','stir','stock','stool','stop','storm','stove','straw','stream','street','strut','stuck','studio','stuff','stump','stunt','subway','sugar','surf','sushi','swan','sway','sweep','swell','swim','swing','swipe','swirl','swoop','syrup','tablet','taco','tag','take','tall','task','taste','tasty','thaw','theme','think','thread','thumb','tiara','tidal','tidy','tiger','tile','tilt','tint','tiny','trace','track','trade','train','travel','tray','treat','tree','trek','trend','trial','trick','trio','trophy','trout','truck','trunk','try','tug','tulip','turf','turtle','tutor','tweak','tweet','twice','twins','twirl','twist','uncle','undo','unify','unit','untie','update','upper','urban','user','valley','value','velvet','venue','verify','verse','vest','video','view','violet','vista','vocal','voice','volt','vowel','voyage','wafer','wagon','wake','walk','walnut','wand','watch','water','wavy','wheat','whoop','widen','width','willow','wing','wink','wipe','wise','wish','wizard','wok','wolf','wool','word','work','woven','yam','yard','year','yelp','yield','yoga','yogurt','yummy','zebra','zero','zesty','zippy','zone','zoom' ] as words) hashed,
        generate_series(0, 3) as i
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION sync_admission_expiry_due(request_expires_at timestamp with time zone, arrival_state text, as_of timestamp with time zone) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
    select request_expires_at <= as_of
        or coalesce(arrival_state in ('unavailable', 'rejected', 'left'), false);
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION sync_v3_protect_immutable_session_policy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if new.host_exit_policy is distinct from old.host_exit_policy
        or new.role_capabilities is distinct from old.role_capabilities
        or new.maximum_duration_ceiling_seconds is distinct from old.maximum_duration_ceiling_seconds then
        raise exception 'sync v3 immutable Session policy cannot change';
    end if;

    if new.deadline_at is distinct from old.deadline_at
        or new.maximum_duration_seconds is distinct from old.maximum_duration_seconds then
        if new.deadline_generation <> old.deadline_generation + 1 then
            raise exception 'sync v3 deadline mutation must advance generation exactly once';
        end if;
    elsif new.deadline_generation is distinct from old.deadline_generation then
        raise exception 'sync v3 deadline generation cannot change without a deadline mutation';
    end if;

    return new;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION sync_v3_valid_eligible_roles(value text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    select cardinality(value) between 1 and 3
        and value <@ array['host', 'cohost', 'participant']::text[]
        and cardinality(value) = (select count(distinct role_name) from unnest(value) as role_name)
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION sync_v3_valid_role_capabilities(value jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
declare
    role_name text;
    capability_value jsonb;
    capability_name text;
    seen text[];
    allowed constant text[] := array[
        'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
        'raiseHand', 'renameSelf', 'manageAdmission', 'promoteDemote',
        'transferHost', 'muteOthers', 'stopVideoOthers', 'stopScreenOthers',
        'requestMediaOthers', 'removeParticipant', 'manageRecording', 'endMeeting'
    ];
begin
    if jsonb_typeof(value) <> 'object'
        or not value ?& array['host', 'cohost', 'participant']
        or (select count(*) from jsonb_object_keys(value)) <> 3 then
        return false;
    end if;

    foreach role_name in array array['host', 'cohost', 'participant'] loop
        capability_value := value -> role_name;
        if jsonb_typeof(capability_value) <> 'array' or jsonb_array_length(capability_value) > 16 then
            return false;
        end if;

        seen := array[]::text[];
        for capability_name in select jsonb_array_elements_text(capability_value) loop
            if not capability_name = any(allowed) or capability_name = any(seen) then
                return false;
            end if;
            seen := array_append(seen, capability_name);
        end loop;
    end loop;

    return true;
exception
    when others then
        return false;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION sync_v3_validate_receipt_event_origin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
    event_row sync_control_events%rowtype;
begin
    if new.outcome <> 'committed' then
        return new;
    end if;

    select *
    into event_row
    from sync_control_events
    where tenant_id = new.tenant_id
      and session_id = new.session_id
      and event_id = new.event_id
      and revision = new.resulting_revision;

    if not found then
        raise exception 'committed sync receipt references a missing event';
    end if;

    if event_row.command_id = new.command_id
        and event_row.actor_participant_session_id = new.participant_session_id
        and event_row.actor_generation = new.submitted_generation then
        return new;
    end if;

    if new.external_operation_id is not null
        and event_row.external_operation_id = new.external_operation_id then
        return new;
    end if;

    if new.command_name = 'admit_participant'
        and new.external_operation_id is not null
        and event_row.event_name = 'participant_joined'
        and event_row.lifecycle_intent_id is not null
        and exists (
            select 1
            from sync_admission_requests admission
            where admission.tenant_id = new.tenant_id
              and admission.session_id = new.session_id
              and admission.decision_external_operation_id = new.external_operation_id
              and admission.status = 'admitted'
              and admission.participant_session_id::text =
                  event_row.payload ->> 'participant_session_id'
        ) then
        return new;
    end if;

    raise exception 'committed sync receipt event origin does not match its durable request';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION sync_validate_receipt_event_origin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
    event_row sync_control_events%rowtype;
begin
    if new.outcome <> 'committed' then
        return new;
    end if;

    select *
    into event_row
    from sync_control_events
    where tenant_id = new.tenant_id
      and episode_id = new.episode_id
      and event_id = new.event_id
      and revision = new.resulting_revision;

    if not found then
        raise exception 'committed sync receipt references a missing event';
    end if;

    if event_row.command_id = new.command_id
        and event_row.actor_participant_id = new.participant_id
        and event_row.actor_generation = new.submitted_generation then
        return new;
    end if;

    if new.external_operation_id is not null
        and event_row.external_operation_id = new.external_operation_id then
        return new;
    end if;

    if new.command_name = 'admit_participant'
        and new.external_operation_id is not null
        and event_row.event_name = 'participant_joined'
        and event_row.lifecycle_intent_id is not null
        and exists (
            select 1
            from sync_admission_requests admission
            where admission.tenant_id = new.tenant_id
              and admission.episode_id = new.episode_id
              and admission.decision_external_operation_id = new.external_operation_id
              and admission.status = 'admitted'
              and admission.participant_id::text =
                  event_row.payload ->> 'participant_id'
        ) then
        return new;
    end if;

    raise exception 'committed sync receipt event origin does not match its durable request';
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION transition_participant_join_seat(seat_tenant uuid, seat_space uuid, seat_episode uuid, seat_participant uuid, seat_generation bigint, action text, expected_connection text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql
    AS $$
declare
    seat participant_join_seats%rowtype;
    intent sync_lifecycle_intents%rowtype;
    terminal_state text;
begin
    if action not in ('confirm', 'cancel', 'expire', 'retry') then
        raise exception 'invalid participant join transition';
    end if;
    perform 1 from sync_episode_control
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
    for update;
    perform 1 from episodes
    where tenant_id = seat_tenant and space_id = seat_space and id = seat_episode
    for update;
    perform 1 from participants
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
      and id = seat_participant for update;
    select * into seat from participant_join_seats
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
      and participant_id = seat_participant for update;
    if not found then return 'legacy'; end if;
    if seat.generation != seat_generation then return 'stale'; end if;
    if action='retry' and not exists (select 1 from episodes
        where tenant_id=seat_tenant and space_id=seat_space and id=seat_episode and status='active') then
        return 'episode_ended';
    end if;

    if action='retry' and seat.state='pending' and seat.expires_at > now()
       and exists (select 1 from participants where id=seat_participant
         and status='joining' and first_joined_at is null) then
        -- Each explicit attempt owns a new generation, even if cleanup was lost.
        update participants set generation=generation+1, media_connection_id=null,
            media_connection_generation=null, updated_at=now() where id=seat_participant;
        update participant_join_seats set generation=generation+1,
            expires_at=now()+interval '2 minutes', updated_at=now() where participant_id=seat_participant;
        update sync_lifecycle_intents set participant_generation=seat_generation+1,
            next_attempt_at=now()+interval '2 minutes'
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='pending';
        return 'pending';
    end if;

    if seat.state = 'pending' then
        if action = 'cancel' then
            -- A late failure from an older attempt cannot cancel a newer grant.
            if not exists (select 1 from participants where id = seat_participant
                and media_connection_id = expected_connection) then return 'stale'; end if;
            terminal_state := 'cancelled';
        elsif seat.expires_at <= now() then
            terminal_state := 'expired';
        elsif action = 'confirm' then
            update participant_join_seats set state='joined', updated_at=now()
            where participant_id=seat_participant;
            return 'joined';
        else
            return 'pending';
        end if;

        -- Previous Sync binaries may already have applied the legacy join.
        if not exists (select 1 from participants where id = seat_participant
            and generation = seat_generation and status = 'joining') then return 'joined'; end if;
        update sync_lifecycle_intents
        set status='superseded', terminal_reason='participant_already_terminal', completed_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='pending'
        returning * into intent;
        if not found then return seat.state; end if;
        if intent.journey_id is not null then
            insert into observability_journey_events (
                event_id, journey_id, sequence, occurred_at, name, phase, state,
                origin_kind, first_observed_layer, upstream_visibility, parent_event_id,
                trace_id, span_id, attributes
            ) values (
                gen_random_uuid(), intent.journey_id, 1, now(), 'participant.join_' || terminal_state,
                'terminal', 'cancelled', 'server', case when terminal_state='expired' then 'sync' else 'api' end,
                'visible', intent.parent_journey_event_id, intent.producing_trace_id, intent.producing_span_id,
                jsonb_build_object('participant_id', seat_participant, 'reason', terminal_state)
            );
        end if;
        update participant_join_seats set state=terminal_state, updated_at=now()
        where participant_id=seat_participant;
        update participants set status='left', left_at=now(), updated_at=now() where id=seat_participant;
        update sync_episode_control set
            snapshot_reserved_bytes=snapshot_reserved_bytes-2048,
            lifecycle_reserved_events=lifecycle_reserved_events-2,
            lifecycle_reserved_bytes=lifecycle_reserved_bytes-32768,
            lifecycle_reserved_intents=lifecycle_reserved_intents-1,
            lifecycle_reserved_intent_bytes=lifecycle_reserved_intent_bytes-16384,
            updated_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode;
        seat.state := terminal_state;
    end if;

    if action='retry' and seat.state in ('cancelled','expired') then
        update sync_episode_control set
            snapshot_reserved_bytes=snapshot_reserved_bytes+2048,
            lifecycle_reserved_events=lifecycle_reserved_events+2,
            lifecycle_reserved_bytes=lifecycle_reserved_bytes+32768,
            lifecycle_reserved_intents=lifecycle_reserved_intents+1,
            lifecycle_reserved_intent_bytes=lifecycle_reserved_intent_bytes+16384,
            updated_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and snapshot_bytes+snapshot_reserved_bytes+2048 <= 1048576
          and lifecycle_event_count+lifecycle_reserved_events+2 <= 2048
          and lifecycle_event_bytes+lifecycle_reserved_bytes+32768 <= 33554432
          and lifecycle_intent_count+lifecycle_reserved_intents+1 <= 2048
          and lifecycle_intent_bytes+lifecycle_reserved_intent_bytes+16384 <= 33554432
          and (select count(*) from participants where tenant_id=seat_tenant and space_id=seat_space
            and episode_id=seat_episode and status in ('joining','active','leaving')) < 500;
        if not found then return 'capacity_exceeded'; end if;
        update participants set status='joining', generation=generation+1, left_at=null, media_connection_id=null,
            media_connection_generation=null, updated_at=now() where id=seat_participant;
        update participant_join_seats set state='pending', generation=generation+1, expires_at=now()+interval '2 minutes', updated_at=now()
        where participant_id=seat_participant;
        update sync_lifecycle_intents set status='pending', participant_generation=seat_generation+1, terminal_reason=null, completed_at=null,
            attempt_count=0, last_error_code=null, next_attempt_at=now()+interval '2 minutes'
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='superseded'
          and terminal_reason='participant_already_terminal';
        return 'pending';
    end if;
    return seat.state;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION valid_capabilities(value text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    select value <@ array[
        'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
        'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
        'drawWhiteboard', 'manageWhiteboard', 'manageAdmission',
        'assignRoles', 'muteOthers', 'stopVideoOthers', 'stopScreenOthers',
        'requestMediaOthers', 'removeParticipant', 'manageRecording',
        'startEpisode', 'extendEpisode', 'endEpisode', 'manageMembers',
        'clearSpaceContent'
    ]::text[]
        and cardinality(value) <= 23
        and cardinality(value) = (select count(distinct capability) from unnest(value) as capability)
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION validate_episode_config_snapshot(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
    select jsonb_typeof(value) = 'object'
        and jsonb_typeof(value -> 'roles') = 'object'
        and not exists (
            select 1
            from jsonb_each(value -> 'roles') role_entry
            where jsonb_typeof(role_entry.value) <> 'array'
                or not valid_capabilities(array(select jsonb_array_elements_text(role_entry.value)))
        )
        and jsonb_typeof(value -> 'admission_policy') = 'object'
        and value -> 'admission_policy' ->> 'mode' in ('open', 'knock', 'members_only')
        and (value ->> 'default_episode_duration_seconds')::integer between 60 and 604800
        and (value ->> 'maximum_episode_duration_seconds')::integer between 60 and 604800
        and (value ->> 'default_episode_duration_seconds')::integer <=
            (value ->> 'maximum_episode_duration_seconds')::integer
        and (value ->> 'linger_window_seconds')::integer >= 0
        and (
            not (value ? 'artifact_policy')
            or (
                jsonb_typeof(value -> 'artifact_policy') = 'object'
                and value -> 'artifact_policy' ->> 'schema_version' = 'episode_config.v2'
                and jsonb_typeof(value -> 'artifact_policy' -> 'recording') = 'object'
                and value -> 'artifact_policy' -> 'recording' ->> 'mode' in ('disabled', 'manual', 'automatic')
                and value -> 'artifact_policy' -> 'recording' ->> 'profile' = 'composite_720p_v1'
                and jsonb_typeof(value -> 'artifact_policy' -> 'recording' -> 'retention_seconds') = 'number'
                and (value -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint between 0 and 9223372036
                and jsonb_typeof(value -> 'artifact_policy' -> 'transcription') = 'object'
                and value -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('disabled', 'on_demand', 'automatic')
                and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'retention_seconds') = 'number'
                and (value -> 'artifact_policy' -> 'transcription' ->> 'retention_seconds')::bigint between 0 and 9223372036
                and (
                    (
                        value -> 'artifact_policy' -> 'transcription' ->> 'mode' = 'disabled'
                        and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'source_window_seconds') = 'number'
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint = 0
                    )
                    or (
                        value -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('on_demand', 'automatic')
                        and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'source_window_seconds') = 'number'
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint between 1 and 2592000
                        and value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version' is not null
                        and btrim(value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version') <> ''
                    )
                )
            )
        )
$$;
-- +goose StatementEnd

CREATE TABLE api_key_mutation_requests (
    tenant_id uuid NOT NULL,
    operation text NOT NULL,
    request_key text NOT NULL,
    request_fingerprint bytea NOT NULL,
    api_key_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT api_key_mutation_requests_operation_check CHECK ((operation = ANY (ARRAY['create'::text, 'rotate'::text])))
);

CREATE TABLE api_keys (
    id uuid CONSTRAINT api_keys_id_not_null1 NOT NULL,
    name text CONSTRAINT api_keys_name_not_null1 NOT NULL,
    scopes text[] CONSTRAINT api_keys_scopes_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT api_keys_tenant_id_not_null1 NOT NULL,
    key_hash text CONSTRAINT api_keys_key_hash_not_null1 NOT NULL,
    key_prefix text CONSTRAINT api_keys_key_prefix_not_null1 NOT NULL,
    created_by_user_id uuid,
    last_used_ip inet,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    expires_at timestamp with time zone CONSTRAINT api_keys_expires_at_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT api_keys_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT api_keys_created_at_not_null1 NOT NULL
);

CREATE TABLE artifact_jobs (
    id uuid CONSTRAINT artifact_jobs_id_not_null1 NOT NULL,
    idempotency_key text CONSTRAINT artifact_jobs_idempotency_key_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT artifact_jobs_tenant_id_not_null1 NOT NULL,
    episode_id uuid,
    recording_id uuid,
    transcript_id uuid,
    chunk_id uuid,
    artifact_kind text CONSTRAINT artifact_jobs_artifact_kind_not_null1 NOT NULL,
    payload_schema_version integer CONSTRAINT artifact_jobs_payload_schema_version_not_null1 NOT NULL,
    state text CONSTRAINT artifact_jobs_state_not_null1 NOT NULL,
    priority integer DEFAULT 0 CONSTRAINT artifact_jobs_priority_not_null1 NOT NULL,
    available_at timestamp with time zone DEFAULT now() CONSTRAINT artifact_jobs_available_at_not_null1 NOT NULL,
    attempt_count integer DEFAULT 0 CONSTRAINT artifact_jobs_attempt_count_not_null1 NOT NULL,
    attempt_limit integer DEFAULT 4 CONSTRAINT artifact_jobs_attempt_limit_not_null1 NOT NULL,
    lease_token_hash bytea,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    error_code text,
    error_detail text,
    journey_id uuid,
    traceparent text,
    tracestate text,
    terminal_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT artifact_jobs_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT artifact_jobs_created_at_not_null1 NOT NULL,
    transcript_language text DEFAULT 'auto'::text NOT NULL,
    CONSTRAINT artifact_jobs_attempt_count_check CHECK (((attempt_count >= 0) AND (attempt_count <= attempt_limit))),
    CONSTRAINT artifact_jobs_attempt_limit_check CHECK ((attempt_limit BETWEEN 1 AND 32)),
    CONSTRAINT artifact_jobs_error_code_check CHECK (((error_code IS NULL) OR (length(error_code) BETWEEN 1 AND 128))),
    CONSTRAINT artifact_jobs_error_detail_check CHECK (((error_detail IS NULL) OR (octet_length(error_detail) <= 2048))),
    CONSTRAINT artifact_jobs_key_check CHECK ((idempotency_key ~ '^[A-Za-z0-9._-]{1,128}$'::text)),
    CONSTRAINT artifact_jobs_kind_check CHECK ((artifact_kind = ANY (ARRAY['recording'::text, 'transcription'::text, 'transcription_chunk'::text, 'transcription_finalize'::text]))),
    CONSTRAINT artifact_jobs_lease_fields_check CHECK ((((lease_token_hash IS NULL) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_token_hash IS NOT NULL) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT artifact_jobs_lease_hash_check CHECK (((lease_token_hash IS NULL) OR (octet_length(lease_token_hash) = 32))),
    CONSTRAINT artifact_jobs_owner_check CHECK (((lease_owner IS NULL) OR (length(lease_owner) BETWEEN 1 AND 128))),
    CONSTRAINT artifact_jobs_priority_check CHECK (((priority >= '-100'::integer) AND (priority <= 100))),
    CONSTRAINT artifact_jobs_schema_version_check CHECK ((payload_schema_version BETWEEN 1 AND 99)),
    CONSTRAINT artifact_jobs_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'leased'::text, 'retryable'::text, 'completed'::text, 'dead_letter'::text, 'cancelled'::text]))),
    CONSTRAINT artifact_jobs_terminal_fields_check CHECK (((state = ANY (ARRAY['completed'::text, 'dead_letter'::text, 'cancelled'::text])) = (terminal_at IS NOT NULL))),
    CONSTRAINT artifact_jobs_traceparent_check CHECK (((traceparent IS NULL) OR (length(traceparent) <= 256))),
    CONSTRAINT artifact_jobs_tracestate_check CHECK (((tracestate IS NULL) OR (length(tracestate) <= 512))),
    CONSTRAINT artifact_jobs_transcript_language_check CHECK ((transcript_language = ANY (ARRAY['auto'::text, 'af'::text, 'am'::text, 'ar'::text, 'as'::text, 'az'::text, 'ba'::text, 'be'::text, 'bg'::text, 'bn'::text, 'bo'::text, 'br'::text, 'bs'::text, 'ca'::text, 'cs'::text, 'cy'::text, 'da'::text, 'de'::text, 'el'::text, 'en'::text, 'es'::text, 'et'::text, 'eu'::text, 'fa'::text, 'fi'::text, 'fo'::text, 'fr'::text, 'gl'::text, 'gu'::text, 'ha'::text, 'haw'::text, 'he'::text, 'hi'::text, 'hr'::text, 'ht'::text, 'hu'::text, 'hy'::text, 'id'::text, 'is'::text, 'it'::text, 'ja'::text, 'jw'::text, 'ka'::text, 'kk'::text, 'km'::text, 'kn'::text, 'ko'::text, 'la'::text, 'lb'::text, 'ln'::text, 'lo'::text, 'lt'::text, 'lv'::text, 'mg'::text, 'mi'::text, 'mk'::text, 'ml'::text, 'mn'::text, 'mr'::text, 'ms'::text, 'mt'::text, 'my'::text, 'ne'::text, 'nl'::text, 'nn'::text, 'no'::text, 'oc'::text, 'pa'::text, 'pl'::text, 'ps'::text, 'pt'::text, 'ro'::text, 'ru'::text, 'sa'::text, 'sd'::text, 'si'::text, 'sk'::text, 'sl'::text, 'sn'::text, 'so'::text, 'sq'::text, 'sr'::text, 'su'::text, 'sv'::text, 'sw'::text, 'ta'::text, 'te'::text, 'tg'::text, 'th'::text, 'tk'::text, 'tl'::text, 'tr'::text, 'tt'::text, 'uk'::text, 'ur'::text, 'uz'::text, 'vi'::text, 'yi'::text, 'yo'::text, 'yue'::text, 'zh'::text])))
);

CREATE TABLE auth_identities (
    id uuid CONSTRAINT auth_identities_id_not_null1 NOT NULL,
    user_id uuid CONSTRAINT auth_identities_user_id_not_null1 NOT NULL,
    provider text CONSTRAINT auth_identities_provider_not_null1 NOT NULL,
    provider_subject text CONSTRAINT auth_identities_provider_subject_not_null1 NOT NULL,
    password_hash text,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT auth_identities_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT auth_identities_created_at_not_null1 NOT NULL
);

CREATE TABLE auto_space_lifecycles (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    creator_arrival_handle uuid,
    state text NOT NULL,
    claim_expires_at timestamp with time zone,
    next_retry_at timestamp with time zone,
    retry_count integer DEFAULT 0 NOT NULL,
    last_error_family text,
    archive_completed_at timestamp with time zone,
    journey_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auto_space_lifecycles_check CHECK (((state = 'archiving'::text) = (claim_expires_at IS NOT NULL))),
    CONSTRAINT auto_space_lifecycles_check1 CHECK (((state <> 'archived'::text) OR (archive_completed_at IS NOT NULL))),
    CONSTRAINT auto_space_lifecycles_last_error_family_check CHECK (((last_error_family IS NULL) OR (octet_length(last_error_family) BETWEEN 1 AND 64))),
    CONSTRAINT auto_space_lifecycles_retry_count_check CHECK ((retry_count >= 0)),
    CONSTRAINT auto_space_lifecycles_state_check CHECK ((state = ANY (ARRAY['active'::text, 'archiving'::text, 'archived'::text])))
);

CREATE TABLE automatic_transcript_space_policy_backup (
    space_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    transcription_policy text CONSTRAINT automatic_transcript_space_policy_transcription_policy_not_null NOT NULL,
    updated_at timestamp with time zone NOT NULL
);

CREATE TABLE automatic_transcript_tenant_policy_backup (
    tenant_id uuid NOT NULL,
    transcription_ceiling text CONSTRAINT automatic_transcript_tenant_poli_transcription_ceiling_not_null NOT NULL,
    transcription_default_mode text CONSTRAINT automatic_transcript_tenant_transcription_default_mode_not_null NOT NULL,
    provider_policy_version text CONSTRAINT automatic_transcript_tenant_po_provider_policy_version_not_null NOT NULL,
    source_window_seconds bigint CONSTRAINT automatic_transcript_tenant_poli_source_window_seconds_not_null NOT NULL,
    updated_at timestamp with time zone NOT NULL
);

CREATE TABLE episode_create_requests (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    request_key text NOT NULL,
    request_fingerprint bytea NOT NULL,
    episode_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT episode_create_requests_request_fingerprint_check CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT episode_create_requests_request_key_check CHECK ((request_key ~ '^[A-Za-z0-9_-]{16,128}$'::text))
);

CREATE TABLE episode_presence_leases (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE episodes (
    id uuid NOT NULL,
    status text NOT NULL,
    metadata jsonb,
    space_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_by_user_id uuid,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    config_snapshot jsonb NOT NULL,
    end_reason text,
    deadline_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    deadline_generation bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT episodes_config_snapshot_check CHECK (validate_episode_config_snapshot(config_snapshot)),
    CONSTRAINT episodes_deadline_generation_check CHECK ((deadline_generation > 0)),
    CONSTRAINT episodes_end_reason_check CHECK ((end_reason = ANY (ARRAY['explicit'::text, 'natural'::text, 'deadline'::text]))),
    CONSTRAINT episodes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'ending'::text, 'ended'::text])))
);

CREATE TABLE identities (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    external_id text NOT NULL,
    display_name text NOT NULL,
    metadata jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identities_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'agent'::text])))
);

CREATE TABLE login_sessions (
    id uuid CONSTRAINT login_sessions_id_not_null1 NOT NULL,
    user_id uuid CONSTRAINT login_sessions_user_id_not_null1 NOT NULL,
    token_hash text CONSTRAINT login_sessions_token_hash_not_null1 NOT NULL,
    user_agent text,
    device_name text,
    ip_address inet,
    expires_at timestamp with time zone CONSTRAINT login_sessions_expires_at_not_null1 NOT NULL,
    revoked_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT login_sessions_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT login_sessions_created_at_not_null1 NOT NULL
);

CREATE TABLE mcp_oauth_authorization_requests (
    request_hash text NOT NULL,
    client_id uuid NOT NULL,
    redirect_uri text NOT NULL,
    redirect_uri_supplied boolean NOT NULL,
    state text,
    code_challenge text NOT NULL,
    scopes text[] NOT NULL,
    resource text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE mcp_oauth_clients (
    id uuid NOT NULL,
    client_id text NOT NULL,
    client_name text NOT NULL,
    redirect_uris text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_oauth_clients_redirect_uris_count_check CHECK ((cardinality(redirect_uris) BETWEEN 1 AND 5))
);

CREATE TABLE mcp_oauth_codes (
    code_hash text NOT NULL,
    grant_id uuid NOT NULL,
    redirect_uri text NOT NULL,
    redirect_uri_supplied boolean NOT NULL,
    code_challenge text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone
);

CREATE TABLE mcp_oauth_grants (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    client_id uuid NOT NULL,
    scopes text[] NOT NULL,
    resource text NOT NULL,
    approved_by_service_id text NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE mcp_oauth_tokens (
    token_hash text NOT NULL,
    kind text NOT NULL,
    grant_id uuid NOT NULL,
    resource text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_oauth_tokens_kind_check CHECK ((kind = ANY (ARRAY['access'::text, 'refresh'::text])))
);

CREATE TABLE memberships (
    id uuid CONSTRAINT memberships_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT memberships_tenant_id_not_null1 NOT NULL,
    user_id uuid CONSTRAINT memberships_user_id_not_null1 NOT NULL,
    role text CONSTRAINT memberships_role_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT memberships_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT memberships_created_at_not_null1 NOT NULL
);

CREATE TABLE observability_journey_events (
    event_id uuid CONSTRAINT observability_journey_events_event_id_not_null1 NOT NULL,
    journey_id uuid CONSTRAINT observability_journey_events_journey_id_not_null1 NOT NULL,
    sequence bigint CONSTRAINT observability_journey_events_sequence_not_null1 NOT NULL,
    occurred_at timestamp with time zone CONSTRAINT observability_journey_events_occurred_at_not_null1 NOT NULL,
    received_at timestamp with time zone DEFAULT now() CONSTRAINT observability_journey_events_received_at_not_null1 NOT NULL,
    name text CONSTRAINT observability_journey_events_name_not_null1 NOT NULL,
    phase text CONSTRAINT observability_journey_events_phase_not_null1 NOT NULL,
    state text CONSTRAINT observability_journey_events_state_not_null1 NOT NULL,
    origin_kind text CONSTRAINT observability_journey_events_origin_kind_not_null1 NOT NULL,
    first_observed_layer text CONSTRAINT observability_journey_events_first_observed_layer_not_null1 NOT NULL,
    upstream_visibility text CONSTRAINT observability_journey_events_upstream_visibility_not_null1 NOT NULL,
    parent_event_id uuid,
    trace_id text,
    span_id text,
    attributes jsonb DEFAULT '{}'::jsonb CONSTRAINT observability_journey_events_attributes_not_null1 NOT NULL,
    CONSTRAINT observability_journey_events_attributes_check1 CHECK ((jsonb_typeof(attributes) = 'object'::text)),
    CONSTRAINT observability_journey_events_sequence_check1 CHECK ((sequence >= 0))
);

CREATE TABLE participant_device_hints (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    generation bigint NOT NULL,
    device_type text,
    CONSTRAINT participant_device_hints_device_type_check CHECK ((device_type = ANY (ARRAY['phone'::text, 'tablet'::text, 'computer'::text]))),
    CONSTRAINT participant_device_hints_generation_check CHECK ((generation > 0))
);

CREATE TABLE participant_join_seats (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    generation bigint NOT NULL,
    state text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    entry_token_id text,
    issued_entry_generation bigint DEFAULT 0 NOT NULL,
    confirmed_entry_generation bigint DEFAULT 0 NOT NULL,
    issued_entry_expires_at timestamp with time zone DEFAULT (now() + '00:02:00'::interval) NOT NULL,
    CONSTRAINT participant_join_seats_check CHECK (((confirmed_entry_generation >= 0) AND (confirmed_entry_generation <= issued_entry_generation))),
    CONSTRAINT participant_join_seats_entry_token_id_check CHECK ((octet_length(entry_token_id) BETWEEN 1 AND 128)),
    CONSTRAINT participant_join_seats_generation_check CHECK ((generation > 0)),
    CONSTRAINT participant_join_seats_issued_entry_generation_check CHECK (((issued_entry_generation >= 0) AND (issued_entry_generation <= '9007199254740991'::bigint))),
    CONSTRAINT participant_join_seats_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'joined'::text, 'left'::text, 'cancelled'::text, 'expired'::text])))
);

CREATE TABLE participant_media_refreshes (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    participant_generation bigint NOT NULL,
    request_hash bytea NOT NULL,
    connection_id text NOT NULL,
    response_ciphertext bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT participant_media_refreshes_participant_generation_check CHECK ((participant_generation > 0)),
    CONSTRAINT participant_media_refreshes_request_hash_check CHECK ((octet_length(request_hash) = 32))
);

CREATE TABLE participant_presence_leases (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    generation bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE participants (
    id uuid CONSTRAINT participants_id_not_null1 NOT NULL,
    name text,
    metadata jsonb,
    capabilities text[] CONSTRAINT participants_capabilities_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT participants_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    identity_id uuid,
    generation bigint CONSTRAINT participants_generation_not_null1 NOT NULL,
    status text CONSTRAINT participants_status_not_null1 NOT NULL,
    role text CONSTRAINT participants_role_not_null1 NOT NULL,
    joined_at timestamp with time zone,
    left_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT participants_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT participants_created_at_not_null1 NOT NULL,
    account_id uuid,
    media_connection_id text,
    media_connection_generation bigint,
    first_joined_at timestamp with time zone,
    last_left_reason text,
    CONSTRAINT participants_capabilities_check CHECK (((cardinality(capabilities) > 0) AND valid_capabilities(capabilities))),
    CONSTRAINT participants_generation_check CHECK ((generation > 0)),
    CONSTRAINT participants_last_left_reason_check CHECK ((last_left_reason = ANY (ARRAY['left'::text, 'episode_ended'::text]))),
    CONSTRAINT participants_status_check CHECK ((status = ANY (ARRAY['joining'::text, 'active'::text, 'leaving'::text, 'left'::text])))
);

CREATE TABLE password_resets (
    account_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE provider_operation_observation_heads (
    tenant_id uuid CONSTRAINT provider_operation_observation_heads_tenant_id_not_null1 NOT NULL,
    episode_id uuid NOT NULL,
    incarnation bigint DEFAULT 0 CONSTRAINT provider_operation_observation_heads_incarnation_not_null1 NOT NULL,
    sequence bigint DEFAULT 0 CONSTRAINT provider_operation_observation_heads_sequence_not_null1 NOT NULL,
    observation_fingerprint bytea DEFAULT decode(repeat('00'::text, 32), 'hex'::text) CONSTRAINT provider_operation_observatio_observation_fingerprint_not_null2 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT provider_operation_observation_heads_updated_at_not_null1 NOT NULL,
    CONSTRAINT provider_operation_observation_heads_cursor_check CHECK (((incarnation >= 0) AND (sequence >= 0))),
    CONSTRAINT provider_operation_observation_heads_fingerprint_check CHECK ((octet_length(observation_fingerprint) = 32))
);

CREATE TABLE provider_operation_observations (
    tenant_id uuid CONSTRAINT provider_operation_observations_tenant_id_not_null1 NOT NULL,
    episode_id uuid NOT NULL,
    incarnation bigint CONSTRAINT provider_operation_observations_incarnation_not_null1 NOT NULL,
    sequence bigint CONSTRAINT provider_operation_observations_sequence_not_null1 NOT NULL,
    publications jsonb CONSTRAINT provider_operation_observations_publications_not_null1 NOT NULL,
    observation_fingerprint bytea CONSTRAINT provider_operation_observatio_observation_fingerprint_not_null3 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT provider_operation_observations_created_at_not_null1 NOT NULL,
    CONSTRAINT provider_operation_observations_cursor_check CHECK (((incarnation >= 0) AND (sequence >= 0))),
    CONSTRAINT provider_operation_observations_fingerprint_check CHECK ((octet_length(observation_fingerprint) = 32)),
    CONSTRAINT provider_operation_observations_publications_check CHECK (((jsonb_typeof(publications) = 'array'::text) AND (octet_length((publications)::text) <= 16384)))
);

CREATE TABLE provider_operation_receipts (
    operation_id text CONSTRAINT provider_operation_receipts_operation_id_not_null1 NOT NULL,
    effect text CONSTRAINT provider_operation_receipts_effect_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT provider_operation_receipts_tenant_id_not_null1 NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid,
    participant_generation bigint,
    publication_source text,
    recording_id uuid,
    request_fingerprint bytea CONSTRAINT provider_operation_receipts_request_fingerprint_not_null1 NOT NULL,
    request_payload jsonb CONSTRAINT provider_operation_receipts_request_payload_not_null1 NOT NULL,
    state text DEFAULT 'prepared'::text CONSTRAINT provider_operation_receipts_state_not_null1 NOT NULL,
    outcome text,
    reason text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT provider_operation_receipts_created_at_not_null1 NOT NULL,
    dispatching_at timestamp with time zone,
    completed_at timestamp with time zone,
    last_error_code text,
    CONSTRAINT provider_operation_receipts_dispatching_check CHECK ((((state = 'prepared'::text) AND (dispatching_at IS NULL)) OR ((state = ANY (ARRAY['dispatching'::text, 'completed'::text])) AND (dispatching_at IS NOT NULL)))),
    CONSTRAINT provider_operation_receipts_effect_check CHECK ((effect = ANY (ARRAY['media.grant_publication'::text, 'media.revoke_publication'::text, 'media.remove_participant'::text, 'media.end_episode'::text, 'recording.start'::text, 'recording.stop'::text]))),
    CONSTRAINT provider_operation_receipts_effect_fields_check CHECK ((((effect = ANY (ARRAY['media.grant_publication'::text, 'media.revoke_publication'::text])) AND (participant_id IS NOT NULL) AND (publication_source IS NOT NULL) AND (recording_id IS NULL)) OR ((effect = 'media.remove_participant'::text) AND (participant_id IS NOT NULL) AND (publication_source IS NULL) AND (recording_id IS NULL)) OR ((effect = 'media.end_episode'::text) AND (participant_id IS NULL) AND (publication_source IS NULL) AND (recording_id IS NULL)) OR ((effect = ANY (ARRAY['recording.start'::text, 'recording.stop'::text])) AND (participant_id IS NULL) AND (publication_source IS NULL) AND (recording_id IS NOT NULL)))),
    CONSTRAINT provider_operation_receipts_error_code_check CHECK (((last_error_code IS NULL) OR (octet_length(last_error_code) BETWEEN 1 AND 256))),
    CONSTRAINT provider_operation_receipts_fingerprint_check CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT provider_operation_receipts_operation_id_check CHECK ((operation_id ~ '^[A-Za-z0-9_-]{16,128}$'::text)),
    CONSTRAINT provider_operation_receipts_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['confirmed'::text, 'satisfied'::text, 'retryable_failure'::text, 'terminal_failure'::text, 'ambiguous'::text])))),
    CONSTRAINT provider_operation_receipts_participant_check CHECK ((((participant_id IS NOT NULL) OR (participant_generation IS NULL)) AND ((participant_generation IS NULL) OR (participant_generation > 0)))),
    CONSTRAINT provider_operation_receipts_payload_check CHECK ((octet_length((request_payload)::text) <= 16384)),
    CONSTRAINT provider_operation_receipts_reason_check CHECK (((reason IS NULL) OR (octet_length(reason) BETWEEN 1 AND 256))),
    CONSTRAINT provider_operation_receipts_source_check CHECK (((publication_source IS NULL) OR (publication_source = ANY (ARRAY['microphone'::text, 'camera'::text, 'screen'::text])))),
    CONSTRAINT provider_operation_receipts_state_check CHECK ((state = ANY (ARRAY['prepared'::text, 'dispatching'::text, 'completed'::text]))),
    CONSTRAINT provider_operation_receipts_state_outcome_check CHECK ((((state = ANY (ARRAY['prepared'::text, 'dispatching'::text])) AND (outcome IS NULL) AND (completed_at IS NULL)) OR ((state = 'completed'::text) AND (outcome IS NOT NULL) AND (completed_at IS NOT NULL))))
);

CREATE TABLE recording_artifacts (
    recording_id uuid CONSTRAINT recording_artifacts_recording_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT recording_artifacts_tenant_id_not_null1 NOT NULL,
    render_job_id uuid CONSTRAINT recording_artifacts_render_job_id_not_null1 NOT NULL,
    object_key text CONSTRAINT recording_artifacts_object_key_not_null1 NOT NULL,
    content_type text CONSTRAINT recording_artifacts_content_type_not_null1 NOT NULL,
    byte_size bigint CONSTRAINT recording_artifacts_byte_size_not_null1 NOT NULL,
    checksum bytea CONSTRAINT recording_artifacts_checksum_not_null1 NOT NULL,
    duration_millis bigint CONSTRAINT recording_artifacts_duration_millis_not_null1 NOT NULL,
    committed_at timestamp with time zone CONSTRAINT recording_artifacts_committed_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT recording_artifacts_created_at_not_null1 NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT recording_artifacts_byte_size_check1 CHECK ((byte_size >= 0)),
    CONSTRAINT recording_artifacts_checksum_check1 CHECK ((octet_length(checksum) BETWEEN 16 AND 128)),
    CONSTRAINT recording_artifacts_duration_millis_check1 CHECK ((duration_millis >= 0)),
    CONSTRAINT recording_artifacts_expiry_check CHECK (((expires_at IS NULL) OR (expires_at > committed_at)))
);

CREATE TABLE recording_bundle_allocations (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    job_id uuid NOT NULL,
    object_handle uuid NOT NULL,
    reservation_request_id uuid NOT NULL,
    allocation_version bigint NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    capture_epoch bigint NOT NULL,
    envelope_digest bytea NOT NULL,
    sequence_number bigint NOT NULL,
    codec text NOT NULL,
    layer text,
    monotonic_start_millis bigint NOT NULL,
    monotonic_end_millis bigint NOT NULL,
    media_start_millis bigint NOT NULL,
    media_end_millis bigint NOT NULL,
    object_key text NOT NULL,
    upload_token_hash bytea NOT NULL,
    expected_byte_size bigint NOT NULL,
    expected_checksum bytea NOT NULL,
    content_type text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    encryption_context_digest bytea NOT NULL,
    state text DEFAULT 'allocated'::text NOT NULL,
    object_version text,
    object_etag text,
    object_checksum bytea,
    manifest_digest bytea,
    committed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_bundle_allocations_allocation_version_check CHECK ((allocation_version > 0)),
    CONSTRAINT recording_bundle_allocations_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_bundle_allocations_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_bundle_allocations_check CHECK ((monotonic_end_millis >= monotonic_start_millis)),
    CONSTRAINT recording_bundle_allocations_check1 CHECK ((media_end_millis >= media_start_millis)),
    CONSTRAINT recording_bundle_allocations_commit_facts_check CHECK ((((state = ANY (ARRAY['reserved'::text, 'allocated'::text])) AND (object_version IS NULL) AND (object_etag IS NULL) AND (object_checksum IS NULL) AND (manifest_digest IS NULL) AND (committed_at IS NULL)) OR ((state = 'committed'::text) AND (object_version IS NOT NULL) AND (object_etag IS NOT NULL) AND (octet_length(object_checksum) = 32) AND (octet_length(manifest_digest) = 32) AND (committed_at IS NOT NULL)))),
    CONSTRAINT recording_bundle_allocations_encryption_context_digest_check CHECK ((octet_length(encryption_context_digest) = 32)),
    CONSTRAINT recording_bundle_allocations_envelope_digest_check CHECK ((octet_length(envelope_digest) = 32)),
    CONSTRAINT recording_bundle_allocations_expected_byte_size_check CHECK ((expected_byte_size >= 0)),
    CONSTRAINT recording_bundle_allocations_expected_checksum_check CHECK ((octet_length(expected_checksum) = 32)),
    CONSTRAINT recording_bundle_allocations_fencing_generation_check CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_bundle_allocations_media_start_millis_check CHECK ((media_start_millis >= 0)),
    CONSTRAINT recording_bundle_allocations_monotonic_start_millis_check CHECK ((monotonic_start_millis >= 0)),
    CONSTRAINT recording_bundle_allocations_sequence_number_check CHECK ((sequence_number >= 0)),
    CONSTRAINT recording_bundle_allocations_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'allocated'::text, 'committed'::text]))),
    CONSTRAINT recording_bundle_allocations_upload_token_hash_check CHECK ((octet_length(upload_token_hash) = 32))
);

CREATE TABLE recording_bundles (
    id uuid CONSTRAINT recording_bundles_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT recording_bundles_tenant_id_not_null1 NOT NULL,
    recording_id uuid CONSTRAINT recording_bundles_recording_id_not_null1 NOT NULL,
    capture_job_id uuid CONSTRAINT recording_bundles_capture_job_id_not_null1 NOT NULL,
    sequence_number bigint CONSTRAINT recording_bundles_sequence_number_not_null1 NOT NULL,
    fencing_generation bigint CONSTRAINT recording_bundles_fencing_generation_not_null1 NOT NULL,
    object_key text CONSTRAINT recording_bundles_object_key_not_null1 NOT NULL,
    content_type text CONSTRAINT recording_bundles_content_type_not_null1 NOT NULL,
    codec text CONSTRAINT recording_bundles_codec_not_null1 NOT NULL,
    layer text,
    byte_size bigint CONSTRAINT recording_bundles_byte_size_not_null1 NOT NULL,
    checksum bytea CONSTRAINT recording_bundles_checksum_not_null1 NOT NULL,
    monotonic_start_millis bigint CONSTRAINT recording_bundles_monotonic_start_millis_not_null1 NOT NULL,
    monotonic_end_millis bigint CONSTRAINT recording_bundles_monotonic_end_millis_not_null1 NOT NULL,
    media_start_millis bigint CONSTRAINT recording_bundles_media_start_millis_not_null1 NOT NULL,
    media_end_millis bigint CONSTRAINT recording_bundles_media_end_millis_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT recording_bundles_created_at_not_null1 NOT NULL,
    allocation_id uuid,
    object_version text,
    object_etag text,
    capture_epoch bigint,
    envelope_digest bytea,
    encryption_context_digest bytea,
    manifest_digest bytea,
    CONSTRAINT recording_bundles_byte_size_check1 CHECK ((byte_size >= 0)),
    CONSTRAINT recording_bundles_check2 CHECK ((monotonic_end_millis >= monotonic_start_millis)),
    CONSTRAINT recording_bundles_check3 CHECK ((media_end_millis >= media_start_millis)),
    CONSTRAINT recording_bundles_checksum_check1 CHECK ((octet_length(checksum) BETWEEN 16 AND 128)),
    CONSTRAINT recording_bundles_fencing_generation_check1 CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_bundles_media_start_millis_check1 CHECK ((media_start_millis >= 0)),
    CONSTRAINT recording_bundles_monotonic_start_millis_check1 CHECK ((monotonic_start_millis >= 0)),
    CONSTRAINT recording_bundles_sequence_number_check1 CHECK ((sequence_number >= 0))
);

CREATE TABLE recording_capacity (
    id smallint CONSTRAINT recording_capacity_id_not_null1 NOT NULL,
    reserved_episodes integer DEFAULT 0 NOT NULL,
    reserved_participants integer DEFAULT 0 CONSTRAINT recording_capacity_reserved_participants_not_null1 NOT NULL,
    reserved_input_bitrate_bps bigint DEFAULT 0 CONSTRAINT recording_capacity_reserved_input_bitrate_bps_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT recording_capacity_updated_at_not_null1 NOT NULL,
    CONSTRAINT recording_capacity_id_check1 CHECK ((id = 1)),
    CONSTRAINT recording_capacity_reserved_episodes_check CHECK ((reserved_episodes BETWEEN 0 AND 20)),
    CONSTRAINT recording_capacity_reserved_input_bitrate_bps_check1 CHECK ((reserved_input_bitrate_bps >= 0)),
    CONSTRAINT recording_capacity_reserved_participants_check1 CHECK ((reserved_participants BETWEEN 0 AND 200))
);

CREATE TABLE recording_capture_commands (
    id bigint NOT NULL,
    signaling_handle uuid NOT NULL,
    capture_epoch bigint NOT NULL,
    sequence bigint NOT NULL,
    recording_id uuid NOT NULL,
    plan_revision bigint NOT NULL,
    operation_kind text NOT NULL,
    idempotency_key text NOT NULL,
    request_bytes bytea NOT NULL,
    request_fingerprint bytea NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    execution_attempt integer DEFAULT 0 NOT NULL,
    execution_token uuid,
    execution_expires_at timestamp with time zone,
    not_before timestamp with time zone DEFAULT now() NOT NULL,
    result_bytes bytea,
    result_fingerprint bytea,
    provider_failure_class text,
    provider_failure_code text,
    provider_failure_retryable boolean,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    leased_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_capture_commands_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_capture_commands_execution_attempt_check CHECK ((execution_attempt >= 0)),
    CONSTRAINT recording_capture_commands_execution_check CHECK ((((state = 'leased'::text) AND (execution_token IS NOT NULL) AND (execution_expires_at IS NOT NULL)) OR ((state <> 'leased'::text) AND (execution_token IS NULL) AND (execution_expires_at IS NULL)))),
    CONSTRAINT recording_capture_commands_failure_check CHECK ((((state = ANY (ARRAY['retryable'::text, 'terminal'::text])) AND (provider_failure_class IS NOT NULL) AND (provider_failure_retryable IS NOT NULL)) OR ((state <> ALL (ARRAY['retryable'::text, 'terminal'::text])) AND (provider_failure_class IS NULL) AND (provider_failure_code IS NULL) AND (provider_failure_retryable IS NULL)))),
    CONSTRAINT recording_capture_commands_idempotency_key_check CHECK ((octet_length(idempotency_key) BETWEEN 1 AND 128)),
    CONSTRAINT recording_capture_commands_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['create_capture_connection'::text, 'pull_capture_tracks'::text, 'renegotiate_capture_connection'::text, 'inspect_capture_connection'::text, 'close_capture_tracks'::text, 'close_capture_connection'::text]))),
    CONSTRAINT recording_capture_commands_plan_revision_check CHECK ((plan_revision > 0)),
    CONSTRAINT recording_capture_commands_provider_failure_class_check CHECK (((provider_failure_class IS NULL) OR (provider_failure_class = ANY (ARRAY['unavailable'::text, 'rate_limited'::text, 'unauthorized'::text, 'not_found'::text, 'protocol'::text])))),
    CONSTRAINT recording_capture_commands_provider_failure_code_check CHECK (((provider_failure_code IS NULL) OR (octet_length(provider_failure_code) BETWEEN 1 AND 128))),
    CONSTRAINT recording_capture_commands_request_bytes_check CHECK ((octet_length(request_bytes) BETWEEN 1 AND 2097152)),
    CONSTRAINT recording_capture_commands_request_fingerprint_check CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT recording_capture_commands_result_bytes_check CHECK (((result_bytes IS NULL) OR (octet_length(result_bytes) BETWEEN 1 AND 2097152))),
    CONSTRAINT recording_capture_commands_result_check CHECK ((((state = 'completed'::text) AND (result_bytes IS NOT NULL) AND (result_fingerprint IS NOT NULL)) OR ((state <> 'completed'::text) AND (result_bytes IS NULL) AND (result_fingerprint IS NULL)))),
    CONSTRAINT recording_capture_commands_result_fingerprint_check CHECK (((result_fingerprint IS NULL) OR (octet_length(result_fingerprint) = 32))),
    CONSTRAINT recording_capture_commands_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT recording_capture_commands_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'leased'::text, 'completed'::text, 'retryable'::text, 'terminal'::text, 'ambiguous'::text])))
);

ALTER TABLE recording_capture_commands ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME recording_capture_commands_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE recording_capture_connections (
    signaling_handle uuid NOT NULL,
    capture_epoch bigint NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    job_id uuid NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    envelope_digest bytea NOT NULL,
    provider_connection_reference text,
    state text DEFAULT 'pending'::text NOT NULL,
    latest_plan_revision bigint DEFAULT 0 NOT NULL,
    negotiation_id text,
    negotiation_requirement text DEFAULT 'not_required'::text NOT NULL,
    negotiation_plan_revision bigint,
    next_sequence bigint DEFAULT 1 NOT NULL,
    active_command_id bigint,
    active_execution_token uuid,
    active_execution_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_capture_connection_provider_connection_referenc_check CHECK (((provider_connection_reference IS NULL) OR (octet_length(provider_connection_reference) BETWEEN 1 AND 512))),
    CONSTRAINT recording_capture_connections_active_execution_check CHECK ((((active_command_id IS NULL) AND (active_execution_token IS NULL) AND (active_execution_expires_at IS NULL)) OR ((active_command_id IS NOT NULL) AND (active_execution_token IS NOT NULL) AND (active_execution_expires_at IS NOT NULL)))),
    CONSTRAINT recording_capture_connections_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_capture_connections_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_capture_connections_envelope_digest_check CHECK ((octet_length(envelope_digest) = 32)),
    CONSTRAINT recording_capture_connections_fencing_generation_check CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_capture_connections_latest_plan_revision_check CHECK ((latest_plan_revision >= 0)),
    CONSTRAINT recording_capture_connections_negotiation_check CHECK ((((negotiation_requirement = 'not_required'::text) AND (negotiation_id IS NULL) AND (negotiation_plan_revision IS NULL)) OR ((negotiation_requirement = ANY (ARRAY['answer_needed'::text, 'offer_needed'::text])) AND (negotiation_id IS NOT NULL) AND (negotiation_plan_revision IS NOT NULL)))),
    CONSTRAINT recording_capture_connections_negotiation_id_check CHECK (((negotiation_id IS NULL) OR (octet_length(negotiation_id) BETWEEN 1 AND 512))),
    CONSTRAINT recording_capture_connections_negotiation_plan_revision_check CHECK (((negotiation_plan_revision IS NULL) OR (negotiation_plan_revision > 0))),
    CONSTRAINT recording_capture_connections_negotiation_requirement_check CHECK ((negotiation_requirement = ANY (ARRAY['not_required'::text, 'answer_needed'::text, 'offer_needed'::text]))),
    CONSTRAINT recording_capture_connections_next_sequence_check CHECK ((next_sequence > 0)),
    CONSTRAINT recording_capture_connections_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'connecting'::text, 'connected'::text, 'disconnected'::text, 'closed'::text])))
);

CREATE TABLE recording_capture_plans (
    plan_handle uuid NOT NULL,
    revision bigint NOT NULL,
    job_id uuid NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    capture_epoch bigint NOT NULL,
    envelope_digest bytea NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    episode_control_revision bigint NOT NULL,
    provider_incarnation bigint NOT NULL,
    provider_sequence bigint NOT NULL,
    plan_schema_version text NOT NULL,
    plan_bytes bytea NOT NULL,
    plan_fingerprint bytea NOT NULL,
    effective_deadline_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_capture_plans_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_capture_plans_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_capture_plans_envelope_digest_check CHECK ((octet_length(envelope_digest) = 32)),
    CONSTRAINT recording_capture_plans_episode_control_revision_check CHECK ((episode_control_revision >= 0)),
    CONSTRAINT recording_capture_plans_fencing_generation_check CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_capture_plans_plan_bytes_check CHECK ((octet_length(plan_bytes) BETWEEN 1 AND 262144)),
    CONSTRAINT recording_capture_plans_plan_fingerprint_check CHECK ((octet_length(plan_fingerprint) = 32)),
    CONSTRAINT recording_capture_plans_plan_schema_version_check CHECK ((plan_schema_version = 'capture_plan.v1'::text)),
    CONSTRAINT recording_capture_plans_provider_incarnation_check CHECK ((provider_incarnation >= 0)),
    CONSTRAINT recording_capture_plans_provider_sequence_check CHECK ((provider_sequence >= 0)),
    CONSTRAINT recording_capture_plans_revision_check CHECK ((revision > 0))
);

CREATE TABLE recording_capture_provider_rate_budget (
    id smallint NOT NULL,
    next_call_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_capture_provider_rate_budget_id_check CHECK ((id = 1))
);

CREATE TABLE recording_capture_publication_failures (
    job_id uuid NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint CONSTRAINT recording_capture_publication_failu_fencing_generation_not_null NOT NULL
);

CREATE TABLE recording_capture_retired_publications (
    tenant_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    publication_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_capture_retired_publications_publication_id_check CHECK ((octet_length(publication_id) BETWEEN 1 AND 512))
);

CREATE TABLE recording_capture_stop_publications (
    recording_id uuid NOT NULL,
    stop_operation_id uuid NOT NULL,
    capture_epoch bigint NOT NULL,
    producing_trace_id text,
    producing_span_id text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    attempt_count bigint DEFAULT 0 NOT NULL,
    last_error_code text,
    resolved_at timestamp with time zone,
    CONSTRAINT recording_capture_stop_publications_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT recording_capture_stop_publications_capture_epoch_check CHECK ((capture_epoch > 0))
);

CREATE TABLE recording_completion_recoveries (
    job_id uuid NOT NULL,
    request_id uuid NOT NULL,
    database_user text DEFAULT CURRENT_USER NOT NULL,
    operator text NOT NULL,
    reason text NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    error_code text,
    error_detail text,
    failed_at timestamp with time zone NOT NULL,
    source_expires_at timestamp with time zone NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_completion_recoveries_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_completion_recoveries_fencing_generation_check CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_completion_recoveries_operator_check CHECK ((octet_length(operator) BETWEEN 1 AND 256)),
    CONSTRAINT recording_completion_recoveries_reason_check CHECK ((octet_length(reason) BETWEEN 1 AND 1024))
);

CREATE TABLE recording_data_keys (
    recording_id uuid NOT NULL,
    capture_epoch bigint NOT NULL,
    tenant_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    job_id uuid NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    key_handle uuid NOT NULL,
    environment text NOT NULL,
    envelope_digest bytea NOT NULL,
    encryption_context_digest bytea NOT NULL,
    ciphertext_blob bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_data_keys_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_data_keys_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_data_keys_ciphertext_blob_check CHECK ((octet_length(ciphertext_blob) > 0)),
    CONSTRAINT recording_data_keys_encryption_context_digest_check CHECK ((octet_length(encryption_context_digest) = 32)),
    CONSTRAINT recording_data_keys_envelope_digest_check CHECK ((octet_length(envelope_digest) = 32)),
    CONSTRAINT recording_data_keys_fencing_generation_check CHECK ((fencing_generation > 0))
);

CREATE TABLE recording_fleet_nodes (
    environment text NOT NULL,
    role text NOT NULL,
    provider_id text NOT NULL,
    node_name text NOT NULL,
    region text NOT NULL,
    release_id text NOT NULL,
    image_digest text NOT NULL,
    boot_generation bigint NOT NULL,
    inventory_digest text NOT NULL,
    worker_id uuid,
    state text NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    admission_open boolean DEFAULT false NOT NULL,
    ready_capacity integer DEFAULT 0 NOT NULL,
    observed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resources_latest jsonb,
    peak_rss_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT recording_fleet_nodes_boot_generation_check CHECK ((boot_generation > 0)),
    CONSTRAINT recording_fleet_nodes_check1 CHECK (((NOT admission_open) OR ((state = 'active'::text) AND ready AND (ready_capacity > 0)))),
    CONSTRAINT recording_fleet_nodes_check2 CHECK (((state = 'revoked'::text) = (revoked_at IS NOT NULL))),
    CONSTRAINT recording_fleet_nodes_check3 CHECK (((state <> 'revoked'::text) OR ((NOT ready) AND (NOT admission_open) AND (ready_capacity = 0)))),
    CONSTRAINT recording_fleet_nodes_environment_check CHECK ((environment ~ '^[a-z][a-z0-9-]{0,31}$'::text)),
    CONSTRAINT recording_fleet_nodes_image_digest_check CHECK ((image_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT recording_fleet_nodes_inventory_digest_check CHECK ((inventory_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT recording_fleet_nodes_node_name_check CHECK ((octet_length(node_name) BETWEEN 1 AND 255)),
    CONSTRAINT recording_fleet_nodes_peak_rss_bytes_check CHECK ((peak_rss_bytes >= 0)),
    CONSTRAINT recording_fleet_nodes_provider_id_check CHECK ((octet_length(provider_id) BETWEEN 1 AND 128)),
    CONSTRAINT recording_fleet_nodes_ready_capacity_check CHECK ((ready_capacity >= 0)),
    CONSTRAINT recording_fleet_nodes_region_check CHECK ((region ~ '^[a-z][a-z0-9-]{0,31}$'::text)),
    CONSTRAINT recording_fleet_nodes_release_id_check CHECK ((octet_length(release_id) BETWEEN 1 AND 128)),
    CONSTRAINT recording_fleet_nodes_role_check CHECK ((role = ANY (ARRAY['capture'::text, 'render'::text]))),
    CONSTRAINT recording_fleet_nodes_state_check CHECK ((state = ANY (ARRAY['requested'::text, 'active'::text, 'draining'::text, 'revoked'::text]))),
    CONSTRAINT recording_fleet_nodes_worker_state_check CHECK (((state = 'revoked'::text) OR ((state = 'requested'::text) = (worker_id IS NULL))))
);

CREATE TABLE recording_job_attempt_authorities (
    job_id uuid NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    capture_epoch bigint NOT NULL,
    claim_request_id uuid NOT NULL,
    kind text NOT NULL,
    lease_owner text NOT NULL,
    lease_token text NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    envelope_bytes bytea NOT NULL,
    envelope_digest bytea NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_job_attempt_authorities_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_job_attempt_authorities_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_job_attempt_authorities_envelope_bytes_check CHECK ((octet_length(envelope_bytes) BETWEEN 1 AND 65536)),
    CONSTRAINT recording_job_attempt_authorities_envelope_digest_check CHECK ((octet_length(envelope_digest) = 32)),
    CONSTRAINT recording_job_attempt_authorities_fencing_generation_check CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_job_attempt_authorities_kind_check CHECK ((kind = ANY (ARRAY['capture'::text, 'transcription'::text, 'render'::text]))),
    CONSTRAINT recording_job_attempt_authorities_lease_owner_check CHECK ((octet_length(lease_owner) BETWEEN 1 AND 256)),
    CONSTRAINT recording_job_attempt_authorities_lease_token_check CHECK ((octet_length(lease_token) BETWEEN 1 AND 256))
);

CREATE TABLE recording_job_attempt_failures (
    job_id uuid NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    kind text NOT NULL,
    error_code text NOT NULL,
    error_detail text NOT NULL,
    lease_owner text NOT NULL,
    failed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_job_attempt_failures_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_job_attempt_failures_error_code_check CHECK ((octet_length(error_code) <= 128)),
    CONSTRAINT recording_job_attempt_failures_error_detail_check CHECK ((octet_length(error_detail) <= 2048)),
    CONSTRAINT recording_job_attempt_failures_fencing_generation_check CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_job_attempt_failures_kind_check CHECK ((kind = ANY (ARRAY['capture'::text, 'transcription'::text, 'render'::text]))),
    CONSTRAINT recording_job_attempt_failures_lease_owner_check CHECK ((octet_length(lease_owner) BETWEEN 1 AND 256))
);

CREATE TABLE recording_job_failure_history (
    job_id uuid NOT NULL,
    manual_retry_count integer NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    error_code text,
    error_detail text,
    failed_at timestamp with time zone NOT NULL,
    retried_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_job_failure_history_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT recording_job_failure_history_fencing_generation_check CHECK ((fencing_generation >= 0)),
    CONSTRAINT recording_job_failure_history_manual_retry_count_check CHECK ((manual_retry_count BETWEEN 1 AND 5))
);

CREATE TABLE recording_jobs (
    id uuid CONSTRAINT recording_jobs_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT recording_jobs_tenant_id_not_null1 NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid CONSTRAINT recording_jobs_recording_id_not_null1 NOT NULL,
    kind text CONSTRAINT recording_jobs_kind_not_null1 NOT NULL,
    idempotency_key text CONSTRAINT recording_jobs_idempotency_key_not_null1 NOT NULL,
    payload_schema_version integer CONSTRAINT recording_jobs_payload_schema_version_not_null1 NOT NULL,
    state text CONSTRAINT recording_jobs_state_not_null1 NOT NULL,
    priority integer DEFAULT 0 CONSTRAINT recording_jobs_priority_not_null1 NOT NULL,
    available_at timestamp with time zone CONSTRAINT recording_jobs_available_at_not_null1 NOT NULL,
    attempt_count integer DEFAULT 0 CONSTRAINT recording_jobs_attempt_count_not_null1 NOT NULL,
    attempt_limit integer CONSTRAINT recording_jobs_attempt_limit_not_null1 NOT NULL,
    lease_token text,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    fencing_generation bigint DEFAULT 0 CONSTRAINT recording_jobs_fencing_generation_not_null1 NOT NULL,
    error_code text,
    error_detail text,
    terminal_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT recording_jobs_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT recording_jobs_created_at_not_null1 NOT NULL,
    result_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT recording_jobs_attempt_count_check1 CHECK ((attempt_count >= 0)),
    CONSTRAINT recording_jobs_attempt_limit_check1 CHECK ((attempt_limit BETWEEN 1 AND 20)),
    CONSTRAINT recording_jobs_check1 CHECK (((state = 'leased'::text) = ((lease_token IS NOT NULL) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT recording_jobs_error_code_check1 CHECK (((error_code IS NULL) OR (octet_length(error_code) <= 128))),
    CONSTRAINT recording_jobs_error_detail_check1 CHECK (((error_detail IS NULL) OR (octet_length(error_detail) <= 2048))),
    CONSTRAINT recording_jobs_fencing_generation_check1 CHECK ((fencing_generation >= 0)),
    CONSTRAINT recording_jobs_kind_check1 CHECK ((kind = ANY (ARRAY['capture'::text, 'transcription'::text, 'render'::text]))),
    CONSTRAINT recording_jobs_payload_schema_version_check1 CHECK ((payload_schema_version > 0)),
    CONSTRAINT recording_jobs_state_check1 CHECK ((state = ANY (ARRAY['pending'::text, 'leased'::text, 'succeeded'::text, 'retryable_failure'::text, 'terminal_failure'::text, 'cancelled'::text])))
);

CREATE TABLE recording_pipelines (
    recording_id uuid CONSTRAINT recording_pipelines_recording_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT recording_pipelines_tenant_id_not_null1 NOT NULL,
    reservation_id uuid CONSTRAINT recording_pipelines_reservation_id_not_null1 NOT NULL,
    state text CONSTRAINT recording_pipelines_state_not_null1 NOT NULL,
    capture_completed_at timestamp with time zone,
    committed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT recording_pipelines_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT recording_pipelines_created_at_not_null1 NOT NULL,
    stop_operation_id uuid,
    stop_requested_at timestamp with time zone,
    capture_epoch bigint DEFAULT 0 NOT NULL,
    capture_ready_at timestamp with time zone,
    CONSTRAINT recording_pipelines_capture_epoch_check CHECK ((capture_epoch >= 0)),
    CONSTRAINT recording_pipelines_state_check1 CHECK ((state = ANY (ARRAY['requested'::text, 'reserved'::text, 'capture_leased'::text, 'capturing_segmented'::text, 'capture_complete'::text, 'render_queued'::text, 'rendering'::text, 'verifying'::text, 'committed'::text, 'retryable_failure'::text, 'terminal_failure'::text, 'deleted'::text]))),
    CONSTRAINT recording_pipelines_stop_pair_check CHECK (((stop_operation_id IS NULL) = (stop_requested_at IS NULL)))
);

COMMENT ON COLUMN recording_pipelines.capture_ready_at IS 'Immutable recording clock origin established by the first authoritative capture-ready callback.';

CREATE TABLE recording_pool_health (
    role text CONSTRAINT recording_pool_health_role_not_null1 NOT NULL,
    admission_open boolean CONSTRAINT recording_pool_health_admission_open_not_null1 NOT NULL,
    ready_capacity integer CONSTRAINT recording_pool_health_ready_capacity_not_null1 NOT NULL,
    reason text CONSTRAINT recording_pool_health_reason_not_null1 NOT NULL,
    observed_at timestamp with time zone CONSTRAINT recording_pool_health_observed_at_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT recording_pool_health_updated_at_not_null1 NOT NULL,
    demand_revision text DEFAULT 'legacy'::text NOT NULL,
    CONSTRAINT recording_pool_health_demand_revision_check CHECK ((octet_length(demand_revision) BETWEEN 1 AND 128)),
    CONSTRAINT recording_pool_health_ready_capacity_check1 CHECK ((ready_capacity >= 0)),
    CONSTRAINT recording_pool_health_reason_check1 CHECK ((octet_length(reason) <= 256)),
    CONSTRAINT recording_pool_health_role_check1 CHECK ((role = ANY (ARRAY['capture'::text, 'render'::text])))
);

CREATE TABLE recording_preparations (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    state text NOT NULL,
    revision bigint NOT NULL,
    request_revision bigint NOT NULL,
    request_kind text NOT NULL,
    consumed_recording_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_preparations_check CHECK (((state = 'consumed'::text) = (consumed_recording_id IS NOT NULL))),
    CONSTRAINT recording_preparations_request_kind_check CHECK ((request_kind = ANY (ARRAY['prepare'::text, 'cancel'::text]))),
    CONSTRAINT recording_preparations_request_revision_check CHECK ((request_revision >= 0)),
    CONSTRAINT recording_preparations_revision_check CHECK ((revision > 0)),
    CONSTRAINT recording_preparations_state_check CHECK ((state = ANY (ARRAY['scheduled'::text, 'consumed'::text, 'canceled'::text, 'expired'::text])))
);

CREATE TABLE recording_presentation_assets (
    presentation_handle uuid NOT NULL,
    tenant_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    ordinal smallint NOT NULL,
    asset_id text NOT NULL,
    asset_kind text NOT NULL,
    object_key text NOT NULL,
    object_version text NOT NULL,
    object_etag text NOT NULL,
    content_type text NOT NULL,
    byte_size bigint NOT NULL,
    sha256 bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_presentation_assets_asset_id_check CHECK ((octet_length(asset_id) BETWEEN 1 AND 512)),
    CONSTRAINT recording_presentation_assets_asset_kind_check CHECK ((asset_kind = ANY (ARRAY['logo'::text, 'avatar'::text, 'chat_attachment'::text, 'whiteboard_state'::text, 'whiteboard_file'::text, 'font'::text]))),
    CONSTRAINT recording_presentation_assets_byte_size_check CHECK ((byte_size > 0)),
    CONSTRAINT recording_presentation_assets_content_type_check CHECK ((octet_length(content_type) BETWEEN 1 AND 255)),
    CONSTRAINT recording_presentation_assets_object_etag_check CHECK ((octet_length(object_etag) BETWEEN 1 AND 512)),
    CONSTRAINT recording_presentation_assets_object_key_check CHECK ((octet_length(object_key) BETWEEN 1 AND 1024)),
    CONSTRAINT recording_presentation_assets_object_version_check CHECK ((octet_length(object_version) <= 1024)),
    CONSTRAINT recording_presentation_assets_ordinal_check CHECK ((ordinal BETWEEN 0 AND 255)),
    CONSTRAINT recording_presentation_assets_sha256_check CHECK ((octet_length(sha256) = 32))
);

CREATE TABLE recording_presentation_baselines (
    presentation_handle uuid NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    schema_version text NOT NULL,
    profile_version text NOT NULL,
    profile jsonb NOT NULL,
    space_name text NOT NULL,
    episode_control_revision bigint CONSTRAINT recording_presentation_baseli_episode_control_revision_not_null NOT NULL,
    episode_folded_state jsonb NOT NULL,
    participant_facts jsonb NOT NULL,
    chat_head_sequence bigint NOT NULL,
    chat_retained_floor_sequence bigint,
    whiteboard_scene_id uuid,
    whiteboard_revision bigint,
    whiteboard_snapshot jsonb,
    baseline_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_presentation_baselines_chat_head_sequence_check CHECK ((chat_head_sequence >= 0)),
    CONSTRAINT recording_presentation_baselines_check CHECK (((jsonb_typeof(profile) = 'object'::text) AND ((profile ->> 'version'::text) = profile_version) AND ((octet_length((profile)::text) >= 2) AND (octet_length((profile)::text) <= 32768)))),
    CONSTRAINT recording_presentation_baselines_check1 CHECK (((whiteboard_scene_id IS NULL) = (whiteboard_revision IS NULL))),
    CONSTRAINT recording_presentation_baselines_check2 CHECK (((whiteboard_scene_id IS NULL) = (whiteboard_snapshot IS NULL))),
    CONSTRAINT recording_presentation_baselines_check3 CHECK (((chat_retained_floor_sequence IS NULL) OR ((chat_retained_floor_sequence >= 1) AND (chat_retained_floor_sequence <= (chat_head_sequence + 1))))),
    CONSTRAINT recording_presentation_baselines_episode_control_revision_check CHECK ((episode_control_revision >= 0)),
    CONSTRAINT recording_presentation_baselines_episode_folded_state_check CHECK ((jsonb_typeof(episode_folded_state) = 'object'::text)),
    CONSTRAINT recording_presentation_baselines_participant_facts_check CHECK ((jsonb_typeof(participant_facts) = 'array'::text)),
    CONSTRAINT recording_presentation_baselines_profile_version_check CHECK ((octet_length(profile_version) BETWEEN 1 AND 128)),
    CONSTRAINT recording_presentation_baselines_schema_version_check CHECK ((schema_version = 'recording_presentation.v1'::text)),
    CONSTRAINT recording_presentation_baselines_space_name_check CHECK ((octet_length(space_name) BETWEEN 1 AND 256)),
    CONSTRAINT recording_presentation_baselines_whiteboard_revision_check CHECK (((whiteboard_revision IS NULL) OR (whiteboard_revision >= 0))),
    CONSTRAINT recording_presentation_baselines_whiteboard_snapshot_check CHECK (((whiteboard_snapshot IS NULL) OR (jsonb_typeof(whiteboard_snapshot) = 'object'::text)))
);

CREATE TABLE recording_presentation_reactions (
    reaction_id uuid NOT NULL,
    presentation_handle uuid NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    participant_generation bigint CONSTRAINT recording_presentation_reaction_participant_generation_not_null NOT NULL,
    display_name text NOT NULL,
    reaction text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_presentation_reactions_check CHECK ((expires_at > occurred_at)),
    CONSTRAINT recording_presentation_reactions_display_name_check CHECK ((octet_length(display_name) BETWEEN 1 AND 256)),
    CONSTRAINT recording_presentation_reactions_participant_generation_check CHECK ((participant_generation > 0)),
    CONSTRAINT recording_presentation_reactions_reaction_check CHECK ((reaction = ANY (ARRAY['👍'::text, '❤️'::text, '😂'::text, '😮'::text, '😢'::text, '🎉'::text])))
);

CREATE TABLE recording_presentation_sources (
    presentation_handle uuid NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    capture_epoch bigint NOT NULL,
    capture_ready_at timestamp with time zone NOT NULL,
    episode_control_start_revision bigint CONSTRAINT recording_presentation_sour_episode_control_start_revi_not_null NOT NULL,
    episode_control_events jsonb NOT NULL,
    episode_control_end_revision bigint CONSTRAINT recording_presentation_sour_episode_control_end_revisi_not_null NOT NULL,
    participant_facts jsonb NOT NULL,
    chat_start_sequence bigint NOT NULL,
    chat_retained_floor_sequence bigint,
    initial_chat_messages jsonb NOT NULL,
    whiteboard_start_revision bigint CONSTRAINT recording_presentation_sourc_whiteboard_start_revision_not_null NOT NULL,
    whiteboard_events jsonb NOT NULL,
    whiteboard_end_revision bigint NOT NULL,
    capture_plan_start_revision bigint CONSTRAINT recording_presentation_sour_capture_plan_start_revisio_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_presentation_sourc_episode_control_start_revisi_check CHECK ((episode_control_start_revision >= 0)),
    CONSTRAINT recording_presentation_source_capture_plan_start_revision_check CHECK ((capture_plan_start_revision >= 0)),
    CONSTRAINT recording_presentation_sources_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_presentation_sources_chat_start_sequence_check CHECK ((chat_start_sequence >= 0)),
    CONSTRAINT recording_presentation_sources_check CHECK ((episode_control_end_revision >= episode_control_start_revision)),
    CONSTRAINT recording_presentation_sources_check1 CHECK ((whiteboard_end_revision >= whiteboard_start_revision)),
    CONSTRAINT recording_presentation_sources_check2 CHECK (((chat_retained_floor_sequence IS NULL) OR ((chat_retained_floor_sequence >= 1) AND (chat_retained_floor_sequence <= (chat_start_sequence + 1))))),
    CONSTRAINT recording_presentation_sources_episode_control_events_check CHECK ((jsonb_typeof(episode_control_events) = 'array'::text)),
    CONSTRAINT recording_presentation_sources_initial_chat_messages_check CHECK ((jsonb_typeof(initial_chat_messages) = 'array'::text)),
    CONSTRAINT recording_presentation_sources_initial_chat_messages_check1 CHECK ((jsonb_array_length(initial_chat_messages) <= 100)),
    CONSTRAINT recording_presentation_sources_participant_facts_check CHECK ((jsonb_typeof(participant_facts) = 'array'::text)),
    CONSTRAINT recording_presentation_sources_whiteboard_events_check CHECK ((jsonb_typeof(whiteboard_events) = 'array'::text)),
    CONSTRAINT recording_presentation_sources_whiteboard_start_revision_check CHECK ((whiteboard_start_revision >= 0))
);

CREATE TABLE recording_presentations (
    presentation_handle uuid NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    capture_epoch bigint NOT NULL,
    schema_version text NOT NULL,
    profile_version text NOT NULL,
    duration_millis bigint NOT NULL,
    presentation_sha256 bytea NOT NULL,
    presentation_object_key text NOT NULL,
    presentation_object_version text NOT NULL,
    presentation_object_etag text NOT NULL,
    presentation_content_type text NOT NULL,
    presentation_byte_size bigint NOT NULL,
    asset_manifest_object_key text NOT NULL,
    asset_manifest_object_version text NOT NULL,
    asset_manifest_object_etag text NOT NULL,
    asset_manifest_content_type text NOT NULL,
    asset_manifest_byte_size bigint NOT NULL,
    asset_manifest_sha256 bytea NOT NULL,
    frozen_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_presentations_asset_manifest_byte_size_check CHECK ((asset_manifest_byte_size BETWEEN 1 AND 1048576)),
    CONSTRAINT recording_presentations_asset_manifest_content_type_check CHECK ((asset_manifest_content_type = 'application/json'::text)),
    CONSTRAINT recording_presentations_asset_manifest_object_etag_check CHECK ((octet_length(asset_manifest_object_etag) BETWEEN 1 AND 512)),
    CONSTRAINT recording_presentations_asset_manifest_object_key_check CHECK ((octet_length(asset_manifest_object_key) BETWEEN 1 AND 1024)),
    CONSTRAINT recording_presentations_asset_manifest_object_version_check CHECK ((octet_length(asset_manifest_object_version) <= 1024)),
    CONSTRAINT recording_presentations_asset_manifest_sha256_check CHECK ((octet_length(asset_manifest_sha256) = 32)),
    CONSTRAINT recording_presentations_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_presentations_duration_millis_check CHECK ((duration_millis >= 0)),
    CONSTRAINT recording_presentations_presentation_byte_size_check CHECK ((presentation_byte_size BETWEEN 1 AND 67108864)),
    CONSTRAINT recording_presentations_presentation_content_type_check CHECK ((presentation_content_type = 'application/json'::text)),
    CONSTRAINT recording_presentations_presentation_object_etag_check CHECK ((octet_length(presentation_object_etag) BETWEEN 1 AND 512)),
    CONSTRAINT recording_presentations_presentation_object_key_check CHECK ((octet_length(presentation_object_key) BETWEEN 1 AND 1024)),
    CONSTRAINT recording_presentations_presentation_object_version_check CHECK ((octet_length(presentation_object_version) <= 1024)),
    CONSTRAINT recording_presentations_presentation_sha256_check CHECK ((octet_length(presentation_sha256) = 32)),
    CONSTRAINT recording_presentations_profile_version_check CHECK ((octet_length(profile_version) BETWEEN 1 AND 128)),
    CONSTRAINT recording_presentations_schema_version_check CHECK ((schema_version = 'recording_presentation.v1'::text))
);

CREATE TABLE recording_render_commits (
    render_job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    capture_epoch bigint NOT NULL,
    render_input_handle uuid NOT NULL,
    commit_digest bytea NOT NULL,
    presentation_sha256 bytea NOT NULL,
    duration_millis bigint NOT NULL,
    video_allocation_id uuid NOT NULL,
    ffprobe_facts_digest bytea NOT NULL,
    transcription_source_id uuid,
    transcription_job_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_render_commits_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_render_commits_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_render_commits_commit_digest_check CHECK ((octet_length(commit_digest) = 32)),
    CONSTRAINT recording_render_commits_duration_millis_check CHECK ((duration_millis > 0)),
    CONSTRAINT recording_render_commits_fencing_generation_check CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_render_commits_ffprobe_facts_digest_check CHECK ((octet_length(ffprobe_facts_digest) = 32)),
    CONSTRAINT recording_render_commits_presentation_sha256_check CHECK ((octet_length(presentation_sha256) = 32))
);

CREATE TABLE recording_render_inputs (
    render_input_handle uuid NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    render_job_id uuid NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    capture_epoch bigint NOT NULL,
    envelope_digest bytea NOT NULL,
    key_handle uuid NOT NULL,
    object_handle uuid NOT NULL,
    presentation_handle uuid NOT NULL,
    presentation_schema_version text NOT NULL,
    presentation_profile_version text NOT NULL,
    presentation_sha256 bytea NOT NULL,
    presentation_duration_millis bigint NOT NULL,
    capture_ready_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_render_inputs_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_render_inputs_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_render_inputs_envelope_digest_check CHECK ((octet_length(envelope_digest) = 32)),
    CONSTRAINT recording_render_inputs_fencing_generation_check CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_render_inputs_presentation_duration_millis_check CHECK ((presentation_duration_millis > 0)),
    CONSTRAINT recording_render_inputs_presentation_profile_version_check CHECK ((octet_length(presentation_profile_version) BETWEEN 1 AND 128)),
    CONSTRAINT recording_render_inputs_presentation_schema_version_check CHECK ((presentation_schema_version = 'recording_presentation.v1'::text)),
    CONSTRAINT recording_render_inputs_presentation_sha256_check CHECK ((octet_length(presentation_sha256) = 32))
);

CREATE TABLE recording_render_object_allocations (
    id uuid NOT NULL,
    reservation_request_id uuid CONSTRAINT recording_render_object_allocat_reservation_request_id_not_null NOT NULL,
    allocation_version bigint NOT NULL,
    tenant_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    render_job_id uuid NOT NULL,
    render_input_handle uuid CONSTRAINT recording_render_object_allocation_render_input_handle_not_null NOT NULL,
    object_handle uuid NOT NULL,
    attempt_count integer NOT NULL,
    fencing_generation bigint NOT NULL,
    capture_epoch bigint NOT NULL,
    envelope_digest bytea NOT NULL,
    purpose text NOT NULL,
    state text NOT NULL,
    object_key text NOT NULL,
    expected_content_type text,
    expected_byte_size bigint,
    expected_sha256 bytea,
    expected_duration_millis bigint,
    upload_token_hash bytea,
    upload_expires_at timestamp with time zone,
    object_version text,
    object_etag text,
    object_content_type text,
    object_byte_size bigint,
    object_sha256 bytea,
    committed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_render_allocations_committed_facts_check CHECK ((((state <> 'committed'::text) AND (object_version IS NULL) AND (object_etag IS NULL) AND (object_content_type IS NULL) AND (object_byte_size IS NULL) AND (object_sha256 IS NULL) AND (committed_at IS NULL)) OR ((state = 'committed'::text) AND (length(object_version) BETWEEN 0 AND 256) AND (length(object_etag) BETWEEN 1 AND 256) AND (object_content_type = expected_content_type) AND (object_byte_size = expected_byte_size) AND (object_sha256 = expected_sha256) AND (committed_at IS NOT NULL)))),
    CONSTRAINT recording_render_allocations_expected_facts_check CHECK ((((state = 'reserved'::text) AND (expected_content_type IS NULL) AND (expected_byte_size IS NULL) AND (expected_sha256 IS NULL) AND (expected_duration_millis IS NULL) AND (upload_token_hash IS NULL) AND (upload_expires_at IS NULL)) OR ((state = ANY (ARRAY['allocated'::text, 'committed'::text])) AND (expected_content_type IS NOT NULL) AND (expected_byte_size > 0) AND (octet_length(expected_sha256) = 32) AND (octet_length(upload_token_hash) = 32) AND (upload_expires_at IS NOT NULL)))),
    CONSTRAINT recording_render_allocations_purpose_facts_check CHECK ((((purpose = 'recording_video'::text) AND ((state = 'reserved'::text) OR ((expected_content_type = 'video/mp4'::text) AND (expected_byte_size <= '34359738368'::bigint) AND (expected_duration_millis BETWEEN 1 AND 14400000)))) OR ((purpose = 'transcription_manifest'::text) AND ((state = 'reserved'::text) OR ((expected_content_type = 'application/json'::text) AND (expected_byte_size <= 1048576) AND (expected_duration_millis IS NULL)))) OR ((purpose = 'transcription_audio'::text) AND ((state = 'reserved'::text) OR ((expected_content_type = 'audio/flac'::text) AND (expected_byte_size <= 524288000) AND (expected_duration_millis BETWEEN 1 AND 900000)))))),
    CONSTRAINT recording_render_object_allocations_allocation_version_check CHECK ((allocation_version > 0)),
    CONSTRAINT recording_render_object_allocations_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_render_object_allocations_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_render_object_allocations_envelope_digest_check CHECK ((octet_length(envelope_digest) = 32)),
    CONSTRAINT recording_render_object_allocations_fencing_generation_check CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_render_object_allocations_purpose_check CHECK ((purpose = ANY (ARRAY['recording_video'::text, 'transcription_manifest'::text, 'transcription_audio'::text]))),
    CONSTRAINT recording_render_object_allocations_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'allocated'::text, 'committed'::text])))
);

CREATE TABLE recording_reservations (
    id uuid CONSTRAINT recording_reservations_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT recording_reservations_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid CONSTRAINT recording_reservations_recording_id_not_null1 NOT NULL,
    idempotency_key text CONSTRAINT recording_reservations_idempotency_key_not_null1 NOT NULL,
    request_fingerprint bytea CONSTRAINT recording_reservations_request_fingerprint_not_null1 NOT NULL,
    participant_count integer CONSTRAINT recording_reservations_participant_count_not_null1 NOT NULL,
    max_duration_seconds integer CONSTRAINT recording_reservations_max_duration_seconds_not_null1 NOT NULL,
    input_bitrate_bps bigint CONSTRAINT recording_reservations_input_bitrate_bps_not_null1 NOT NULL,
    state text CONSTRAINT recording_reservations_state_not_null1 NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone CONSTRAINT recording_reservations_ends_at_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT recording_reservations_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT recording_reservations_created_at_not_null1 NOT NULL,
    policy_snapshot_version text NOT NULL,
    CONSTRAINT recording_reservations_input_bitrate_bps_check1 CHECK ((input_bitrate_bps BETWEEN 1 AND 4000000)),
    CONSTRAINT recording_reservations_max_duration_seconds_check1 CHECK ((max_duration_seconds BETWEEN 1 AND 14400)),
    CONSTRAINT recording_reservations_participant_count_check1 CHECK ((participant_count BETWEEN 1 AND 10)),
    CONSTRAINT recording_reservations_policy_snapshot_version_check CHECK ((policy_snapshot_version = 'episode_config.v2'::text)),
    CONSTRAINT recording_reservations_request_fingerprint_check1 CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT recording_reservations_state_check1 CHECK ((state = ANY (ARRAY['reserved'::text, 'released'::text, 'expired'::text])))
);

CREATE TABLE recording_transcription_preparation_commits (
    transcription_job_id uuid CONSTRAINT recording_transcription_preparati_transcription_job_id_not_null NOT NULL,
    tenant_id uuid NOT NULL,
    recording_id uuid CONSTRAINT recording_transcription_preparation_commi_recording_id_not_null NOT NULL,
    attempt_count integer CONSTRAINT recording_transcription_preparation_comm_attempt_count_not_null NOT NULL,
    fencing_generation bigint CONSTRAINT recording_transcription_preparation_fencing_generation_not_null NOT NULL,
    capture_epoch bigint CONSTRAINT recording_transcription_preparation_comm_capture_epoch_not_null NOT NULL,
    render_input_handle uuid CONSTRAINT recording_transcription_preparatio_render_input_handle_not_null NOT NULL,
    commit_digest bytea CONSTRAINT recording_transcription_preparation_comm_commit_digest_not_null NOT NULL,
    presentation_sha256 bytea CONSTRAINT recording_transcription_preparatio_presentation_sha256_not_null NOT NULL,
    duration_millis bigint CONSTRAINT recording_transcription_preparation_co_duration_millis_not_null NOT NULL,
    transcription_source_id uuid,
    committed_at timestamp with time zone DEFAULT now() CONSTRAINT recording_transcription_preparation_commi_committed_at_not_null NOT NULL,
    CONSTRAINT recording_transcription_preparation_c_presentation_sha256_check CHECK ((octet_length(presentation_sha256) = 32)),
    CONSTRAINT recording_transcription_preparation_co_fencing_generation_check CHECK ((fencing_generation > 0)),
    CONSTRAINT recording_transcription_preparation_commi_duration_millis_check CHECK ((duration_millis > 0)),
    CONSTRAINT recording_transcription_preparation_commits_attempt_count_check CHECK ((attempt_count > 0)),
    CONSTRAINT recording_transcription_preparation_commits_capture_epoch_check CHECK ((capture_epoch > 0)),
    CONSTRAINT recording_transcription_preparation_commits_commit_digest_check CHECK ((octet_length(commit_digest) = 32))
);

CREATE TABLE recording_transcription_source_chunks (
    id uuid CONSTRAINT recording_transcription_source_chunks_id_not_null1 NOT NULL,
    recording_id uuid CONSTRAINT recording_transcription_source_chunks_recording_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT recording_transcription_source_chunks_tenant_id_not_null1 NOT NULL,
    chunk_index integer CONSTRAINT recording_transcription_source_chunks_chunk_index_not_null1 NOT NULL,
    generation bigint DEFAULT 1 CONSTRAINT recording_transcription_source_chunks_generation_not_null1 NOT NULL,
    start_ms bigint CONSTRAINT recording_transcription_source_chunks_start_ms_not_null1 NOT NULL,
    end_ms bigint CONSTRAINT recording_transcription_source_chunks_end_ms_not_null1 NOT NULL,
    participant_ref text,
    track_epoch text,
    identity_kind text DEFAULT 'unknown'::text CONSTRAINT recording_transcription_source_chunks_identity_kind_not_null1 NOT NULL,
    track_class text DEFAULT 'unknown'::text CONSTRAINT recording_transcription_source_chunks_track_class_not_null1 NOT NULL,
    storage_key text CONSTRAINT recording_transcription_source_chunks_storage_key_not_null1 NOT NULL,
    checksum bytea CONSTRAINT recording_transcription_source_chunks_checksum_not_null1 NOT NULL,
    size bigint CONSTRAINT recording_transcription_source_chunks_size_not_null1 NOT NULL,
    content_type text CONSTRAINT recording_transcription_source_chunks_content_type_not_null1 NOT NULL,
    track_id text,
    participant_generation bigint,
    display_name_snapshot text,
    overlap boolean DEFAULT false NOT NULL,
    source_start_ms bigint NOT NULL,
    source_end_ms bigint NOT NULL,
    allocation_id uuid,
    object_version text,
    object_etag text,
    CONSTRAINT recording_transcription_source_chunks_checksum_check CHECK ((octet_length(checksum) = 32)),
    CONSTRAINT recording_transcription_source_chunks_display_name_authority_ch CHECK (((display_name_snapshot IS NULL) OR ((identity_kind = 'participant'::text) AND (track_class = 'microphone'::text)))),
    CONSTRAINT recording_transcription_source_chunks_display_name_check CHECK (((display_name_snapshot IS NULL) OR (length(display_name_snapshot) BETWEEN 1 AND 256))),
    CONSTRAINT recording_transcription_source_chunks_identity_fields_check CHECK ((((identity_kind = 'participant'::text) AND (participant_ref IS NOT NULL) AND (track_epoch IS NOT NULL)) OR ((identity_kind = ANY (ARRAY['shared'::text, 'unknown'::text])) AND (participant_ref IS NULL) AND (track_epoch IS NULL)))),
    CONSTRAINT recording_transcription_source_chunks_identity_kind_check CHECK ((identity_kind = ANY (ARRAY['participant'::text, 'shared'::text, 'unknown'::text]))),
    CONSTRAINT recording_transcription_source_chunks_index_check CHECK ((chunk_index >= 0)),
    CONSTRAINT recording_transcription_source_chunks_object_etag_check CHECK (((object_etag IS NULL) OR (length(object_etag) BETWEEN 1 AND 256))),
    CONSTRAINT recording_transcription_source_chunks_object_version_check CHECK (((object_version IS NULL) OR (length(object_version) BETWEEN 1 AND 256))),
    CONSTRAINT recording_transcription_source_chunks_participant_generation_ch CHECK (((participant_generation IS NULL) OR (participant_generation > 0))),
    CONSTRAINT recording_transcription_source_chunks_size_check CHECK ((size BETWEEN 1 AND 524288000)),
    CONSTRAINT recording_transcription_source_chunks_source_time_check CHECK (((source_start_ms >= 0) AND (source_end_ms > source_start_ms) AND ((source_end_ms - source_start_ms) = (end_ms - start_ms)))),
    CONSTRAINT recording_transcription_source_chunks_system_audio_identity_che CHECK ((NOT ((track_class = 'system-audio'::text) AND (identity_kind = 'participant'::text)))),
    CONSTRAINT recording_transcription_source_chunks_time_check CHECK (((start_ms >= 0) AND (end_ms > start_ms))),
    CONSTRAINT recording_transcription_source_chunks_track_class_check CHECK ((track_class = ANY (ARRAY['microphone'::text, 'screen-share'::text, 'system-audio'::text, 'unknown'::text]))),
    CONSTRAINT recording_transcription_source_chunks_track_id_check CHECK (((track_id IS NULL) OR (length(track_id) BETWEEN 1 AND 256)))
);

CREATE TABLE recording_transcription_sources (
    recording_id uuid CONSTRAINT recording_transcription_sources_recording_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT recording_transcription_sources_tenant_id_not_null1 NOT NULL,
    manifest_key text CONSTRAINT recording_transcription_sources_manifest_key_not_null1 NOT NULL,
    manifest_sha256 bytea CONSTRAINT recording_transcription_sources_manifest_sha256_not_null1 NOT NULL,
    manifest_size bigint CONSTRAINT recording_transcription_sources_manifest_size_not_null1 NOT NULL,
    manifest_content_type text CONSTRAINT recording_transcription_sources_manifest_content_type_not_null1 NOT NULL,
    schema_version integer CONSTRAINT recording_transcription_sources_schema_version_not_null1 NOT NULL,
    committed_at timestamp with time zone CONSTRAINT recording_transcription_sources_committed_at_not_null1 NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    commit_digest bytea NOT NULL,
    presentation_sha256 bytea,
    manifest_allocation_id uuid,
    manifest_object_version text,
    manifest_etag text,
    status text DEFAULT 'ready'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    lease_transcript_id uuid,
    lease_expires_at timestamp with time zone,
    cleanup_due_at timestamp with time zone,
    deleted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_transcription_sources_cleanup_check CHECK ((((status = ANY (ARRAY['ready'::text, 'leased'::text])) AND (cleanup_due_at IS NULL) AND (deleted_at IS NULL)) OR ((status = ANY (ARRAY['cleanup_pending'::text, 'deleting'::text])) AND (cleanup_due_at IS NOT NULL) AND (deleted_at IS NULL)) OR ((status = 'deleted'::text) AND (cleanup_due_at IS NOT NULL) AND (deleted_at IS NOT NULL)))),
    CONSTRAINT recording_transcription_sources_commit_digest_check CHECK ((octet_length(commit_digest) = 32)),
    CONSTRAINT recording_transcription_sources_content_type_check CHECK ((manifest_content_type = 'application/json'::text)),
    CONSTRAINT recording_transcription_sources_expiry_check CHECK (((expires_at > committed_at) AND (expires_at <= (committed_at + '30 days'::interval)))),
    CONSTRAINT recording_transcription_sources_generation_check CHECK ((generation > 0)),
    CONSTRAINT recording_transcription_sources_key_check CHECK ((length(manifest_key) BETWEEN 1 AND 1024)),
    CONSTRAINT recording_transcription_sources_lease_check CHECK ((((lease_transcript_id IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_transcript_id IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_expires_at <= (expires_at + '02:00:00'::interval))))),
    CONSTRAINT recording_transcription_sources_manifest_etag_check CHECK (((manifest_etag IS NULL) OR (length(manifest_etag) BETWEEN 1 AND 256))),
    CONSTRAINT recording_transcription_sources_manifest_object_version_check CHECK (((manifest_object_version IS NULL) OR (length(manifest_object_version) BETWEEN 1 AND 256))),
    CONSTRAINT recording_transcription_sources_presentation_sha256_check CHECK (((presentation_sha256 IS NULL) OR (octet_length(presentation_sha256) = 32))),
    CONSTRAINT recording_transcription_sources_sha256_check CHECK ((octet_length(manifest_sha256) = 32)),
    CONSTRAINT recording_transcription_sources_size_check CHECK ((manifest_size BETWEEN 1 AND 524288000)),
    CONSTRAINT recording_transcription_sources_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'leased'::text, 'cleanup_pending'::text, 'deleting'::text, 'deleted'::text]))),
    CONSTRAINT recording_transcription_sources_status_lease_check CHECK ((((status = 'ready'::text) AND (lease_transcript_id IS NULL) AND (lease_expires_at IS NULL)) OR ((status = 'leased'::text) AND (lease_transcript_id IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((status = ANY (ARRAY['cleanup_pending'::text, 'deleting'::text, 'deleted'::text])) AND (lease_transcript_id IS NULL) AND (lease_expires_at IS NULL))))
);

CREATE TABLE recordings (
    id uuid CONSTRAINT recordings_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT recordings_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    status text CONSTRAINT recordings_status_not_null1 NOT NULL,
    storage_provider text CONSTRAINT recordings_storage_provider_not_null1 NOT NULL,
    storage_key text,
    metadata jsonb,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT recordings_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT recordings_created_at_not_null1 NOT NULL,
    storage_content_type text,
    storage_size bigint,
    storage_checksum bytea,
    duration_millis bigint,
    completed_at timestamp with time zone,
    CONSTRAINT recordings_duration_millis_check CHECK (((duration_millis IS NULL) OR (duration_millis >= 0))),
    CONSTRAINT recordings_storage_checksum_check CHECK (((storage_checksum IS NULL) OR (octet_length(storage_checksum) BETWEEN 16 AND 128))),
    CONSTRAINT recordings_storage_size_check CHECK (((storage_size IS NULL) OR (storage_size >= 0)))
);

CREATE TABLE sfu_retirement_debts (
    tenant_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    node text NOT NULL,
    incarnation text DEFAULT ''::text NOT NULL,
    generation bigint NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sfu_retirement_debts_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT sfu_retirement_debts_generation_check CHECK ((generation >= 1)),
    CONSTRAINT sfu_retirement_debts_incarnation_check CHECK ((char_length(incarnation) <= 128)),
    CONSTRAINT sfu_retirement_debts_node_check CHECK ((char_length(node) BETWEEN 1 AND 64))
);

CREATE TABLE space_create_requests (
    tenant_id uuid NOT NULL,
    request_key text NOT NULL,
    request_fingerprint bytea NOT NULL,
    space_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT space_create_requests_request_fingerprint_check CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT space_create_requests_request_key_check CHECK ((request_key ~ '^[A-Za-z0-9_-]{16,128}$'::text))
);

CREATE TABLE space_members (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    identity_id uuid NOT NULL,
    role_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE space_public_admission_requests (
    request_handle uuid NOT NULL,
    arrival_handle uuid NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    display_name text NOT NULL,
    state text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    decided_at timestamp with time zone,
    decided_by uuid,
    decision_request_key text,
    CONSTRAINT space_public_admission_requests_decision_request_key_check CHECK (((decision_request_key IS NULL) OR (octet_length(decision_request_key) BETWEEN 16 AND 128))),
    CONSTRAINT space_public_admission_requests_display_name_check CHECK (((octet_length(display_name) BETWEEN 1 AND 256) AND (display_name = btrim(display_name)))),
    CONSTRAINT space_public_admission_requests_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text, 'invalidated'::text])))
);

CREATE TABLE space_public_arrivals (
    arrival_handle uuid NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    invite_handle bytea NOT NULL,
    invite_generation bigint NOT NULL,
    invite_state_epoch bigint NOT NULL,
    identity_mode text NOT NULL,
    display_name text NOT NULL,
    guest_credential_hash bytea,
    account_id uuid,
    credential_family text,
    idempotency_key text NOT NULL,
    idempotency_fingerprint bytea NOT NULL,
    state text NOT NULL,
    episode_id uuid,
    participant_id uuid,
    participant_generation bigint,
    provider text,
    provider_subject text,
    expires_at timestamp with time zone NOT NULL,
    terminal_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    terminal_at timestamp with time zone,
    CONSTRAINT space_public_arrivals_check CHECK (((invite_generation > 0) AND (invite_state_epoch > 0))),
    CONSTRAINT space_public_arrivals_check1 CHECK (((identity_mode = 'guest'::text) OR ((account_id IS NOT NULL) AND (guest_credential_hash IS NULL)))),
    CONSTRAINT space_public_arrivals_check2 CHECK (((identity_mode = 'account'::text) OR ((account_id IS NULL) AND (guest_credential_hash IS NOT NULL)))),
    CONSTRAINT space_public_arrivals_check3 CHECK (((provider IS NULL) = (provider_subject IS NULL))),
    CONSTRAINT space_public_arrivals_check4 CHECK ((((state = ANY (ARRAY['pending'::text, 'rejected'::text, 'unavailable'::text])) AND (episode_id IS NULL) AND (participant_id IS NULL) AND (participant_generation IS NULL) AND (provider IS NULL) AND (provider_subject IS NULL)) OR ((state = ANY (ARRAY['admitted'::text, 'left'::text])) AND (episode_id IS NOT NULL) AND (participant_id IS NOT NULL) AND (participant_generation IS NOT NULL) AND (provider IS NOT NULL) AND (provider_subject IS NOT NULL)))),
    CONSTRAINT space_public_arrivals_display_name_check CHECK (((octet_length(display_name) BETWEEN 1 AND 256) AND (display_name = btrim(display_name)))),
    CONSTRAINT space_public_arrivals_guest_credential_hash_check CHECK (((guest_credential_hash IS NULL) OR (octet_length(guest_credential_hash) = 32))),
    CONSTRAINT space_public_arrivals_idempotency_fingerprint_check CHECK ((octet_length(idempotency_fingerprint) = 32)),
    CONSTRAINT space_public_arrivals_identity_mode_check CHECK ((identity_mode = ANY (ARRAY['account'::text, 'guest'::text]))),
    CONSTRAINT space_public_arrivals_invite_handle_check CHECK ((octet_length(invite_handle) = 32)),
    CONSTRAINT space_public_arrivals_participant_generation_check CHECK (((participant_generation IS NULL) OR (participant_generation > 0))),
    CONSTRAINT space_public_arrivals_provider_check CHECK (((provider IS NULL) OR (octet_length(provider) BETWEEN 1 AND 128))),
    CONSTRAINT space_public_arrivals_provider_subject_check CHECK (((provider_subject IS NULL) OR (octet_length(provider_subject) BETWEEN 1 AND 256))),
    CONSTRAINT space_public_arrivals_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'admitted'::text, 'rejected'::text, 'left'::text, 'unavailable'::text])))
);

CREATE TABLE space_public_invites (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    handle bytea NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    state_epoch bigint DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    public_role text DEFAULT 'collaborator'::text NOT NULL,
    admission_mode text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone,
    disabled_at timestamp with time zone,
    last_actor_id uuid,
    last_rotation_request_key text,
    invite_code text GENERATED ALWAYS AS (space_public_invite_code(handle)) STORED NOT NULL,
    invite_words text GENERATED ALWAYS AS (space_public_invite_words(handle)) STORED NOT NULL,
    CONSTRAINT space_public_invites_admission_mode_check CHECK ((admission_mode = ANY (ARRAY['open'::text, 'knock'::text, 'members_only'::text]))),
    CONSTRAINT space_public_invites_generation_check CHECK ((generation > 0)),
    CONSTRAINT space_public_invites_handle_check CHECK ((octet_length(handle) = 32)),
    CONSTRAINT space_public_invites_last_rotation_request_key_check CHECK (((last_rotation_request_key IS NULL) OR (octet_length(last_rotation_request_key) BETWEEN 16 AND 128))),
    CONSTRAINT space_public_invites_public_role_check CHECK ((public_role = 'collaborator'::text)),
    CONSTRAINT space_public_invites_state_epoch_check CHECK ((state_epoch > 0))
);

CREATE TABLE space_roles (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    name text NOT NULL,
    capabilities text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT space_roles_check CHECK (((name <> ''::text) AND (cardinality(capabilities) > 0) AND valid_capabilities(capabilities)))
);

CREATE TABLE spaces (
    id uuid NOT NULL,
    name text NOT NULL,
    tenant_id uuid NOT NULL,
    slug text NOT NULL,
    media_plane text NOT NULL,
    metadata jsonb,
    recurring_policy jsonb,
    admission_policy jsonb DEFAULT '{"mode": "open"}'::jsonb NOT NULL,
    default_episode_duration_seconds integer DEFAULT 86400 NOT NULL,
    maximum_episode_duration_seconds integer DEFAULT 86400 NOT NULL,
    linger_window_seconds integer DEFAULT 0 NOT NULL,
    created_by_user_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    recording_policy text DEFAULT 'automatic'::text NOT NULL,
    transcription_policy text DEFAULT 'automatic'::text NOT NULL,
    transcript_language text,
    media_plane_setting_written text,
    media_plane_setting_against text,
    media_plane_setting text GENERATED ALWAYS AS (
CASE
    WHEN (media_plane_setting_written IS NULL) THEN NULL::text
    WHEN (media_plane_setting_against = btrim(media_plane)) THEN media_plane_setting_written
    WHEN (btrim(media_plane) = ANY (ARRAY['cf_sfu'::text, 'chalk_sfu'::text])) THEN btrim(media_plane)
    ELSE NULL::text
END) STORED,
    CONSTRAINT spaces_admission_policy_check CHECK (((jsonb_typeof(admission_policy) = 'object'::text) AND ((admission_policy ->> 'mode'::text) = ANY (ARRAY['open'::text, 'knock'::text, 'members_only'::text])))),
    CONSTRAINT spaces_check CHECK ((default_episode_duration_seconds <= maximum_episode_duration_seconds)),
    CONSTRAINT spaces_default_episode_duration_seconds_check CHECK ((default_episode_duration_seconds BETWEEN 60 AND 604800)),
    CONSTRAINT spaces_linger_window_seconds_check CHECK ((linger_window_seconds >= 0)),
    CONSTRAINT spaces_maximum_episode_duration_seconds_check CHECK ((maximum_episode_duration_seconds BETWEEN 60 AND 604800)),
    CONSTRAINT spaces_media_plane_setting_witness CHECK (((media_plane_setting_written IS NULL) = (media_plane_setting_against IS NULL))),
    CONSTRAINT spaces_media_plane_setting_written_check CHECK ((media_plane_setting_written = ANY (ARRAY['cf_sfu'::text, 'chalk_sfu'::text]))),
    CONSTRAINT spaces_recording_policy_check CHECK ((recording_policy = ANY (ARRAY['disabled'::text, 'manual'::text, 'automatic'::text]))),
    CONSTRAINT spaces_transcript_language_check CHECK ((transcript_language = ANY (ARRAY['auto'::text, 'af'::text, 'am'::text, 'ar'::text, 'as'::text, 'az'::text, 'ba'::text, 'be'::text, 'bg'::text, 'bn'::text, 'bo'::text, 'br'::text, 'bs'::text, 'ca'::text, 'cs'::text, 'cy'::text, 'da'::text, 'de'::text, 'el'::text, 'en'::text, 'es'::text, 'et'::text, 'eu'::text, 'fa'::text, 'fi'::text, 'fo'::text, 'fr'::text, 'gl'::text, 'gu'::text, 'ha'::text, 'haw'::text, 'he'::text, 'hi'::text, 'hr'::text, 'ht'::text, 'hu'::text, 'hy'::text, 'id'::text, 'is'::text, 'it'::text, 'ja'::text, 'jw'::text, 'ka'::text, 'kk'::text, 'km'::text, 'kn'::text, 'ko'::text, 'la'::text, 'lb'::text, 'ln'::text, 'lo'::text, 'lt'::text, 'lv'::text, 'mg'::text, 'mi'::text, 'mk'::text, 'ml'::text, 'mn'::text, 'mr'::text, 'ms'::text, 'mt'::text, 'my'::text, 'ne'::text, 'nl'::text, 'nn'::text, 'no'::text, 'oc'::text, 'pa'::text, 'pl'::text, 'ps'::text, 'pt'::text, 'ro'::text, 'ru'::text, 'sa'::text, 'sd'::text, 'si'::text, 'sk'::text, 'sl'::text, 'sn'::text, 'so'::text, 'sq'::text, 'sr'::text, 'su'::text, 'sv'::text, 'sw'::text, 'ta'::text, 'te'::text, 'tg'::text, 'th'::text, 'tk'::text, 'tl'::text, 'tr'::text, 'tt'::text, 'uk'::text, 'ur'::text, 'uz'::text, 'vi'::text, 'yi'::text, 'yo'::text, 'yue'::text, 'zh'::text]))),
    CONSTRAINT spaces_transcription_policy_check CHECK ((transcription_policy = ANY (ARRAY['disabled'::text, 'on_demand'::text, 'automatic'::text])))
);

CREATE TABLE sync_admission_requests (
    tenant_id uuid CONSTRAINT sync_admission_requests_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    admission_request_id uuid CONSTRAINT sync_admission_requests_admission_request_id_not_null1 NOT NULL,
    request_key text CONSTRAINT sync_admission_requests_request_key_not_null1 NOT NULL,
    request_fingerprint bytea CONSTRAINT sync_admission_requests_request_fingerprint_not_null1 NOT NULL,
    participant_id uuid NOT NULL,
    display_name text CONSTRAINT sync_admission_requests_display_name_not_null1 NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'pending'::text CONSTRAINT sync_admission_requests_status_not_null1 NOT NULL,
    decision_external_operation_id uuid,
    requested_at timestamp with time zone DEFAULT now() CONSTRAINT sync_admission_requests_requested_at_not_null1 NOT NULL,
    expires_at timestamp with time zone CONSTRAINT sync_admission_requests_expires_at_not_null1 NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT sync_admission_requests_check3 CHECK ((expires_at > requested_at)),
    CONSTRAINT sync_admission_requests_check4 CHECK ((((status = 'pending'::text) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['admitted'::text, 'denied'::text, 'expired'::text])) AND (decision_external_operation_id IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT sync_admission_requests_display_name_check1 CHECK (((octet_length(display_name) BETWEEN 1 AND 256) AND (display_name = btrim(display_name)))),
    CONSTRAINT sync_admission_requests_request_fingerprint_check1 CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT sync_admission_requests_request_key_check1 CHECK ((request_key ~ '^[A-Za-z0-9_-]{16,128}$'::text))
);

CREATE TABLE sync_chat_attachments (
    tenant_id uuid CONSTRAINT sync_chat_attachments_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    attachment_id uuid CONSTRAINT sync_chat_attachments_attachment_id_not_null1 NOT NULL,
    participant_id uuid NOT NULL,
    participant_generation bigint NOT NULL,
    client_attachment_id text CONSTRAINT sync_chat_attachments_client_attachment_id_not_null1 NOT NULL,
    request_fingerprint bytea CONSTRAINT sync_chat_attachments_request_fingerprint_not_null1 NOT NULL,
    upload_id uuid CONSTRAINT sync_chat_attachments_upload_id_not_null1 NOT NULL,
    object_key text CONSTRAINT sync_chat_attachments_object_key_not_null1 NOT NULL,
    original_filename text CONSTRAINT sync_chat_attachments_original_filename_not_null1 NOT NULL,
    mime_type text CONSTRAINT sync_chat_attachments_mime_type_not_null1 NOT NULL,
    byte_length bigint CONSTRAINT sync_chat_attachments_byte_length_not_null1 NOT NULL,
    sha256 bytea CONSTRAINT sync_chat_attachments_sha256_not_null1 NOT NULL,
    immutable_object_identity text,
    status text CONSTRAINT sync_chat_attachments_status_not_null1 NOT NULL,
    expires_at timestamp with time zone CONSTRAINT sync_chat_attachments_expires_at_not_null1 NOT NULL,
    message_sequence bigint,
    message_ordinal smallint,
    finalize_claim_token uuid,
    finalize_claimed_until timestamp with time zone,
    finalize_attempts integer DEFAULT 0 CONSTRAINT sync_chat_attachments_finalize_attempts_not_null1 NOT NULL,
    cleanup_claim_token uuid,
    cleanup_claimed_until timestamp with time zone,
    cleanup_attempts integer DEFAULT 0 CONSTRAINT sync_chat_attachments_cleanup_attempts_not_null1 NOT NULL,
    finalized_at timestamp with time zone,
    attached_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT sync_chat_attachments_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_chat_attachments_created_at_not_null1 NOT NULL,
    CONSTRAINT sync_chat_attachments_byte_length_check1 CHECK ((byte_length BETWEEN 1 AND 26214400)),
    CONSTRAINT sync_chat_attachments_check CHECK ((((status = 'attached'::text) AND (message_sequence IS NOT NULL) AND (message_ordinal BETWEEN 0 AND 4) AND (attached_at IS NOT NULL)) OR ((status <> 'attached'::text) AND (message_sequence IS NULL) AND (message_ordinal IS NULL) AND (attached_at IS NULL)))),
    CONSTRAINT sync_chat_attachments_check1 CHECK ((((status = ANY (ARRAY['ready'::text, 'attached'::text])) AND (immutable_object_identity IS NOT NULL) AND (finalized_at IS NOT NULL)) OR (status = ANY (ARRAY['pending'::text, 'finalizing'::text, 'failed'::text])))),
    CONSTRAINT sync_chat_attachments_check2 CHECK (((finalize_attempts >= 0) AND (((status = 'finalizing'::text) AND (finalize_claim_token IS NOT NULL) AND (finalize_claimed_until IS NOT NULL)) OR ((status <> 'finalizing'::text) AND (finalize_claim_token IS NULL) AND (finalize_claimed_until IS NULL))))),
    CONSTRAINT sync_chat_attachments_check3 CHECK (((cleanup_attempts >= 0) AND (((cleanup_claim_token IS NULL) AND (cleanup_claimed_until IS NULL)) OR ((cleanup_claim_token IS NOT NULL) AND (cleanup_claimed_until IS NOT NULL))))),
    CONSTRAINT sync_chat_attachments_client_attachment_id_check CHECK ((octet_length(client_attachment_id) BETWEEN 16 AND 64)),
    CONSTRAINT sync_chat_attachments_immutable_object_identity_check CHECK (((immutable_object_identity IS NULL) OR (octet_length(immutable_object_identity) BETWEEN 1 AND 512))),
    CONSTRAINT sync_chat_attachments_mime_type_check1 CHECK ((mime_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/gif'::text, 'image/webp'::text, 'application/pdf'::text, 'text/plain'::text, 'application/msword'::text, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'::text, 'application/vnd.ms-excel'::text, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'::text, 'application/vnd.ms-powerpoint'::text, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'::text, 'application/vnd.oasis.opendocument.text'::text, 'application/vnd.oasis.opendocument.spreadsheet'::text, 'application/vnd.oasis.opendocument.presentation'::text]))),
    CONSTRAINT sync_chat_attachments_object_key_check1 CHECK ((octet_length(object_key) BETWEEN 1 AND 1024)),
    CONSTRAINT sync_chat_attachments_original_filename_check CHECK ((octet_length(original_filename) BETWEEN 1 AND 255)),
    CONSTRAINT sync_chat_attachments_request_fingerprint_check CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT sync_chat_attachments_sha256_check1 CHECK ((octet_length(sha256) = 32)),
    CONSTRAINT sync_chat_attachments_status_check1 CHECK ((status = ANY (ARRAY['pending'::text, 'finalizing'::text, 'ready'::text, 'attached'::text, 'failed'::text])))
);

CREATE TABLE sync_chat_message_reactions (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    message_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    emoji text NOT NULL,
    CONSTRAINT sync_chat_message_reactions_emoji_check CHECK ((emoji = ANY (ARRAY['👍'::text, '❤️'::text, '😂'::text, '😮'::text, '🎉'::text, '👏'::text, '😀'::text, '😅'::text, '🙏'::text, '🔥'::text, '✅'::text, '👀'::text, '💯'::text, '🤔'::text, '😢'::text, '🙌'::text, '🚀'::text, '👌'::text, '😍'::text, '🤝'::text, '💡'::text, '⭐'::text, '😎'::text, '🥳'::text])))
);

CREATE TABLE sync_chat_messages (
    tenant_id uuid CONSTRAINT sync_chat_messages_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    sequence bigint CONSTRAINT sync_chat_messages_sequence_not_null1 NOT NULL,
    message_id uuid CONSTRAINT sync_chat_messages_message_id_not_null1 NOT NULL,
    participant_id uuid NOT NULL,
    participant_generation bigint NOT NULL,
    client_message_id text CONSTRAINT sync_chat_messages_client_message_id_not_null1 NOT NULL,
    request_fingerprint bytea CONSTRAINT sync_chat_messages_request_fingerprint_not_null1 NOT NULL,
    display_name text CONSTRAINT sync_chat_messages_display_name_not_null1 NOT NULL,
    message_text text CONSTRAINT sync_chat_messages_message_text_not_null1 NOT NULL,
    encoded_bytes bigint CONSTRAINT sync_chat_messages_encoded_bytes_not_null1 NOT NULL,
    created_at timestamp with time zone CONSTRAINT sync_chat_messages_created_at_not_null1 NOT NULL,
    reaction_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT sync_chat_messages_client_message_id_check1 CHECK ((octet_length(client_message_id) BETWEEN 16 AND 64)),
    CONSTRAINT sync_chat_messages_display_name_check1 CHECK ((octet_length(display_name) BETWEEN 1 AND 256)),
    CONSTRAINT sync_chat_messages_encoded_bytes_check1 CHECK ((encoded_bytes BETWEEN 1 AND 32768)),
    CONSTRAINT sync_chat_messages_message_text_check CHECK (((octet_length(message_text) BETWEEN 0 AND 16384) AND (char_length(message_text) <= 4000))),
    CONSTRAINT sync_chat_messages_request_fingerprint_check1 CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT sync_chat_messages_sequence_check1 CHECK ((sequence > 0))
);

CREATE TABLE sync_chat_read_receipts (
    tenant_id uuid CONSTRAINT sync_chat_read_receipts_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    participant_generation bigint NOT NULL,
    sequence bigint CONSTRAINT sync_chat_read_receipts_sequence_not_null1 NOT NULL,
    read_at timestamp with time zone CONSTRAINT sync_chat_read_receipts_read_at_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT sync_chat_read_receipts_updated_at_not_null1 NOT NULL,
    CONSTRAINT sync_chat_read_receipts_sequence_check1 CHECK ((sequence > 0))
);

CREATE TABLE sync_chat_streams (
    tenant_id uuid CONSTRAINT sync_chat_streams_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    head_sequence bigint DEFAULT 0 CONSTRAINT sync_chat_streams_head_sequence_not_null1 NOT NULL,
    retained_floor_sequence bigint,
    message_count bigint DEFAULT 0 CONSTRAINT sync_chat_streams_message_count_not_null1 NOT NULL,
    message_bytes bigint DEFAULT 0 CONSTRAINT sync_chat_streams_message_bytes_not_null1 NOT NULL,
    attachment_count bigint DEFAULT 0 CONSTRAINT sync_chat_streams_attachment_count_not_null1 NOT NULL,
    attachment_bytes bigint DEFAULT 0 CONSTRAINT sync_chat_streams_attachment_bytes_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_chat_streams_created_at_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT sync_chat_streams_updated_at_not_null1 NOT NULL,
    CONSTRAINT sync_chat_streams_check CHECK (((head_sequence >= 0) AND (message_count BETWEEN 0 AND 250000) AND ((message_bytes >= 0) AND (message_bytes <= '2147483648'::bigint)) AND (attachment_count BETWEEN 0 AND 1000) AND ((attachment_bytes >= 0) AND (attachment_bytes <= '5368709120'::bigint)) AND (((head_sequence = 0) AND (retained_floor_sequence IS NULL) AND (message_count = 0) AND (message_bytes = 0)) OR ((head_sequence > 0) AND ((retained_floor_sequence >= 1) AND (retained_floor_sequence <= (head_sequence + 1))) AND (message_count = ((head_sequence - retained_floor_sequence) + 1))))))
);

CREATE TABLE sync_command_receipts (
    tenant_id uuid CONSTRAINT sync_command_receipts_tenant_id_not_null1 NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    submitted_generation bigint CONSTRAINT sync_command_receipts_submitted_generation_not_null1 NOT NULL,
    command_id text CONSTRAINT sync_command_receipts_command_id_not_null1 NOT NULL,
    request_fingerprint bytea CONSTRAINT sync_command_receipts_request_fingerprint_not_null1 NOT NULL,
    command_name text CONSTRAINT sync_command_receipts_command_name_not_null1 NOT NULL,
    outcome text CONSTRAINT sync_command_receipts_outcome_not_null1 NOT NULL,
    rejection_reason text,
    event_id uuid,
    resulting_revision bigint,
    resulting_state_digest bytea,
    external_operation_id uuid,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_command_receipts_created_at_not_null1 NOT NULL,
    CONSTRAINT sync_command_receipts_command_id_check1 CHECK ((command_id ~ '^[A-Za-z0-9_-]{16,64}$'::text)),
    CONSTRAINT sync_command_receipts_command_name_check CHECK ((command_name = ANY (ARRAY['raise_hand'::text, 'lower_hand'::text, 'set_hand_raised'::text, 'set_display_name'::text, 'set_admission_policy'::text, 'set_participant_role'::text, 'assign_roles'::text, 'admit_participant'::text, 'deny_admission'::text, 'mute_participant'::text, 'stop_participant_camera'::text, 'stop_participant_screen_share'::text, 'remove_participant'::text, 'start_recording'::text, 'stop_recording'::text, 'participant_leave'::text, 'start_episode'::text, 'extend_episode'::text, 'end_episode'::text]))),
    CONSTRAINT sync_command_receipts_request_fingerprint_check1 CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT sync_command_receipts_shape_check CHECK ((((command_name = ANY (ARRAY['raise_hand'::text, 'lower_hand'::text])) AND (resulting_state_digest IS NULL) AND (external_operation_id IS NULL) AND (completed_at IS NULL) AND (((outcome = 'committed'::text) AND (rejection_reason IS NULL) AND (event_id IS NOT NULL) AND (resulting_revision > 0)) OR ((outcome = 'rejected'::text) AND (rejection_reason = ANY (ARRAY['episode_ended'::text, 'participant_inactive'::text, 'stale_participant_generation'::text, 'capability_denied'::text, 'invalid_state'::text, 'command_id_conflict'::text])) AND (event_id IS NULL) AND (resulting_revision IS NULL)))) OR ((command_name = ANY (ARRAY['set_hand_raised'::text, 'set_display_name'::text, 'set_admission_policy'::text, 'set_participant_role'::text, 'assign_roles'::text, 'admit_participant'::text, 'deny_admission'::text, 'mute_participant'::text, 'stop_participant_camera'::text, 'stop_participant_screen_share'::text, 'remove_participant'::text, 'start_recording'::text, 'stop_recording'::text, 'participant_leave'::text, 'start_episode'::text, 'extend_episode'::text, 'end_episode'::text])) AND (((outcome = 'committed'::text) AND (command_name <> 'start_episode'::text) AND ((command_name <> 'extend_episode'::text) OR (external_operation_id IS NULL)) AND (rejection_reason IS NULL) AND (event_id IS NOT NULL) AND (resulting_revision > 0) AND (octet_length(resulting_state_digest) = 32) AND (completed_at IS NOT NULL)) OR ((outcome = 'satisfied'::text) AND (command_name <> 'extend_episode'::text) AND (rejection_reason IS NULL) AND (event_id IS NULL) AND (resulting_revision >= 0) AND (octet_length(resulting_state_digest) = 32) AND (external_operation_id IS NULL) AND (completed_at IS NOT NULL)) OR ((outcome = 'pending'::text) AND (command_name <> ALL (ARRAY['start_episode'::text, 'extend_episode'::text])) AND (rejection_reason IS NULL) AND (external_operation_id IS NOT NULL) AND (completed_at IS NULL) AND (((command_name = ANY (ARRAY['set_participant_role'::text, 'assign_roles'::text])) AND (event_id IS NOT NULL) AND (resulting_revision > 0) AND (octet_length(resulting_state_digest) = 32)) OR ((command_name <> ALL (ARRAY['set_participant_role'::text, 'assign_roles'::text])) AND (event_id IS NULL) AND (resulting_revision IS NULL) AND (resulting_state_digest IS NULL)))) OR ((outcome = 'rejected'::text) AND (command_name <> 'start_episode'::text) AND ((command_name <> 'extend_episode'::text) OR (external_operation_id IS NULL)) AND (rejection_reason = ANY (ARRAY['episode_ended'::text, 'participant_inactive'::text, 'stale_participant_generation'::text, 'capability_denied'::text, 'invalid_state'::text, 'invalid_target'::text, 'role_not_eligible'::text, 'role_assignment_required'::text, 'screen_share_in_use'::text, 'recording_in_progress'::text, 'recording_policy_disabled'::text, 'external_operation_failed'::text])) AND ((rejection_reason <> 'recording_policy_disabled'::text) OR (command_name = 'start_recording'::text)) AND (completed_at IS NOT NULL) AND (((command_name = ANY (ARRAY['set_participant_role'::text, 'assign_roles'::text])) AND (external_operation_id IS NOT NULL) AND (event_id IS NOT NULL) AND (resulting_revision > 0) AND (octet_length(resulting_state_digest) = 32)) OR ((command_name <> ALL (ARRAY['set_participant_role'::text, 'assign_roles'::text])) AND (event_id IS NULL) AND (resulting_revision IS NULL) AND (resulting_state_digest IS NULL)))))))),
    CONSTRAINT sync_command_receipts_submitted_generation_check1 CHECK ((submitted_generation > 0))
);

CREATE TABLE sync_control_events (
    tenant_id uuid CONSTRAINT sync_control_events_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    event_id uuid CONSTRAINT sync_control_events_event_id_not_null1 NOT NULL,
    base_revision bigint CONSTRAINT sync_control_events_base_revision_not_null1 NOT NULL,
    revision bigint CONSTRAINT sync_control_events_revision_not_null1 NOT NULL,
    event_name text CONSTRAINT sync_control_events_event_name_not_null1 NOT NULL,
    payload jsonb CONSTRAINT sync_control_events_payload_not_null1 NOT NULL,
    actor_participant_id uuid,
    actor_generation bigint,
    command_id text,
    lifecycle_intent_id uuid,
    external_operation_id uuid,
    event_schema_version integer CONSTRAINT sync_control_events_event_schema_version_not_null1 NOT NULL,
    resulting_state_digest bytea CONSTRAINT sync_control_events_resulting_state_digest_not_null1 NOT NULL,
    encoded_bytes integer CONSTRAINT sync_control_events_encoded_bytes_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_control_events_created_at_not_null1 NOT NULL,
    CONSTRAINT sync_control_events_check CHECK (((base_revision >= 0) AND (revision = (base_revision + 1)))),
    CONSTRAINT sync_control_events_check1 CHECK (((num_nonnulls(command_id, lifecycle_intent_id, external_operation_id) = 1) AND (((command_id IS NOT NULL) AND (command_id ~ '^[A-Za-z0-9_-]{16,64}$'::text) AND (actor_participant_id IS NOT NULL) AND (actor_generation > 0)) OR ((lifecycle_intent_id IS NOT NULL) AND (actor_participant_id IS NULL) AND (actor_generation IS NULL)) OR ((external_operation_id IS NOT NULL) AND ((actor_participant_id IS NULL) = (actor_generation IS NULL)) AND ((actor_generation IS NULL) OR (actor_generation > 0)))))),
    CONSTRAINT sync_control_events_encoded_bytes_check1 CHECK ((encoded_bytes BETWEEN 1 AND 32768)),
    CONSTRAINT sync_control_events_event_schema_version_check CHECK ((event_schema_version > 0)),
    CONSTRAINT sync_control_events_resulting_state_digest_check CHECK ((octet_length(resulting_state_digest) = 32))
);

CREATE TABLE sync_entry_rollout (
    singleton boolean DEFAULT true NOT NULL,
    enforced boolean DEFAULT false NOT NULL,
    enforced_at timestamp with time zone,
    release_id text,
    CONSTRAINT sync_entry_rollout_check CHECK ((enforced = ((enforced_at IS NOT NULL) AND (release_id IS NOT NULL)))),
    CONSTRAINT sync_entry_rollout_singleton_check CHECK (singleton)
);

CREATE TABLE sync_episode_control (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    control_revision bigint DEFAULT 0 NOT NULL,
    folded_state jsonb NOT NULL,
    state_schema_version integer NOT NULL,
    state_digest bytea NOT NULL,
    snapshot_bytes bigint NOT NULL,
    snapshot_reserved_bytes bigint DEFAULT 0 NOT NULL,
    participant_event_count bigint DEFAULT 0 NOT NULL,
    participant_event_bytes bigint DEFAULT 0 NOT NULL,
    lifecycle_event_count bigint DEFAULT 0 NOT NULL,
    lifecycle_event_bytes bigint DEFAULT 0 NOT NULL,
    lifecycle_reserved_events bigint DEFAULT 1 NOT NULL,
    lifecycle_reserved_bytes bigint DEFAULT 16384 NOT NULL,
    lifecycle_intent_count bigint DEFAULT 0 NOT NULL,
    lifecycle_intent_bytes bigint DEFAULT 0 NOT NULL,
    lifecycle_reserved_intents bigint DEFAULT 1 NOT NULL,
    lifecycle_reserved_intent_bytes bigint DEFAULT 16384 NOT NULL,
    receipt_count bigint DEFAULT 0 NOT NULL,
    receipt_bytes bigint DEFAULT 0 NOT NULL,
    retention_checkpoint_revision bigint,
    retention_checkpoint_state_digest bytea,
    retention_checkpoint_event_count bigint,
    retention_cleaned_at timestamp with time zone,
    retention_deleted_event_rows bigint DEFAULT 0 NOT NULL,
    retention_deleted_event_bytes bigint DEFAULT 0 NOT NULL,
    retention_deleted_receipt_rows bigint DEFAULT 0 NOT NULL,
    retention_deleted_receipt_bytes bigint DEFAULT 0 NOT NULL,
    retention_deleted_lifecycle_intent_rows bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_lifecycle_inten_not_null NOT NULL,
    retention_deleted_lifecycle_intent_bytes bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_lifecycle_inte_not_null1 NOT NULL,
    retention_deleted_external_operation_rows bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_external_operat_not_null NOT NULL,
    retention_deleted_external_operation_bytes bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_external_opera_not_null1 NOT NULL,
    retention_deleted_admission_request_rows bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_admission_reque_not_null NOT NULL,
    retention_deleted_admission_request_bytes bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_admission_requ_not_null1 NOT NULL,
    retention_deleted_recording_rows bigint DEFAULT 0 NOT NULL,
    retention_deleted_recording_bytes bigint DEFAULT 0 NOT NULL,
    retention_deleted_screen_share_lease_rows bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_screen_share_le_not_null NOT NULL,
    retention_deleted_screen_share_lease_bytes bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_screen_share_l_not_null1 NOT NULL,
    retention_deleted_publication_fence_rows bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_publication_fen_not_null NOT NULL,
    retention_deleted_publication_fence_bytes bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_publication_fe_not_null1 NOT NULL,
    retention_deleted_publication_grant_reservation_rows bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_publication_gra_not_null NOT NULL,
    retention_deleted_publication_grant_reservation_bytes bigint DEFAULT 0 CONSTRAINT sync_episode_control_retention_deleted_publication_gr_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_episode_control_check CHECK (((control_revision >= 0) AND (snapshot_bytes >= 0) AND (snapshot_reserved_bytes >= 0) AND (participant_event_count BETWEEN 0 AND 250000) AND ((participant_event_bytes >= 0) AND (participant_event_bytes <= '2147483648'::bigint)) AND (lifecycle_event_count >= 0) AND (lifecycle_event_bytes >= 0) AND (lifecycle_reserved_events >= 0) AND (lifecycle_reserved_bytes >= 0) AND (lifecycle_intent_count >= 0) AND (lifecycle_intent_bytes >= 0) AND (lifecycle_reserved_intents >= 0) AND (lifecycle_reserved_intent_bytes >= 0) AND (receipt_count BETWEEN 0 AND 500000) AND ((receipt_bytes >= 0) AND (receipt_bytes <= '4294967296'::bigint)) AND ((snapshot_bytes + snapshot_reserved_bytes) <= 1048576) AND ((lifecycle_event_count + lifecycle_reserved_events) <= 2048) AND ((lifecycle_event_bytes + lifecycle_reserved_bytes) <= 33554432) AND ((lifecycle_intent_count + lifecycle_reserved_intents) <= 2048) AND ((lifecycle_intent_bytes + lifecycle_reserved_intent_bytes) <= 33554432))),
    CONSTRAINT sync_episode_control_check1 CHECK ((((retention_cleaned_at IS NULL) AND (retention_checkpoint_revision IS NULL) AND (retention_checkpoint_state_digest IS NULL) AND (retention_checkpoint_event_count IS NULL) AND (retention_deleted_event_rows = 0) AND (retention_deleted_event_bytes = 0) AND (retention_deleted_receipt_rows = 0) AND (retention_deleted_receipt_bytes = 0) AND (retention_deleted_lifecycle_intent_rows = 0) AND (retention_deleted_lifecycle_intent_bytes = 0) AND (retention_deleted_external_operation_rows = 0) AND (retention_deleted_external_operation_bytes = 0) AND (retention_deleted_admission_request_rows = 0) AND (retention_deleted_admission_request_bytes = 0) AND (retention_deleted_recording_rows = 0) AND (retention_deleted_recording_bytes = 0) AND (retention_deleted_screen_share_lease_rows = 0) AND (retention_deleted_screen_share_lease_bytes = 0) AND (retention_deleted_publication_fence_rows = 0) AND (retention_deleted_publication_fence_bytes = 0) AND (retention_deleted_publication_grant_reservation_rows = 0) AND (retention_deleted_publication_grant_reservation_bytes = 0)) OR ((retention_cleaned_at IS NOT NULL) AND (retention_checkpoint_revision IS NOT NULL) AND (retention_checkpoint_revision >= 0) AND (retention_checkpoint_state_digest IS NOT NULL) AND (octet_length(retention_checkpoint_state_digest) = 32) AND (retention_checkpoint_event_count IS NOT NULL) AND (retention_checkpoint_event_count = retention_checkpoint_revision) AND (retention_deleted_event_rows = retention_checkpoint_event_count) AND (retention_deleted_event_bytes >= 0) AND (retention_deleted_receipt_rows >= 0) AND (retention_deleted_receipt_bytes >= 0) AND (retention_deleted_lifecycle_intent_rows >= 0) AND (retention_deleted_lifecycle_intent_bytes >= 0) AND (retention_deleted_external_operation_rows >= 0) AND (retention_deleted_external_operation_bytes >= 0) AND (retention_deleted_admission_request_rows >= 0) AND (retention_deleted_admission_request_bytes >= 0) AND (retention_deleted_recording_rows >= 0) AND (retention_deleted_recording_bytes >= 0) AND (retention_deleted_screen_share_lease_rows >= 0) AND (retention_deleted_screen_share_lease_bytes >= 0) AND (retention_deleted_publication_fence_rows >= 0) AND (retention_deleted_publication_fence_bytes >= 0) AND (retention_deleted_publication_grant_reservation_rows >= 0) AND (retention_deleted_publication_grant_reservation_bytes >= 0)))),
    CONSTRAINT sync_episode_control_state_digest_check CHECK ((octet_length(state_digest) = 32)),
    CONSTRAINT sync_episode_control_state_schema_version_check CHECK ((state_schema_version > 0))
);

CREATE TABLE sync_external_operations (
    tenant_id uuid CONSTRAINT sync_external_operations_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    external_operation_id uuid CONSTRAINT sync_external_operations_external_operation_id_not_null1 NOT NULL,
    parent_external_operation_id uuid,
    request_key text CONSTRAINT sync_external_operations_request_key_not_null1 NOT NULL,
    request_fingerprint bytea CONSTRAINT sync_external_operations_request_fingerprint_not_null1 NOT NULL,
    operation_name text CONSTRAINT sync_external_operations_operation_name_not_null1 NOT NULL,
    actor_participant_id uuid,
    actor_generation bigint,
    target_participant_id uuid,
    target_participant_generation bigint,
    source text,
    recording_id uuid,
    deadline_generation bigint,
    journey_id uuid,
    parent_journey_event_id uuid,
    producing_trace_id text,
    producing_span_id text,
    payload jsonb CONSTRAINT sync_external_operations_payload_not_null1 NOT NULL,
    status text DEFAULT 'pending'::text CONSTRAINT sync_external_operations_status_not_null1 NOT NULL,
    fence_active boolean DEFAULT false CONSTRAINT sync_external_operations_fence_active_not_null1 NOT NULL,
    attempt_count integer DEFAULT 0 CONSTRAINT sync_external_operations_attempt_count_not_null1 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() CONSTRAINT sync_external_operations_next_attempt_at_not_null1 NOT NULL,
    last_error_code text,
    applied_event_id uuid,
    applied_revision bigint,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_external_operations_created_at_not_null1 NOT NULL,
    completed_at timestamp with time zone,
    producing_traceparent text,
    producing_tracestate text,
    control_revision bigint,
    CONSTRAINT sync_external_operations_actor_generation_check1 CHECK (((actor_generation IS NULL) OR (actor_generation > 0))),
    CONSTRAINT sync_external_operations_attempt_count_check1 CHECK ((attempt_count BETWEEN 0 AND 100)),
    CONSTRAINT sync_external_operations_check10 CHECK (((journey_id IS NULL) = (parent_journey_event_id IS NULL))),
    CONSTRAINT sync_external_operations_check11 CHECK (((producing_trace_id IS NULL) = (producing_span_id IS NULL))),
    CONSTRAINT sync_external_operations_check12 CHECK ((((operation_name = 'role_transition_cleanup'::text) AND (parent_external_operation_id IS NULL) AND (source IS NULL)) OR ((operation_name = 'role_transition_source_stop'::text) AND (parent_external_operation_id IS NOT NULL) AND (source IS NOT NULL)) OR ((operation_name <> ALL (ARRAY['role_transition_cleanup'::text, 'role_transition_source_stop'::text])) AND (parent_external_operation_id IS NULL)))),
    CONSTRAINT sync_external_operations_check13 CHECK ((((status = 'pending'::text) AND (completed_at IS NULL) AND (applied_event_id IS NULL) AND (applied_revision IS NULL)) OR ((status = 'applied'::text) AND (completed_at IS NOT NULL) AND (last_error_code IS NULL) AND (((applied_event_id IS NULL) AND (applied_revision IS NULL)) OR ((applied_event_id IS NOT NULL) AND (applied_revision > 0))) AND (fence_active = false)) OR ((status = 'failed'::text) AND (completed_at IS NOT NULL) AND (last_error_code IS NOT NULL) AND (applied_event_id IS NULL) AND (applied_revision IS NULL)))),
    CONSTRAINT sync_external_operations_check7 CHECK (((actor_participant_id IS NULL) = (actor_generation IS NULL))),
    CONSTRAINT sync_external_operations_check8 CHECK (((target_participant_id IS NULL) = (target_participant_generation IS NULL))),
    CONSTRAINT sync_external_operations_check9 CHECK (((operation_name = ANY (ARRAY['tenant_set_deadline'::text, 'maximum_episode_duration_expired'::text])) = (deadline_generation IS NOT NULL))),
    CONSTRAINT sync_external_operations_control_revision_check CHECK ((control_revision > 0)),
    CONSTRAINT sync_external_operations_deadline_generation_check1 CHECK (((deadline_generation IS NULL) OR (deadline_generation > 0))),
    CONSTRAINT sync_external_operations_operation_name_check CHECK ((operation_name = ANY (ARRAY['admit_participant'::text, 'deny_admission'::text, 'admission_request_expired'::text, 'mute_participant'::text, 'stop_participant_camera'::text, 'stop_participant_screen_share'::text, 'remove_participant'::text, 'start_recording'::text, 'stop_recording'::text, 'recording_capture_ready'::text, 'recording_capture_stopped'::text, 'recording_capture_failed'::text, 'participant_leave'::text, 'end_episode'::text, 'tenant_assign_roles'::text, 'tenant_set_deadline'::text, 'tenant_end_episode'::text, 'maximum_episode_duration_expired'::text, 'role_transition_cleanup'::text, 'role_transition_source_stop'::text]))),
    CONSTRAINT sync_external_operations_payload_check1 CHECK ((octet_length((payload)::text) <= 16384)),
    CONSTRAINT sync_external_operations_producing_span_id_check1 CHECK (((producing_span_id IS NULL) OR (producing_span_id ~ '^[0-9a-f]{16}$'::text))),
    CONSTRAINT sync_external_operations_producing_trace_id_check1 CHECK (((producing_trace_id IS NULL) OR (producing_trace_id ~ '^[0-9a-f]{32}$'::text))),
    CONSTRAINT sync_external_operations_producing_traceparent_check CHECK (((producing_traceparent IS NULL) OR (producing_traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'::text))),
    CONSTRAINT sync_external_operations_producing_tracestate_check CHECK (((producing_tracestate IS NULL) OR (octet_length(producing_tracestate) BETWEEN 1 AND 512))),
    CONSTRAINT sync_external_operations_producing_w3c_tracestate_check CHECK (((producing_traceparent IS NOT NULL) OR (producing_tracestate IS NULL))),
    CONSTRAINT sync_external_operations_request_fingerprint_check1 CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT sync_external_operations_request_key_check1 CHECK ((request_key ~ '^[A-Za-z0-9_-]{16,128}$'::text)),
    CONSTRAINT sync_external_operations_source_check1 CHECK (((source IS NULL) OR (source = ANY (ARRAY['microphone'::text, 'camera'::text, 'screen'::text])))),
    CONSTRAINT sync_external_operations_target_participant_generation_check1 CHECK (((target_participant_generation IS NULL) OR (target_participant_generation > 0)))
);

CREATE TABLE sync_lifecycle_intents (
    tenant_id uuid CONSTRAINT sync_lifecycle_intents_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    lifecycle_intent_id uuid CONSTRAINT sync_lifecycle_intents_lifecycle_intent_id_not_null1 NOT NULL,
    request_key text CONSTRAINT sync_lifecycle_intents_request_key_not_null1 NOT NULL,
    request_fingerprint bytea CONSTRAINT sync_lifecycle_intents_request_fingerprint_not_null1 NOT NULL,
    intent_name text CONSTRAINT sync_lifecycle_intents_intent_name_not_null1 NOT NULL,
    participant_id uuid,
    participant_generation bigint,
    payload jsonb CONSTRAINT sync_lifecycle_intents_payload_not_null1 NOT NULL,
    status text CONSTRAINT sync_lifecycle_intents_status_not_null1 NOT NULL,
    terminal_reason text,
    applied_event_id uuid,
    applied_revision bigint,
    attempt_count integer DEFAULT 0 CONSTRAINT sync_lifecycle_intents_attempt_count_not_null1 NOT NULL,
    last_error_code text,
    next_attempt_at timestamp with time zone DEFAULT now() CONSTRAINT sync_lifecycle_intents_next_attempt_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_lifecycle_intents_created_at_not_null1 NOT NULL,
    completed_at timestamp with time zone,
    journey_id uuid,
    parent_journey_event_id uuid,
    producing_trace_id text,
    producing_span_id text,
    CONSTRAINT sync_lifecycle_intents_attempt_count_check1 CHECK ((attempt_count >= 0)),
    CONSTRAINT sync_lifecycle_intents_check CHECK ((((intent_name = ANY (ARRAY['participant_joined'::text, 'participant_left'::text])) AND (participant_id IS NOT NULL) AND (participant_generation > 0)) OR ((intent_name = ANY (ARRAY['episode_ended'::text, 'admission_requested'::text])) AND (participant_id IS NULL) AND (participant_generation IS NULL)))),
    CONSTRAINT sync_lifecycle_intents_check1 CHECK ((((status = 'pending'::text) AND (terminal_reason IS NULL) AND (applied_event_id IS NULL) AND (applied_revision IS NULL) AND (completed_at IS NULL)) OR ((status = 'applied'::text) AND (terminal_reason IS NULL) AND (applied_event_id IS NOT NULL) AND (applied_revision > 0) AND (completed_at IS NOT NULL)) OR ((status = 'superseded'::text) AND (terminal_reason = ANY (ARRAY['superseded_by_episode_end'::text, 'participant_already_terminal'::text, 'participant_generation_replaced'::text])) AND (applied_event_id IS NULL) AND (applied_revision IS NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT sync_lifecycle_intents_payload_check CHECK ((octet_length((payload)::text) <= 16384)),
    CONSTRAINT sync_lifecycle_intents_request_fingerprint_check1 CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT sync_lifecycle_intents_request_key_check1 CHECK ((request_key ~ '^[A-Za-z0-9_-]{16,128}$'::text)),
    CONSTRAINT sync_lifecycle_intents_span_id_check CHECK (((producing_span_id IS NULL) OR (producing_span_id ~ '^[0-9a-f]{16}$'::text))),
    CONSTRAINT sync_lifecycle_intents_trace_id_check CHECK (((producing_trace_id IS NULL) OR (producing_trace_id ~ '^[0-9a-f]{32}$'::text)))
);

CREATE TABLE sync_media_pauses (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    participant_generation bigint NOT NULL,
    source text NOT NULL,
    publication_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_media_pauses_participant_generation_check CHECK ((participant_generation > 0)),
    CONSTRAINT sync_media_pauses_publication_id_check CHECK ((octet_length(publication_id) BETWEEN 1 AND 256)),
    CONSTRAINT sync_media_pauses_source_check CHECK ((source = ANY (ARRAY['microphone'::text, 'camera'::text, 'screen'::text])))
);

CREATE TABLE sync_media_stops (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    participant_generation bigint NOT NULL,
    source text NOT NULL,
    revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_media_stops_participant_generation_check CHECK ((participant_generation > 0)),
    CONSTRAINT sync_media_stops_revision_check CHECK ((revision > 0)),
    CONSTRAINT sync_media_stops_source_check CHECK ((source = ANY (ARRAY['microphone'::text, 'camera'::text, 'screen'::text])))
);

CREATE TABLE sync_presence_runtime (
    singleton boolean DEFAULT true NOT NULL,
    recover_after timestamp with time zone NOT NULL,
    CONSTRAINT sync_presence_runtime_singleton_check CHECK (singleton)
);

CREATE TABLE sync_publication_fences (
    tenant_id uuid CONSTRAINT sync_publication_fences_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    participant_generation bigint CONSTRAINT sync_publication_fences_participant_generation_not_null1 NOT NULL,
    source text CONSTRAINT sync_publication_fences_source_not_null1 NOT NULL,
    external_operation_id uuid CONSTRAINT sync_publication_fences_external_operation_id_not_null1 NOT NULL,
    expires_at timestamp with time zone CONSTRAINT sync_publication_fences_expires_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_publication_fences_created_at_not_null1 NOT NULL,
    CONSTRAINT sync_publication_fences_check1 CHECK ((expires_at > created_at)),
    CONSTRAINT sync_publication_fences_participant_generation_check1 CHECK ((participant_generation > 0)),
    CONSTRAINT sync_publication_fences_source_check1 CHECK ((source = ANY (ARRAY['microphone'::text, 'camera'::text, 'screen'::text])))
);

CREATE TABLE sync_publication_grant_reservations (
    tenant_id uuid CONSTRAINT sync_publication_grant_reservations_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    reservation_id uuid CONSTRAINT sync_publication_grant_reservations_reservation_id_not_null1 NOT NULL,
    operation_id text CONSTRAINT sync_publication_grant_reservations_operation_id_not_null1 NOT NULL,
    participant_id uuid NOT NULL,
    participant_generation bigint CONSTRAINT sync_publication_grant_reserva_participant_generation_not_null1 NOT NULL,
    source text CONSTRAINT sync_publication_grant_reservations_source_not_null1 NOT NULL,
    status text DEFAULT 'pending'::text CONSTRAINT sync_publication_grant_reservations_status_not_null1 NOT NULL,
    failure_code text,
    expires_at timestamp with time zone CONSTRAINT sync_publication_grant_reservations_expires_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_publication_grant_reservations_created_at_not_null1 NOT NULL,
    completed_at timestamp with time zone,
    control_revision bigint,
    CONSTRAINT sync_publication_grant_reservatio_participant_generation_check1 CHECK ((participant_generation > 0)),
    CONSTRAINT sync_publication_grant_reservations_check2 CHECK ((expires_at > created_at)),
    CONSTRAINT sync_publication_grant_reservations_check3 CHECK ((((status = ANY (ARRAY['pending'::text, 'ambiguous'::text])) AND (completed_at IS NULL)) OR ((status = 'confirmed'::text) AND (failure_code IS NULL) AND (completed_at IS NOT NULL)) OR ((status = 'failed'::text) AND (failure_code IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT sync_publication_grant_reservations_control_revision_check CHECK ((control_revision > 0)),
    CONSTRAINT sync_publication_grant_reservations_operation_id_check1 CHECK ((operation_id ~ '^[A-Za-z0-9_-]{16,128}$'::text)),
    CONSTRAINT sync_publication_grant_reservations_source_check1 CHECK ((source = ANY (ARRAY['microphone'::text, 'camera'::text, 'screen'::text]))),
    CONSTRAINT sync_publication_grant_reservations_status_check1 CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'failed'::text, 'ambiguous'::text])))
);

CREATE TABLE sync_recordings (
    tenant_id uuid CONSTRAINT sync_recordings_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    recording_id uuid CONSTRAINT sync_recordings_recording_id_not_null1 NOT NULL,
    status text CONSTRAINT sync_recordings_status_not_null1 NOT NULL,
    generation bigint CONSTRAINT sync_recordings_generation_not_null1 NOT NULL,
    adapter_metadata jsonb DEFAULT '{}'::jsonb CONSTRAINT sync_recordings_adapter_metadata_not_null1 NOT NULL,
    started_by_participant_id uuid,
    started_by_generation bigint,
    start_external_operation_id uuid CONSTRAINT sync_recordings_start_external_operation_id_not_null1 NOT NULL,
    stop_external_operation_id uuid,
    failure_code text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_recordings_created_at_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT sync_recordings_updated_at_not_null1 NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT sync_recordings_check2 CHECK (((started_by_participant_id IS NULL) = (started_by_generation IS NULL))),
    CONSTRAINT sync_recordings_check3 CHECK ((((status = ANY (ARRAY['starting'::text, 'recording'::text, 'stopping'::text])) AND (completed_at IS NULL) AND (failure_code IS NULL)) OR ((status = 'stopped'::text) AND (completed_at IS NOT NULL) AND (failure_code IS NULL)) OR ((status = 'failed'::text) AND (completed_at IS NOT NULL) AND (failure_code IS NOT NULL)))),
    CONSTRAINT sync_recordings_generation_check1 CHECK ((generation > 0)),
    CONSTRAINT sync_recordings_started_by_generation_check1 CHECK (((started_by_generation IS NULL) OR (started_by_generation > 0))),
    CONSTRAINT sync_recordings_status_check1 CHECK ((status = ANY (ARRAY['starting'::text, 'recording'::text, 'stopping'::text, 'stopped'::text, 'failed'::text])))
);

CREATE TABLE sync_screen_share_leases (
    tenant_id uuid CONSTRAINT sync_screen_share_leases_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    lease_id uuid CONSTRAINT sync_screen_share_leases_lease_id_not_null1 NOT NULL,
    owner_participant_id uuid NOT NULL,
    owner_generation bigint CONSTRAINT sync_screen_share_leases_owner_generation_not_null1 NOT NULL,
    lease_generation bigint CONSTRAINT sync_screen_share_leases_lease_generation_not_null1 NOT NULL,
    status text CONSTRAINT sync_screen_share_leases_status_not_null1 NOT NULL,
    acquired_at timestamp with time zone CONSTRAINT sync_screen_share_leases_acquired_at_not_null1 NOT NULL,
    renewed_until timestamp with time zone CONSTRAINT sync_screen_share_leases_renewed_until_not_null1 NOT NULL,
    hard_expires_at timestamp with time zone CONSTRAINT sync_screen_share_leases_hard_expires_at_not_null1 NOT NULL,
    CONSTRAINT sync_screen_share_leases_check2 CHECK (((owner_generation > 0) AND (lease_generation > 0))),
    CONSTRAINT sync_screen_share_leases_check3 CHECK (((acquired_at < renewed_until) AND (renewed_until <= hard_expires_at))),
    CONSTRAINT sync_screen_share_leases_status_check1 CHECK ((status = ANY (ARRAY['acquiring'::text, 'active'::text])))
);

CREATE SEQUENCE sync_source_control_revisions
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE sync_whiteboard_draw_policies (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    policy text NOT NULL,
    updated_by_participant_id uuid CONSTRAINT sync_whiteboard_draw_policie_updated_by_participant_id_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_whiteboard_draw_policies_policy_check CHECK ((policy = ANY (ARRAY['everyone'::text, 'hosts'::text, 'picked'::text])))
);

CREATE TABLE sync_whiteboard_draw_policy_receipts (
    tenant_id uuid NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    operation_id text NOT NULL,
    policy text NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_whiteboard_draw_policy_receipts_operation_id_check CHECK ((octet_length(operation_id) BETWEEN 16 AND 64)),
    CONSTRAINT sync_whiteboard_draw_policy_receipts_policy_check CHECK ((policy = ANY (ARRAY['everyone'::text, 'hosts'::text, 'picked'::text])))
);

CREATE TABLE sync_whiteboard_elements (
    tenant_id uuid CONSTRAINT sync_whiteboard_elements_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    scene_id uuid CONSTRAINT sync_whiteboard_elements_scene_id_not_null1 NOT NULL,
    element_id text CONSTRAINT sync_whiteboard_elements_element_id_not_null1 NOT NULL,
    element_type text CONSTRAINT sync_whiteboard_elements_element_type_not_null1 NOT NULL,
    version bigint CONSTRAINT sync_whiteboard_elements_version_not_null1 NOT NULL,
    version_nonce bigint CONSTRAINT sync_whiteboard_elements_version_nonce_not_null1 NOT NULL,
    element_index text CONSTRAINT sync_whiteboard_elements_element_index_not_null1 NOT NULL,
    is_deleted boolean CONSTRAINT sync_whiteboard_elements_is_deleted_not_null1 NOT NULL,
    payload jsonb CONSTRAINT sync_whiteboard_elements_payload_not_null1 NOT NULL,
    encoded_bytes integer CONSTRAINT sync_whiteboard_elements_encoded_bytes_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT sync_whiteboard_elements_updated_at_not_null1 NOT NULL,
    CONSTRAINT sync_whiteboard_elements_check1 CHECK (((version >= 0) AND (version_nonce >= 0))),
    CONSTRAINT sync_whiteboard_elements_element_id_check1 CHECK ((octet_length(element_id) BETWEEN 1 AND 128)),
    CONSTRAINT sync_whiteboard_elements_element_index_check1 CHECK ((octet_length(element_index) BETWEEN 1 AND 64)),
    CONSTRAINT sync_whiteboard_elements_element_type_check1 CHECK ((octet_length(element_type) BETWEEN 1 AND 64)),
    CONSTRAINT sync_whiteboard_elements_encoded_bytes_check1 CHECK ((encoded_bytes BETWEEN 2 AND 16384)),
    CONSTRAINT sync_whiteboard_elements_payload_check1 CHECK ((jsonb_typeof(payload) = 'object'::text))
);

CREATE TABLE sync_whiteboard_files (
    upload_id uuid CONSTRAINT sync_whiteboard_files_upload_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT sync_whiteboard_files_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    scene_id uuid CONSTRAINT sync_whiteboard_files_scene_id_not_null1 NOT NULL,
    participant_id uuid NOT NULL,
    participant_generation bigint CONSTRAINT sync_whiteboard_files_participant_generation_not_null1 NOT NULL,
    file_id text CONSTRAINT sync_whiteboard_files_file_id_not_null1 NOT NULL,
    object_key text CONSTRAINT sync_whiteboard_files_object_key_not_null1 NOT NULL,
    mime_type text CONSTRAINT sync_whiteboard_files_mime_type_not_null1 NOT NULL,
    byte_length bigint CONSTRAINT sync_whiteboard_files_byte_length_not_null1 NOT NULL,
    sha256 bytea CONSTRAINT sync_whiteboard_files_sha256_not_null1 NOT NULL,
    status text DEFAULT 'pending'::text CONSTRAINT sync_whiteboard_files_status_not_null1 NOT NULL,
    immutable_object_identity text,
    expires_at timestamp with time zone CONSTRAINT sync_whiteboard_files_expires_at_not_null1 NOT NULL,
    finalized_at timestamp with time zone,
    cleanup_claim_token uuid,
    cleanup_claimed_until timestamp with time zone,
    cleanup_attempts integer DEFAULT 0 CONSTRAINT sync_whiteboard_files_cleanup_attempts_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_whiteboard_files_created_at_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT sync_whiteboard_files_updated_at_not_null1 NOT NULL,
    CONSTRAINT sync_whiteboard_files_byte_length_check1 CHECK ((byte_length BETWEEN 1 AND 268435456)),
    CONSTRAINT sync_whiteboard_files_check2 CHECK (((cleanup_claim_token IS NULL) = (cleanup_claimed_until IS NULL))),
    CONSTRAINT sync_whiteboard_files_check3 CHECK ((((status = 'pending'::text) AND (immutable_object_identity IS NULL) AND (finalized_at IS NULL)) OR ((status = 'finalizing'::text) AND (immutable_object_identity IS NULL) AND (finalized_at IS NULL)) OR ((status = 'ready'::text) AND (immutable_object_identity IS NOT NULL) AND (finalized_at IS NOT NULL)) OR (status = 'failed'::text))),
    CONSTRAINT sync_whiteboard_files_cleanup_attempts_check1 CHECK ((cleanup_attempts >= 0)),
    CONSTRAINT sync_whiteboard_files_file_id_check1 CHECK ((octet_length(file_id) BETWEEN 1 AND 128)),
    CONSTRAINT sync_whiteboard_files_mime_type_check1 CHECK ((octet_length(mime_type) BETWEEN 1 AND 255)),
    CONSTRAINT sync_whiteboard_files_object_key_check1 CHECK ((octet_length(object_key) BETWEEN 1 AND 1024)),
    CONSTRAINT sync_whiteboard_files_sha256_check1 CHECK ((octet_length(sha256) = 32)),
    CONSTRAINT sync_whiteboard_files_status_check1 CHECK ((status = ANY (ARRAY['pending'::text, 'finalizing'::text, 'ready'::text, 'failed'::text])))
);

CREATE TABLE sync_whiteboard_operation_receipts (
    tenant_id uuid CONSTRAINT sync_whiteboard_operation_receipts_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    submitted_generation bigint CONSTRAINT sync_whiteboard_operation_receip_submitted_generation_not_null1 NOT NULL,
    operation_id text CONSTRAINT sync_whiteboard_operation_receipts_operation_id_not_null1 NOT NULL,
    request_fingerprint bytea CONSTRAINT sync_whiteboard_operation_receipt_request_fingerprint_not_null1 NOT NULL,
    operation_name text CONSTRAINT sync_whiteboard_operation_receipts_operation_name_not_null1 NOT NULL,
    outcome text CONSTRAINT sync_whiteboard_operation_receipts_outcome_not_null1 NOT NULL,
    scene_id uuid CONSTRAINT sync_whiteboard_operation_receipts_scene_id_not_null1 NOT NULL,
    revision bigint CONSTRAINT sync_whiteboard_operation_receipts_revision_not_null1 NOT NULL,
    event_elements jsonb,
    event_encoded_bytes integer DEFAULT 0 CONSTRAINT sync_whiteboard_operation_receipt_event_encoded_bytes_not_null1 NOT NULL,
    completed_at timestamp with time zone DEFAULT now() CONSTRAINT sync_whiteboard_operation_receipts_completed_at_not_null1 NOT NULL,
    event_presenting boolean,
    CONSTRAINT sync_whiteboard_operation_receipts_check1 CHECK ((((operation_name = 'submit_update'::text) AND (jsonb_typeof(event_elements) = 'array'::text) AND (event_presenting IS NULL) AND (event_encoded_bytes BETWEEN 2 AND 16777216)) OR ((operation_name = 'set_presentation'::text) AND (event_elements IS NULL) AND (event_presenting IS NOT NULL) AND (event_encoded_bytes = 0)) OR ((operation_name <> ALL (ARRAY['submit_update'::text, 'set_presentation'::text])) AND (event_elements IS NULL) AND (event_presenting IS NULL) AND (event_encoded_bytes = 0)))),
    CONSTRAINT sync_whiteboard_operation_receipts_operation_id_check1 CHECK ((octet_length(operation_id) BETWEEN 16 AND 64)),
    CONSTRAINT sync_whiteboard_operation_receipts_operation_name_check1 CHECK ((operation_name = ANY (ARRAY['submit_update'::text, 'clear'::text, 'set_draw_permission'::text, 'set_presentation'::text]))),
    CONSTRAINT sync_whiteboard_operation_receipts_outcome_check1 CHECK ((outcome = 'committed'::text)),
    CONSTRAINT sync_whiteboard_operation_receipts_request_fingerprint_check1 CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT sync_whiteboard_operation_receipts_revision_check1 CHECK ((revision >= 0))
);

CREATE TABLE sync_whiteboard_permissions (
    tenant_id uuid CONSTRAINT sync_whiteboard_permissions_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    can_draw boolean CONSTRAINT sync_whiteboard_permissions_can_draw_not_null1 NOT NULL,
    granted_by_participant_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT sync_whiteboard_permissions_updated_at_not_null1 NOT NULL
);

CREATE TABLE sync_whiteboard_scenes (
    tenant_id uuid CONSTRAINT sync_whiteboard_scenes_tenant_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    scene_id uuid CONSTRAINT sync_whiteboard_scenes_scene_id_not_null1 NOT NULL,
    is_current boolean DEFAULT true CONSTRAINT sync_whiteboard_scenes_is_current_not_null1 NOT NULL,
    revision bigint DEFAULT 0 CONSTRAINT sync_whiteboard_scenes_revision_not_null1 NOT NULL,
    app_state jsonb,
    element_count integer DEFAULT 0 CONSTRAINT sync_whiteboard_scenes_element_count_not_null1 NOT NULL,
    encoded_bytes bigint DEFAULT 0 CONSTRAINT sync_whiteboard_scenes_encoded_bytes_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT sync_whiteboard_scenes_created_at_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT sync_whiteboard_scenes_updated_at_not_null1 NOT NULL,
    presenting_episode_id uuid,
    episode_id uuid NOT NULL,
    presenting_participant_id uuid,
    CONSTRAINT sync_whiteboard_scenes_app_state_check1 CHECK (((app_state IS NULL) OR ((jsonb_typeof(app_state) = 'object'::text) AND (app_state ? 'view_background_color'::text) AND ((app_state - 'view_background_color'::text) = '{}'::jsonb) AND (jsonb_typeof((app_state -> 'view_background_color'::text)) = 'string'::text)))),
    CONSTRAINT sync_whiteboard_scenes_element_count_check1 CHECK ((element_count BETWEEN 0 AND 10000)),
    CONSTRAINT sync_whiteboard_scenes_encoded_bytes_check1 CHECK ((encoded_bytes BETWEEN 0 AND 67108864)),
    CONSTRAINT sync_whiteboard_scenes_revision_check1 CHECK ((revision >= 0))
);

CREATE TABLE tenant_artifact_policies (
    tenant_id uuid NOT NULL,
    transcription_ceiling text DEFAULT 'automatic'::text NOT NULL,
    transcription_default_mode text DEFAULT 'automatic'::text NOT NULL,
    provider_policy_version text DEFAULT 'chalk-automatic-v1'::text NOT NULL,
    recording_retention_seconds bigint DEFAULT 2592000 NOT NULL,
    transcript_retention_seconds bigint DEFAULT 0 NOT NULL,
    source_window_seconds bigint DEFAULT 86400 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    transcript_language text DEFAULT 'auto'::text NOT NULL,
    CONSTRAINT tenant_artifact_policies_ceiling_check CHECK ((transcription_ceiling = ANY (ARRAY['disabled'::text, 'on_demand'::text, 'automatic'::text]))),
    CONSTRAINT tenant_artifact_policies_default_ceiling_check CHECK ((((transcription_ceiling = 'disabled'::text) AND (transcription_default_mode = 'disabled'::text)) OR ((transcription_ceiling = 'on_demand'::text) AND (transcription_default_mode = ANY (ARRAY['disabled'::text, 'on_demand'::text]))) OR (transcription_ceiling = 'automatic'::text))),
    CONSTRAINT tenant_artifact_policies_default_check CHECK ((transcription_default_mode = ANY (ARRAY['disabled'::text, 'on_demand'::text, 'automatic'::text]))),
    CONSTRAINT tenant_artifact_policies_provider_policy_check CHECK (((transcription_ceiling = 'disabled'::text) OR (btrim(provider_policy_version) <> ''::text))),
    CONSTRAINT tenant_artifact_policies_recording_retention_check CHECK (((recording_retention_seconds >= 0) AND (recording_retention_seconds <= '9223372036'::bigint))),
    CONSTRAINT tenant_artifact_policies_source_window_check CHECK ((((transcription_ceiling = 'disabled'::text) AND (source_window_seconds = 0)) OR ((transcription_ceiling = ANY (ARRAY['on_demand'::text, 'automatic'::text])) AND (source_window_seconds BETWEEN 1 AND 2592000)))),
    CONSTRAINT tenant_artifact_policies_transcript_language_check CHECK ((transcript_language = ANY (ARRAY['auto'::text, 'af'::text, 'am'::text, 'ar'::text, 'as'::text, 'az'::text, 'ba'::text, 'be'::text, 'bg'::text, 'bn'::text, 'bo'::text, 'br'::text, 'bs'::text, 'ca'::text, 'cs'::text, 'cy'::text, 'da'::text, 'de'::text, 'el'::text, 'en'::text, 'es'::text, 'et'::text, 'eu'::text, 'fa'::text, 'fi'::text, 'fo'::text, 'fr'::text, 'gl'::text, 'gu'::text, 'ha'::text, 'haw'::text, 'he'::text, 'hi'::text, 'hr'::text, 'ht'::text, 'hu'::text, 'hy'::text, 'id'::text, 'is'::text, 'it'::text, 'ja'::text, 'jw'::text, 'ka'::text, 'kk'::text, 'km'::text, 'kn'::text, 'ko'::text, 'la'::text, 'lb'::text, 'ln'::text, 'lo'::text, 'lt'::text, 'lv'::text, 'mg'::text, 'mi'::text, 'mk'::text, 'ml'::text, 'mn'::text, 'mr'::text, 'ms'::text, 'mt'::text, 'my'::text, 'ne'::text, 'nl'::text, 'nn'::text, 'no'::text, 'oc'::text, 'pa'::text, 'pl'::text, 'ps'::text, 'pt'::text, 'ro'::text, 'ru'::text, 'sa'::text, 'sd'::text, 'si'::text, 'sk'::text, 'sl'::text, 'sn'::text, 'so'::text, 'sq'::text, 'sr'::text, 'su'::text, 'sv'::text, 'sw'::text, 'ta'::text, 'te'::text, 'tg'::text, 'th'::text, 'tk'::text, 'tl'::text, 'tr'::text, 'tt'::text, 'uk'::text, 'ur'::text, 'uz'::text, 'vi'::text, 'yi'::text, 'yo'::text, 'yue'::text, 'zh'::text]))),
    CONSTRAINT tenant_artifact_policies_transcript_retention_check CHECK (((transcript_retention_seconds >= 0) AND (transcript_retention_seconds <= '9223372036'::bigint)))
);

CREATE TABLE tenant_onboarding_requests (
    account_id uuid NOT NULL,
    request_key text NOT NULL,
    request_fingerprint bytea NOT NULL,
    tenant_id uuid NOT NULL,
    tenant_access_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_onboarding_requests_fingerprint_check CHECK ((octet_length(request_fingerprint) = 32)),
    CONSTRAINT tenant_onboarding_requests_key_check CHECK ((request_key ~ '^[A-Za-z0-9_-]{16,128}$'::text))
);

CREATE TABLE tenant_signing_keys (
    id uuid CONSTRAINT tenant_signing_keys_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT tenant_signing_keys_tenant_id_not_null1 NOT NULL,
    key_id text CONSTRAINT tenant_signing_keys_key_id_not_null1 NOT NULL,
    algorithm text CONSTRAINT tenant_signing_keys_algorithm_not_null1 NOT NULL,
    public_key_jwk jsonb CONSTRAINT tenant_signing_keys_public_key_jwk_not_null1 NOT NULL,
    last_used_at timestamp with time zone,
    created_by_api_key_id uuid,
    created_by_user_id uuid,
    revoked_at timestamp with time zone,
    expires_at timestamp with time zone CONSTRAINT tenant_signing_keys_expires_at_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT tenant_signing_keys_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT tenant_signing_keys_created_at_not_null1 NOT NULL
);

CREATE TABLE tenants (
    id uuid CONSTRAINT tenants_id_not_null1 NOT NULL,
    name text CONSTRAINT tenants_name_not_null1 NOT NULL,
    default_region text,
    default_media_plane text,
    media_plane_provider_config jsonb,
    ai_provider_config jsonb,
    storage_provider_config jsonb,
    logo_key text,
    website text,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT tenants_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT tenants_created_at_not_null1 NOT NULL,
    cors_allowed_origins text[] DEFAULT '{}'::text[] NOT NULL,
    created_by_service_id text,
    external_id text,
    recording_render_mode text DEFAULT 'on_demand'::text NOT NULL,
    default_media_plane_approved boolean DEFAULT false NOT NULL,
    CONSTRAINT tenants_cors_allowed_origins_count_check CHECK ((cardinality(cors_allowed_origins) <= 32)),
    CONSTRAINT tenants_external_id_check CHECK (((external_id IS NULL) OR ((created_by_service_id IS NOT NULL) AND (length(external_id) BETWEEN 1 AND 512) AND (btrim(external_id) = external_id)))),
    CONSTRAINT tenants_recording_render_mode_check CHECK ((recording_render_mode = ANY (ARRAY['on_demand'::text, 'automatic'::text]))),
    CONSTRAINT tenants_service_id_check CHECK (((created_by_service_id IS NULL) OR ((length(created_by_service_id) BETWEEN 1 AND 128) AND (btrim(created_by_service_id) = created_by_service_id))))
);

CREATE TABLE transcript_chunks (
    id uuid CONSTRAINT transcript_chunks_id_not_null1 NOT NULL,
    transcript_id uuid CONSTRAINT transcript_chunks_transcript_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT transcript_chunks_tenant_id_not_null1 NOT NULL,
    chunk_index integer CONSTRAINT transcript_chunks_chunk_index_not_null1 NOT NULL,
    generation bigint DEFAULT 1 CONSTRAINT transcript_chunks_generation_not_null1 NOT NULL,
    start_ms bigint CONSTRAINT transcript_chunks_start_ms_not_null1 NOT NULL,
    end_ms bigint CONSTRAINT transcript_chunks_end_ms_not_null1 NOT NULL,
    participant_ref text,
    track_epoch text,
    identity_kind text DEFAULT 'unknown'::text CONSTRAINT transcript_chunks_identity_kind_not_null1 NOT NULL,
    track_class text DEFAULT 'unknown'::text CONSTRAINT transcript_chunks_track_class_not_null1 NOT NULL,
    storage_key text CONSTRAINT transcript_chunks_storage_key_not_null1 NOT NULL,
    result_key text CONSTRAINT transcript_chunks_result_key_not_null1 NOT NULL,
    checksum bytea CONSTRAINT transcript_chunks_checksum_not_null1 NOT NULL,
    size bigint CONSTRAINT transcript_chunks_size_not_null1 NOT NULL,
    content_type text CONSTRAINT transcript_chunks_content_type_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT transcript_chunks_created_at_not_null1 NOT NULL,
    CONSTRAINT transcript_chunks_checksum_check CHECK ((octet_length(checksum) = 32)),
    CONSTRAINT transcript_chunks_epoch_check CHECK (((track_epoch IS NULL) OR (length(track_epoch) BETWEEN 1 AND 128))),
    CONSTRAINT transcript_chunks_generation_check CHECK ((generation > 0)),
    CONSTRAINT transcript_chunks_identity_fields_check CHECK ((((identity_kind = 'participant'::text) AND (participant_ref IS NOT NULL) AND (track_epoch IS NOT NULL)) OR ((identity_kind = ANY (ARRAY['shared'::text, 'unknown'::text])) AND (participant_ref IS NULL) AND (track_epoch IS NULL)))),
    CONSTRAINT transcript_chunks_identity_kind_check CHECK ((identity_kind = ANY (ARRAY['participant'::text, 'shared'::text, 'unknown'::text]))),
    CONSTRAINT transcript_chunks_index_check CHECK ((chunk_index >= 0)),
    CONSTRAINT transcript_chunks_key_check CHECK (((length(storage_key) BETWEEN 1 AND 1024) AND (storage_key !~ '(^/|//|(^|/)\.\.?(/|$))'::text))),
    CONSTRAINT transcript_chunks_ref_check CHECK (((participant_ref IS NULL) OR (length(participant_ref) BETWEEN 1 AND 128))),
    CONSTRAINT transcript_chunks_result_key_check CHECK (((length(result_key) BETWEEN 1 AND 1024) AND (result_key !~ '(^/|//|(^|/)\.\.?(/|$))'::text))),
    CONSTRAINT transcript_chunks_size_check CHECK ((size BETWEEN 1 AND 524288000)),
    CONSTRAINT transcript_chunks_system_audio_identity_check CHECK ((NOT ((track_class = 'system-audio'::text) AND (identity_kind = 'participant'::text)))),
    CONSTRAINT transcript_chunks_time_check CHECK (((start_ms >= 0) AND (end_ms > start_ms))),
    CONSTRAINT transcript_chunks_track_class_check CHECK ((track_class = ANY (ARRAY['microphone'::text, 'screen-share'::text, 'system-audio'::text, 'unknown'::text])))
);

CREATE TABLE transcription_attempts (
    id uuid CONSTRAINT transcription_attempts_id_not_null1 NOT NULL,
    transcript_id uuid CONSTRAINT transcription_attempts_transcript_id_not_null1 NOT NULL,
    chunk_id uuid CONSTRAINT transcription_attempts_chunk_id_not_null1 NOT NULL,
    generation bigint CONSTRAINT transcription_attempts_generation_not_null1 NOT NULL,
    attempt integer CONSTRAINT transcription_attempts_attempt_not_null1 NOT NULL,
    provider text CONSTRAINT transcription_attempts_provider_not_null1 NOT NULL,
    model text CONSTRAINT transcription_attempts_model_not_null1 NOT NULL,
    provider_version text CONSTRAINT transcription_attempts_provider_version_not_null1 NOT NULL,
    execution_identity text,
    provider_request_id text,
    measured_audio_ms bigint,
    provider_observed_duration_ms bigint,
    state text CONSTRAINT transcription_attempts_state_not_null1 NOT NULL,
    billed_audio_seconds integer,
    error_code text,
    error_detail text,
    journey_id uuid,
    traceparent text,
    tracestate text,
    quality jsonb DEFAULT '{}'::jsonb CONSTRAINT transcription_attempts_quality_not_null1 NOT NULL,
    started_at timestamp with time zone DEFAULT now() CONSTRAINT transcription_attempts_started_at_not_null1 NOT NULL,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT transcription_attempts_created_at_not_null1 NOT NULL,
    CONSTRAINT transcription_attempts_attempt_check CHECK (((attempt > 0) AND (attempt <= 32))),
    CONSTRAINT transcription_attempts_billed_check CHECK (((billed_audio_seconds IS NULL) OR (billed_audio_seconds BETWEEN 0 AND 86400))),
    CONSTRAINT transcription_attempts_error_detail_check CHECK (((error_detail IS NULL) OR (octet_length(error_detail) <= 2048))),
    CONSTRAINT transcription_attempts_execution_identity_check CHECK (((execution_identity IS NULL) OR (length(execution_identity) BETWEEN 1 AND 256))),
    CONSTRAINT transcription_attempts_generation_check CHECK ((generation > 0)),
    CONSTRAINT transcription_attempts_measured_audio_check CHECK (((measured_audio_ms IS NULL) OR (measured_audio_ms BETWEEN 0 AND 86400000))),
    CONSTRAINT transcription_attempts_model_check CHECK ((length(model) BETWEEN 1 AND 256)),
    CONSTRAINT transcription_attempts_observed_duration_check CHECK (((provider_observed_duration_ms IS NULL) OR (provider_observed_duration_ms BETWEEN 0 AND 86400000))),
    CONSTRAINT transcription_attempts_provider_check CHECK ((length(provider) BETWEEN 1 AND 128)),
    CONSTRAINT transcription_attempts_quality_check CHECK ((jsonb_typeof(quality) = 'object'::text)),
    CONSTRAINT transcription_attempts_request_id_check CHECK (((provider_request_id IS NULL) OR (length(provider_request_id) BETWEEN 1 AND 256))),
    CONSTRAINT transcription_attempts_state_check CHECK ((state = ANY (ARRAY['started'::text, 'retryable_failure'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text]))),
    CONSTRAINT transcription_attempts_traceparent_check CHECK (((traceparent IS NULL) OR (length(traceparent) <= 256))),
    CONSTRAINT transcription_attempts_tracestate_check CHECK (((tracestate IS NULL) OR (length(tracestate) <= 512))),
    CONSTRAINT transcription_attempts_version_check CHECK ((length(provider_version) BETWEEN 1 AND 256))
);

CREATE TABLE transcription_chunk_results (
    id uuid CONSTRAINT transcription_chunk_results_id_not_null1 NOT NULL,
    chunk_id uuid CONSTRAINT transcription_chunk_results_chunk_id_not_null1 NOT NULL,
    generation bigint CONSTRAINT transcription_chunk_results_generation_not_null1 NOT NULL,
    attempt_id uuid CONSTRAINT transcription_chunk_results_attempt_id_not_null1 NOT NULL,
    provider text CONSTRAINT transcription_chunk_results_provider_not_null1 NOT NULL,
    model text CONSTRAINT transcription_chunk_results_model_not_null1 NOT NULL,
    provider_version text CONSTRAINT transcription_chunk_results_provider_version_not_null1 NOT NULL,
    result_key text CONSTRAINT transcription_chunk_results_result_key_not_null1 NOT NULL,
    result_sha256 bytea CONSTRAINT transcription_chunk_results_result_sha256_not_null1 NOT NULL,
    result_size bigint CONSTRAINT transcription_chunk_results_result_size_not_null1 NOT NULL,
    result_content_type text CONSTRAINT transcription_chunk_results_result_content_type_not_null1 NOT NULL,
    language text,
    billed_audio_seconds integer,
    quality jsonb DEFAULT '{}'::jsonb CONSTRAINT transcription_chunk_results_quality_not_null1 NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() CONSTRAINT transcription_chunk_results_accepted_at_not_null1 NOT NULL,
    CONSTRAINT transcription_chunk_results_billed_check CHECK (((billed_audio_seconds IS NULL) OR (billed_audio_seconds BETWEEN 0 AND 86400))),
    CONSTRAINT transcription_chunk_results_generation_check CHECK ((generation > 0)),
    CONSTRAINT transcription_chunk_results_key_check CHECK (((length(result_key) BETWEEN 1 AND 1024) AND (result_key !~ '(^/|//|(^|/)\.\.?(/|$))'::text))),
    CONSTRAINT transcription_chunk_results_quality_check CHECK ((jsonb_typeof(quality) = 'object'::text)),
    CONSTRAINT transcription_chunk_results_sha256_check CHECK ((octet_length(result_sha256) = 32)),
    CONSTRAINT transcription_chunk_results_size_check CHECK ((result_size BETWEEN 1 AND 524288000))
);

CREATE TABLE transcription_cleanup_jobs (
    id uuid CONSTRAINT transcription_cleanup_jobs_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT transcription_cleanup_jobs_tenant_id_not_null1 NOT NULL,
    transcript_id uuid,
    object_key text CONSTRAINT transcription_cleanup_jobs_object_key_not_null1 NOT NULL,
    object_kind text CONSTRAINT transcription_cleanup_jobs_object_kind_not_null1 NOT NULL,
    due_at timestamp with time zone CONSTRAINT transcription_cleanup_jobs_due_at_not_null1 NOT NULL,
    state text DEFAULT 'pending'::text CONSTRAINT transcription_cleanup_jobs_state_not_null1 NOT NULL,
    attempt_count integer DEFAULT 0 CONSTRAINT transcription_cleanup_jobs_attempt_count_not_null1 NOT NULL,
    attempt_limit integer DEFAULT 8 CONSTRAINT transcription_cleanup_jobs_attempt_limit_not_null1 NOT NULL,
    lease_token_hash bytea,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    error_code text,
    error_detail text,
    verified_at timestamp with time zone,
    provider_copy_status text DEFAULT 'not_applicable'::text CONSTRAINT transcription_cleanup_jobs_provider_copy_status_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT transcription_cleanup_jobs_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT transcription_cleanup_jobs_created_at_not_null1 NOT NULL,
    recording_id uuid NOT NULL,
    CONSTRAINT transcription_cleanup_jobs_attempt_check CHECK (((attempt_count >= 0) AND (attempt_count <= attempt_limit))),
    CONSTRAINT transcription_cleanup_jobs_attempt_limit_check CHECK ((attempt_limit BETWEEN 1 AND 32)),
    CONSTRAINT transcription_cleanup_jobs_key_check CHECK (((length(object_key) BETWEEN 1 AND 1024) AND (object_key !~ '(^/|//|(^|/)\.\.?(/|$))'::text))),
    CONSTRAINT transcription_cleanup_jobs_kind_check CHECK ((object_kind = ANY (ARRAY['final_artifact'::text, 'temp_result'::text, 'source_manifest'::text, 'source_chunk'::text, 'recording_source'::text]))),
    CONSTRAINT transcription_cleanup_jobs_lease_fields_check CHECK ((((lease_token_hash IS NULL) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_token_hash IS NOT NULL) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT transcription_cleanup_jobs_lease_hash_check CHECK (((lease_token_hash IS NULL) OR (octet_length(lease_token_hash) = 32))),
    CONSTRAINT transcription_cleanup_jobs_owner_check CHECK ((((object_kind = ANY (ARRAY['final_artifact'::text, 'temp_result'::text])) AND (transcript_id IS NOT NULL)) OR (object_kind = ANY (ARRAY['source_manifest'::text, 'source_chunk'::text, 'recording_source'::text])))),
    CONSTRAINT transcription_cleanup_jobs_provider_copy_check CHECK ((provider_copy_status = ANY (ARRAY['not_applicable'::text, 'pending'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT transcription_cleanup_jobs_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'leased'::text, 'retryable'::text, 'completed'::text, 'dead_letter'::text]))),
    CONSTRAINT transcription_cleanup_jobs_verified_check CHECK (((state = 'completed'::text) = (verified_at IS NOT NULL)))
);

CREATE TABLE transcriptions (
    id uuid CONSTRAINT transcriptions_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT transcriptions_tenant_id_not_null1 NOT NULL,
    recording_id uuid CONSTRAINT transcriptions_recording_id_not_null1 NOT NULL,
    space_id uuid NOT NULL,
    episode_id uuid NOT NULL,
    status text CONSTRAINT transcriptions_status_not_null1 NOT NULL,
    provider text,
    model text,
    languages text[] CONSTRAINT transcriptions_languages_not_null1 NOT NULL,
    metadata jsonb,
    artifact_key text,
    artifact_sha256 bytea,
    artifact_size bigint,
    artifact_content_type text,
    source_manifest_key text,
    source_manifest_sha256 bytea,
    source_manifest_size bigint,
    source_manifest_content_type text,
    generation bigint DEFAULT 1 CONSTRAINT transcriptions_generation_not_null1 NOT NULL,
    completed_at timestamp with time zone,
    deleted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT transcriptions_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT transcriptions_created_at_not_null1 NOT NULL,
    source_expires_at timestamp with time zone,
    transcript_language text DEFAULT 'auto'::text NOT NULL,
    CONSTRAINT transcriptions_artifact_key_check CHECK (((artifact_key IS NULL) OR ((length(artifact_key) BETWEEN 1 AND 1024) AND (artifact_key !~ '(^/|//|(^|/)\.\.?(/|$))'::text)))),
    CONSTRAINT transcriptions_artifact_sha256_check CHECK (((artifact_sha256 IS NULL) OR (octet_length(artifact_sha256) = 32))),
    CONSTRAINT transcriptions_artifact_size_check CHECK (((artifact_size IS NULL) OR (artifact_size >= 0))),
    CONSTRAINT transcriptions_generation_check CHECK ((generation > 0)),
    CONSTRAINT transcriptions_source_manifest_sha256_check CHECK (((source_manifest_sha256 IS NULL) OR (octet_length(source_manifest_sha256) = 32))),
    CONSTRAINT transcriptions_source_manifest_size_check CHECK (((source_manifest_size IS NULL) OR (source_manifest_size >= 0))),
    CONSTRAINT transcriptions_status_check CHECK ((status = ANY (ARRAY['not_requested'::text, 'preparing'::text, 'transcribing'::text, 'verifying'::text, 'complete'::text, 'retryable_failure'::text, 'terminal_failure'::text, 'deleted'::text]))),
    CONSTRAINT transcriptions_transcript_language_check CHECK ((transcript_language = ANY (ARRAY['auto'::text, 'af'::text, 'am'::text, 'ar'::text, 'as'::text, 'az'::text, 'ba'::text, 'be'::text, 'bg'::text, 'bn'::text, 'bo'::text, 'br'::text, 'bs'::text, 'ca'::text, 'cs'::text, 'cy'::text, 'da'::text, 'de'::text, 'el'::text, 'en'::text, 'es'::text, 'et'::text, 'eu'::text, 'fa'::text, 'fi'::text, 'fo'::text, 'fr'::text, 'gl'::text, 'gu'::text, 'ha'::text, 'haw'::text, 'he'::text, 'hi'::text, 'hr'::text, 'ht'::text, 'hu'::text, 'hy'::text, 'id'::text, 'is'::text, 'it'::text, 'ja'::text, 'jw'::text, 'ka'::text, 'kk'::text, 'km'::text, 'kn'::text, 'ko'::text, 'la'::text, 'lb'::text, 'ln'::text, 'lo'::text, 'lt'::text, 'lv'::text, 'mg'::text, 'mi'::text, 'mk'::text, 'ml'::text, 'mn'::text, 'mr'::text, 'ms'::text, 'mt'::text, 'my'::text, 'ne'::text, 'nl'::text, 'nn'::text, 'no'::text, 'oc'::text, 'pa'::text, 'pl'::text, 'ps'::text, 'pt'::text, 'ro'::text, 'ru'::text, 'sa'::text, 'sd'::text, 'si'::text, 'sk'::text, 'sl'::text, 'sn'::text, 'so'::text, 'sq'::text, 'sr'::text, 'su'::text, 'sv'::text, 'sw'::text, 'ta'::text, 'te'::text, 'tg'::text, 'th'::text, 'tk'::text, 'tl'::text, 'tr'::text, 'tt'::text, 'uk'::text, 'ur'::text, 'uz'::text, 'vi'::text, 'yi'::text, 'yo'::text, 'yue'::text, 'zh'::text])))
);

CREATE TABLE users (
    id uuid CONSTRAINT users_id_not_null1 NOT NULL,
    name text CONSTRAINT users_name_not_null1 NOT NULL,
    email text CONSTRAINT users_email_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT users_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT users_created_at_not_null1 NOT NULL
);

CREATE TABLE webhook_deliveries (
    id uuid CONSTRAINT webhook_deliveries_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT webhook_deliveries_tenant_id_not_null1 NOT NULL,
    event_id uuid CONSTRAINT webhook_deliveries_event_id_not_null1 NOT NULL,
    endpoint_id uuid CONSTRAINT webhook_deliveries_endpoint_id_not_null1 NOT NULL,
    endpoint_revision_id uuid CONSTRAINT webhook_deliveries_endpoint_revision_id_not_null1 NOT NULL,
    endpoint_revision integer CONSTRAINT webhook_deliveries_endpoint_revision_not_null1 NOT NULL,
    state text CONSTRAINT webhook_deliveries_state_not_null1 NOT NULL,
    next_attempt_at timestamp with time zone,
    attempt_count integer DEFAULT 0 CONSTRAINT webhook_deliveries_attempt_count_not_null1 NOT NULL,
    lease_token uuid,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    terminal_at timestamp with time zone,
    queued_journey_event_id uuid CONSTRAINT webhook_deliveries_queued_journey_event_id_not_null1 NOT NULL,
    terminal_journey_event_id uuid,
    parent_delivery_id uuid,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT webhook_deliveries_created_at_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT webhook_deliveries_updated_at_not_null1 NOT NULL,
    CONSTRAINT webhook_deliveries_attempt_count_check CHECK ((attempt_count BETWEEN 0 AND 11)),
    CONSTRAINT webhook_deliveries_lease_check CHECK ((((state = 'delivering'::text) AND (lease_token IS NOT NULL) AND (lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)) OR ((state <> 'delivering'::text) AND (lease_token IS NULL) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL)))),
    CONSTRAINT webhook_deliveries_schedule_check CHECK ((((state = ANY (ARRAY['pending'::text, 'retry_wait'::text])) AND (next_attempt_at IS NOT NULL) AND (terminal_at IS NULL)) OR ((state = 'delivering'::text) AND (next_attempt_at IS NULL) AND (terminal_at IS NULL)) OR ((state = ANY (ARRAY['succeeded'::text, 'exhausted'::text, 'canceled'::text, 'erased'::text])) AND (next_attempt_at IS NULL) AND (terminal_at IS NOT NULL)))),
    CONSTRAINT webhook_deliveries_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'delivering'::text, 'retry_wait'::text, 'succeeded'::text, 'exhausted'::text, 'canceled'::text, 'erased'::text])))
);

CREATE TABLE webhook_delivery_attempts (
    id uuid CONSTRAINT webhook_delivery_attempts_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT webhook_delivery_attempts_tenant_id_not_null1 NOT NULL,
    delivery_id uuid CONSTRAINT webhook_delivery_attempts_delivery_id_not_null1 NOT NULL,
    attempt_number integer CONSTRAINT webhook_delivery_attempts_attempt_number_not_null1 NOT NULL,
    started_at timestamp with time zone CONSTRAINT webhook_delivery_attempts_started_at_not_null1 NOT NULL,
    finished_at timestamp with time zone,
    latency_milliseconds integer,
    outcome text CONSTRAINT webhook_delivery_attempts_outcome_not_null1 NOT NULL,
    http_status integer,
    error_code text,
    trace_id text,
    span_id text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT webhook_delivery_attempts_created_at_not_null1 NOT NULL,
    CONSTRAINT webhook_delivery_attempts_completion_check CHECK ((((outcome = 'started'::text) AND (finished_at IS NULL) AND (latency_milliseconds IS NULL) AND (http_status IS NULL) AND (error_code IS NULL)) OR ((outcome <> 'started'::text) AND (finished_at IS NOT NULL) AND (latency_milliseconds >= 0)))),
    CONSTRAINT webhook_delivery_attempts_error_code_check CHECK (((error_code IS NULL) OR (octet_length(error_code) BETWEEN 1 AND 96))),
    CONSTRAINT webhook_delivery_attempts_http_status_check CHECK (((http_status IS NULL) OR (http_status BETWEEN 100 AND 599))),
    CONSTRAINT webhook_delivery_attempts_number_check CHECK ((attempt_number BETWEEN 1 AND 11)),
    CONSTRAINT webhook_delivery_attempts_outcome_check CHECK ((outcome = ANY (ARRAY['started'::text, 'succeeded'::text, 'retryable_failure'::text, 'terminal_failure'::text, 'lease_expired'::text]))),
    CONSTRAINT webhook_delivery_attempts_span_id_check CHECK (((span_id IS NULL) OR (span_id ~ '^[0-9a-f]{16}$'::text))),
    CONSTRAINT webhook_delivery_attempts_trace_id_check CHECK (((trace_id IS NULL) OR (trace_id ~ '^[0-9a-f]{32}$'::text)))
);

CREATE TABLE webhook_endpoint_revisions (
    id uuid CONSTRAINT webhook_endpoint_revisions_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT webhook_endpoint_revisions_tenant_id_not_null1 NOT NULL,
    endpoint_id uuid CONSTRAINT webhook_endpoint_revisions_endpoint_id_not_null1 NOT NULL,
    revision integer CONSTRAINT webhook_endpoint_revisions_revision_not_null1 NOT NULL,
    url_ciphertext bytea,
    url_redacted text CONSTRAINT webhook_endpoint_revisions_url_redacted_not_null1 NOT NULL,
    url_destroyed_at timestamp with time zone,
    api_version integer CONSTRAINT webhook_endpoint_revisions_api_version_not_null1 NOT NULL,
    event_types text[] CONSTRAINT webhook_endpoint_revisions_event_types_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT webhook_endpoint_revisions_created_at_not_null1 NOT NULL,
    CONSTRAINT webhook_endpoint_revisions_api_version_check CHECK ((api_version = 1)),
    CONSTRAINT webhook_endpoint_revisions_event_types_check CHECK (((cardinality(event_types) BETWEEN 1 AND 14) AND (event_types <@ ARRAY['space.created'::text, 'space.updated'::text, 'space.archived'::text, 'space.restored'::text, 'episode.started'::text, 'episode.ended'::text, 'participant.joined'::text, 'participant.left'::text, 'recording.started'::text, 'recording.completed'::text, 'recording.failed'::text, 'transcript.started'::text, 'transcript.completed'::text, 'transcript.failed'::text]))),
    CONSTRAINT webhook_endpoint_revisions_revision_check CHECK ((revision > 0)),
    CONSTRAINT webhook_endpoint_revisions_url_check CHECK ((octet_length(url_redacted) BETWEEN 1 AND 2048)),
    CONSTRAINT webhook_endpoint_revisions_url_ciphertext_check CHECK ((((url_ciphertext IS NOT NULL) AND (url_destroyed_at IS NULL)) OR ((url_ciphertext IS NULL) AND (url_destroyed_at IS NOT NULL))))
);

CREATE TABLE webhook_endpoints (
    id uuid CONSTRAINT webhook_endpoints_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT webhook_endpoints_tenant_id_not_null1 NOT NULL,
    name text CONSTRAINT webhook_endpoints_name_not_null1 NOT NULL,
    enabled boolean CONSTRAINT webhook_endpoints_enabled_not_null1 NOT NULL,
    revision integer CONSTRAINT webhook_endpoints_revision_not_null1 NOT NULL,
    current_target_revision integer CONSTRAINT webhook_endpoints_current_target_revision_not_null1 NOT NULL,
    current_secret_ciphertext bytea,
    previous_secret_ciphertext bytea,
    previous_secret_expires_at timestamp with time zone,
    created_by_user_id uuid,
    deleted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT webhook_endpoints_updated_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT webhook_endpoints_created_at_not_null1 NOT NULL,
    CONSTRAINT webhook_endpoints_deleted_secret_check CHECK ((((deleted_at IS NULL) AND (current_secret_ciphertext IS NOT NULL)) OR ((deleted_at IS NOT NULL) AND (NOT enabled) AND (current_secret_ciphertext IS NULL) AND (previous_secret_ciphertext IS NULL) AND (previous_secret_expires_at IS NULL)))),
    CONSTRAINT webhook_endpoints_name_check CHECK (((char_length(btrim(name)) BETWEEN 1 AND 100) AND (name = btrim(name)))),
    CONSTRAINT webhook_endpoints_previous_secret_check CHECK ((((previous_secret_ciphertext IS NULL) AND (previous_secret_expires_at IS NULL)) OR ((previous_secret_ciphertext IS NOT NULL) AND (previous_secret_expires_at IS NOT NULL)))),
    CONSTRAINT webhook_endpoints_revision_check CHECK (((revision > 0) AND (current_target_revision > 0)))
);

CREATE TABLE webhook_events (
    id uuid CONSTRAINT webhook_events_id_not_null1 NOT NULL,
    tenant_id uuid CONSTRAINT webhook_events_tenant_id_not_null1 NOT NULL,
    event_name text CONSTRAINT webhook_events_event_name_not_null1 NOT NULL,
    api_version integer CONSTRAINT webhook_events_api_version_not_null1 NOT NULL,
    occurred_at timestamp with time zone CONSTRAINT webhook_events_occurred_at_not_null1 NOT NULL,
    body bytea,
    body_sha256 bytea CONSTRAINT webhook_events_body_sha256_not_null1 NOT NULL,
    semantic_transition_key text CONSTRAINT webhook_events_semantic_transition_key_not_null1 NOT NULL,
    resource_type text CONSTRAINT webhook_events_resource_type_not_null1 NOT NULL,
    resource_id uuid CONSTRAINT webhook_events_resource_id_not_null1 NOT NULL,
    linked_user_id uuid,
    journey_id uuid CONSTRAINT webhook_events_journey_id_not_null1 NOT NULL,
    parent_journey_event_id uuid,
    producing_trace_id text,
    producing_span_id text,
    erased_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT webhook_events_created_at_not_null1 NOT NULL,
    CONSTRAINT webhook_events_api_version_check CHECK ((api_version = 1)),
    CONSTRAINT webhook_events_body_check CHECK ((((body IS NOT NULL) AND (octet_length(body) BETWEEN 1 AND 262144) AND (erased_at IS NULL)) OR ((body IS NULL) AND (erased_at IS NOT NULL)))),
    CONSTRAINT webhook_events_body_hash_check CHECK ((octet_length(body_sha256) = 32)),
    CONSTRAINT webhook_events_name_check CHECK ((event_name = ANY (ARRAY['space.created'::text, 'space.updated'::text, 'space.archived'::text, 'space.restored'::text, 'episode.started'::text, 'episode.ended'::text, 'participant.joined'::text, 'participant.left'::text, 'recording.started'::text, 'recording.completed'::text, 'recording.failed'::text, 'transcript.started'::text, 'transcript.completed'::text, 'transcript.failed'::text, 'endpoint.test'::text]))),
    CONSTRAINT webhook_events_resource_type_check CHECK ((resource_type = ANY (ARRAY['space'::text, 'episode'::text, 'participant'::text, 'recording'::text, 'transcript'::text, 'webhook_endpoint'::text]))),
    CONSTRAINT webhook_events_semantic_key_check CHECK ((octet_length(semantic_transition_key) BETWEEN 1 AND 200)),
    CONSTRAINT webhook_events_span_id_check CHECK (((producing_span_id IS NULL) OR (producing_span_id ~ '^[0-9a-f]{16}$'::text))),
    CONSTRAINT webhook_events_trace_id_check CHECK (((producing_trace_id IS NULL) OR (producing_trace_id ~ '^[0-9a-f]{32}$'::text)))
);

CREATE TABLE webhook_idempotency_records (
    tenant_id uuid CONSTRAINT webhook_idempotency_records_tenant_id_not_null1 NOT NULL,
    operation text CONSTRAINT webhook_idempotency_records_operation_not_null1 NOT NULL,
    idempotency_key text CONSTRAINT webhook_idempotency_records_idempotency_key_not_null1 NOT NULL,
    request_sha256 bytea CONSTRAINT webhook_idempotency_records_request_sha256_not_null1 NOT NULL,
    response_status integer CONSTRAINT webhook_idempotency_records_response_status_not_null1 NOT NULL,
    response_ciphertext bytea,
    resource_id uuid,
    expires_at timestamp with time zone CONSTRAINT webhook_idempotency_records_expires_at_not_null1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT webhook_idempotency_records_created_at_not_null1 NOT NULL,
    CONSTRAINT webhook_idempotency_records_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT webhook_idempotency_records_hash_check CHECK ((octet_length(request_sha256) = 32)),
    CONSTRAINT webhook_idempotency_records_key_check CHECK ((idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'::text)),
    CONSTRAINT webhook_idempotency_records_operation_check CHECK ((operation = ANY (ARRAY['endpoint.create'::text, 'endpoint.patch'::text, 'endpoint.delete'::text, 'endpoint.rotate_secret'::text, 'endpoint.test'::text, 'delivery.redeliver'::text]))),
    CONSTRAINT webhook_idempotency_records_status_check CHECK ((response_status BETWEEN 200 AND 299))
);

CREATE TABLE webhook_tenant_state (
    tenant_id uuid CONSTRAINT webhook_tenant_state_tenant_id_not_null1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT webhook_tenant_state_updated_at_not_null1 NOT NULL
);

ALTER TABLE ONLY api_key_mutation_requests
    ADD CONSTRAINT api_key_mutation_requests_pkey PRIMARY KEY (tenant_id, operation, request_key);

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_key_prefix_key UNIQUE (key_prefix);

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY artifact_jobs
    ADD CONSTRAINT artifact_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY artifact_jobs
    ADD CONSTRAINT artifact_jobs_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);

ALTER TABLE ONLY auth_identities
    ADD CONSTRAINT auth_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_identities
    ADD CONSTRAINT auth_identities_provider_provider_subject_key UNIQUE (provider, provider_subject);

ALTER TABLE ONLY auto_space_lifecycles
    ADD CONSTRAINT auto_space_lifecycles_pkey PRIMARY KEY (tenant_id, space_id);

ALTER TABLE ONLY automatic_transcript_space_policy_backup
    ADD CONSTRAINT automatic_transcript_space_policy_backup_pkey PRIMARY KEY (space_id);

ALTER TABLE ONLY automatic_transcript_tenant_policy_backup
    ADD CONSTRAINT automatic_transcript_tenant_policy_backup_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY episode_create_requests
    ADD CONSTRAINT episode_create_requests_pkey PRIMARY KEY (tenant_id, space_id, request_key);

ALTER TABLE ONLY episode_presence_leases
    ADD CONSTRAINT episode_presence_leases_pkey PRIMARY KEY (tenant_id, space_id, episode_id);

ALTER TABLE ONLY episodes
    ADD CONSTRAINT episodes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY episodes
    ADD CONSTRAINT episodes_tenant_id_space_id_id_key UNIQUE (tenant_id, space_id, id);

ALTER TABLE ONLY identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY identities
    ADD CONSTRAINT identities_tenant_id_external_id_key UNIQUE (tenant_id, external_id);

ALTER TABLE ONLY identities
    ADD CONSTRAINT identities_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY login_sessions
    ADD CONSTRAINT login_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY login_sessions
    ADD CONSTRAINT login_sessions_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY mcp_oauth_authorization_requests
    ADD CONSTRAINT mcp_oauth_authorization_requests_pkey PRIMARY KEY (request_hash);

ALTER TABLE ONLY mcp_oauth_clients
    ADD CONSTRAINT mcp_oauth_clients_client_id_key UNIQUE (client_id);

ALTER TABLE ONLY mcp_oauth_clients
    ADD CONSTRAINT mcp_oauth_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mcp_oauth_codes
    ADD CONSTRAINT mcp_oauth_codes_pkey PRIMARY KEY (code_hash);

ALTER TABLE ONLY mcp_oauth_grants
    ADD CONSTRAINT mcp_oauth_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mcp_oauth_tokens
    ADD CONSTRAINT mcp_oauth_tokens_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memberships
    ADD CONSTRAINT memberships_tenant_id_user_id_key UNIQUE (tenant_id, user_id);

ALTER TABLE ONLY observability_journey_events
    ADD CONSTRAINT observability_journey_events_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY participant_device_hints
    ADD CONSTRAINT participant_device_hints_pkey PRIMARY KEY (participant_id);

ALTER TABLE ONLY participant_join_seats
    ADD CONSTRAINT participant_join_seats_pkey PRIMARY KEY (participant_id);

ALTER TABLE ONLY participant_media_refreshes
    ADD CONSTRAINT participant_media_refreshes_pkey PRIMARY KEY (tenant_id, space_id, episode_id, participant_id, participant_generation, request_hash);

ALTER TABLE ONLY participant_presence_leases
    ADD CONSTRAINT participant_presence_leases_pkey PRIMARY KEY (tenant_id, space_id, episode_id, participant_id);

ALTER TABLE ONLY participants
    ADD CONSTRAINT participants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY participants
    ADD CONSTRAINT participants_tenant_id_space_id_episode_id_id_generation_key UNIQUE (tenant_id, space_id, episode_id, id, generation);

ALTER TABLE ONLY participants
    ADD CONSTRAINT participants_tenant_id_space_id_episode_id_id_key UNIQUE (tenant_id, space_id, episode_id, id);

ALTER TABLE ONLY password_resets
    ADD CONSTRAINT password_resets_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY password_resets
    ADD CONSTRAINT password_resets_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY provider_operation_observation_heads
    ADD CONSTRAINT provider_operation_observation_heads_pkey PRIMARY KEY (tenant_id, episode_id);

ALTER TABLE ONLY provider_operation_observations
    ADD CONSTRAINT provider_operation_observations_pkey PRIMARY KEY (tenant_id, episode_id, incarnation, sequence);

ALTER TABLE ONLY provider_operation_receipts
    ADD CONSTRAINT provider_operation_receipts_pkey PRIMARY KEY (operation_id, effect);

ALTER TABLE ONLY recording_artifacts
    ADD CONSTRAINT recording_artifacts_pkey PRIMARY KEY (recording_id);

ALTER TABLE ONLY recording_bundle_allocations
    ADD CONSTRAINT recording_bundle_allocations_job_id_attempt_count_reservati_key UNIQUE (job_id, attempt_count, reservation_request_id);

ALTER TABLE ONLY recording_bundle_allocations
    ADD CONSTRAINT recording_bundle_allocations_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY recording_bundle_allocations
    ADD CONSTRAINT recording_bundle_allocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_bundle_allocations
    ADD CONSTRAINT recording_bundle_allocations_recording_id_sequence_number_key UNIQUE (recording_id, sequence_number);

ALTER TABLE ONLY recording_bundle_allocations
    ADD CONSTRAINT recording_bundle_allocations_upload_token_hash_key UNIQUE (upload_token_hash);

ALTER TABLE ONLY recording_bundles
    ADD CONSTRAINT recording_bundles_allocation_id_key UNIQUE (allocation_id);

ALTER TABLE ONLY recording_bundles
    ADD CONSTRAINT recording_bundles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_bundles
    ADD CONSTRAINT recording_bundles_recording_id_sequence_number_key UNIQUE (recording_id, sequence_number);

ALTER TABLE ONLY recording_capacity
    ADD CONSTRAINT recording_capacity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_capture_commands
    ADD CONSTRAINT recording_capture_commands_idempotency_key UNIQUE (signaling_handle, capture_epoch, plan_revision, operation_kind, idempotency_key);

ALTER TABLE ONLY recording_capture_commands
    ADD CONSTRAINT recording_capture_commands_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_capture_commands
    ADD CONSTRAINT recording_capture_commands_sequence_key UNIQUE (signaling_handle, capture_epoch, sequence);

ALTER TABLE ONLY recording_capture_connections
    ADD CONSTRAINT recording_capture_connections_pkey PRIMARY KEY (signaling_handle, capture_epoch);

ALTER TABLE ONLY recording_capture_plans
    ADD CONSTRAINT recording_capture_plans_pkey PRIMARY KEY (plan_handle, revision);

ALTER TABLE ONLY recording_capture_plans
    ADD CONSTRAINT recording_capture_plans_plan_handle_plan_fingerprint_key UNIQUE (plan_handle, plan_fingerprint);

ALTER TABLE ONLY recording_capture_provider_rate_budget
    ADD CONSTRAINT recording_capture_provider_rate_budget_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_capture_publication_failures
    ADD CONSTRAINT recording_capture_publication_failures_pkey PRIMARY KEY (job_id, attempt_count, fencing_generation);

ALTER TABLE ONLY recording_capture_retired_publications
    ADD CONSTRAINT recording_capture_retired_publications_pkey PRIMARY KEY (tenant_id, episode_id, publication_id);

ALTER TABLE ONLY recording_capture_stop_publications
    ADD CONSTRAINT recording_capture_stop_publications_pkey PRIMARY KEY (recording_id);

ALTER TABLE ONLY recording_completion_recoveries
    ADD CONSTRAINT recording_completion_recoveries_pkey PRIMARY KEY (job_id);

ALTER TABLE ONLY recording_completion_recoveries
    ADD CONSTRAINT recording_completion_recoveries_request_id_key UNIQUE (request_id);

ALTER TABLE ONLY recording_data_keys
    ADD CONSTRAINT recording_data_keys_key_handle_key UNIQUE (key_handle);

ALTER TABLE ONLY recording_data_keys
    ADD CONSTRAINT recording_data_keys_pkey PRIMARY KEY (recording_id, capture_epoch);

ALTER TABLE ONLY recording_fleet_nodes
    ADD CONSTRAINT recording_fleet_nodes_environment_provider_key UNIQUE (environment, provider_id);

ALTER TABLE ONLY recording_fleet_nodes
    ADD CONSTRAINT recording_fleet_nodes_pkey PRIMARY KEY (environment, role, provider_id);

ALTER TABLE ONLY recording_fleet_nodes
    ADD CONSTRAINT recording_fleet_nodes_worker_id_key UNIQUE (worker_id);

ALTER TABLE ONLY recording_job_attempt_authorities
    ADD CONSTRAINT recording_job_attempt_authorities_capture_epoch_key UNIQUE (job_id, attempt_count, fencing_generation, capture_epoch);

ALTER TABLE ONLY recording_job_attempt_authorities
    ADD CONSTRAINT recording_job_attempt_authorities_claim_request_id_key UNIQUE (claim_request_id);

ALTER TABLE ONLY recording_job_attempt_authorities
    ADD CONSTRAINT recording_job_attempt_authorities_pkey PRIMARY KEY (job_id, attempt_count, fencing_generation);

ALTER TABLE ONLY recording_job_attempt_failures
    ADD CONSTRAINT recording_job_attempt_failures_pkey PRIMARY KEY (job_id, attempt_count, fencing_generation);

ALTER TABLE ONLY recording_job_failure_history
    ADD CONSTRAINT recording_job_failure_history_pkey PRIMARY KEY (job_id, manual_retry_count);

ALTER TABLE ONLY recording_jobs
    ADD CONSTRAINT recording_jobs_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY recording_jobs
    ADD CONSTRAINT recording_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_pipelines
    ADD CONSTRAINT recording_pipelines_pkey PRIMARY KEY (recording_id);

ALTER TABLE ONLY recording_pipelines
    ADD CONSTRAINT recording_pipelines_reservation_id_key UNIQUE (reservation_id);

ALTER TABLE ONLY recording_pool_health
    ADD CONSTRAINT recording_pool_health_pkey PRIMARY KEY (role);

ALTER TABLE ONLY recording_preparations
    ADD CONSTRAINT recording_preparations_pkey PRIMARY KEY (tenant_id, space_id);

ALTER TABLE ONLY recording_presentation_assets
    ADD CONSTRAINT recording_presentation_assets_pkey PRIMARY KEY (presentation_handle, ordinal);

ALTER TABLE ONLY recording_presentation_assets
    ADD CONSTRAINT recording_presentation_assets_presentation_handle_asset_id_key UNIQUE (presentation_handle, asset_id);

ALTER TABLE ONLY recording_presentation_baselines
    ADD CONSTRAINT recording_presentation_baseli_tenant_id_space_id_episode_id_key UNIQUE (tenant_id, space_id, episode_id, recording_id);

ALTER TABLE ONLY recording_presentation_baselines
    ADD CONSTRAINT recording_presentation_baselines_pkey PRIMARY KEY (presentation_handle);

ALTER TABLE ONLY recording_presentation_baselines
    ADD CONSTRAINT recording_presentation_baselines_recording_id_key UNIQUE (recording_id);

ALTER TABLE ONLY recording_presentation_reactions
    ADD CONSTRAINT recording_presentation_reactions_pkey PRIMARY KEY (reaction_id);

ALTER TABLE ONLY recording_presentation_sources
    ADD CONSTRAINT recording_presentation_source_tenant_id_space_id_episode_id_key UNIQUE (tenant_id, space_id, episode_id, recording_id, presentation_handle);

ALTER TABLE ONLY recording_presentation_sources
    ADD CONSTRAINT recording_presentation_sources_pkey PRIMARY KEY (presentation_handle);

ALTER TABLE ONLY recording_presentation_sources
    ADD CONSTRAINT recording_presentation_sources_recording_id_capture_epoch_key UNIQUE (recording_id, capture_epoch);

ALTER TABLE ONLY recording_presentations
    ADD CONSTRAINT recording_presentations_pkey PRIMARY KEY (presentation_handle);

ALTER TABLE ONLY recording_presentations
    ADD CONSTRAINT recording_presentations_recording_id_key UNIQUE (recording_id);

ALTER TABLE ONLY recording_presentations
    ADD CONSTRAINT recording_presentations_tenant_id_recording_id_presentation_key UNIQUE (tenant_id, recording_id, presentation_handle);

ALTER TABLE ONLY recording_render_commits
    ADD CONSTRAINT recording_render_commits_pkey PRIMARY KEY (render_job_id);

ALTER TABLE ONLY recording_render_commits
    ADD CONSTRAINT recording_render_commits_recording_id_key UNIQUE (recording_id);

ALTER TABLE ONLY recording_render_inputs
    ADD CONSTRAINT recording_render_inputs_object_handle_key UNIQUE (object_handle);

ALTER TABLE ONLY recording_render_inputs
    ADD CONSTRAINT recording_render_inputs_pkey PRIMARY KEY (render_input_handle);

ALTER TABLE ONLY recording_render_inputs
    ADD CONSTRAINT recording_render_inputs_render_job_id_attempt_count_fencing_key UNIQUE (render_job_id, attempt_count, fencing_generation);

ALTER TABLE ONLY recording_render_object_allocations
    ADD CONSTRAINT recording_render_object_alloc_object_handle_reservation_req_key UNIQUE (object_handle, reservation_request_id);

ALTER TABLE ONLY recording_render_object_allocations
    ADD CONSTRAINT recording_render_object_alloc_recording_id_allocation_versi_key UNIQUE (recording_id, allocation_version);

ALTER TABLE ONLY recording_render_object_allocations
    ADD CONSTRAINT recording_render_object_allocations_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY recording_render_object_allocations
    ADD CONSTRAINT recording_render_object_allocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_reservations
    ADD CONSTRAINT recording_reservations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_reservations
    ADD CONSTRAINT recording_reservations_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);

ALTER TABLE ONLY recording_transcription_preparation_commits
    ADD CONSTRAINT recording_transcription_preparation_commits_pkey PRIMARY KEY (transcription_job_id);

ALTER TABLE ONLY recording_transcription_source_chunks
    ADD CONSTRAINT recording_transcription_sourc_recording_id_generation_chunk_key UNIQUE (recording_id, generation, chunk_index);

ALTER TABLE ONLY recording_transcription_source_chunks
    ADD CONSTRAINT recording_transcription_source_chunks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_transcription_sources
    ADD CONSTRAINT recording_transcription_sources_pkey PRIMARY KEY (recording_id);

ALTER TABLE ONLY recordings
    ADD CONSTRAINT recordings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sfu_retirement_debts
    ADD CONSTRAINT sfu_retirement_debts_pkey PRIMARY KEY (tenant_id, episode_id, node, incarnation);

ALTER TABLE ONLY space_create_requests
    ADD CONSTRAINT space_create_requests_pkey PRIMARY KEY (tenant_id, request_key);

ALTER TABLE ONLY space_members
    ADD CONSTRAINT space_members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY space_members
    ADD CONSTRAINT space_members_space_id_identity_id_key UNIQUE (space_id, identity_id);

ALTER TABLE ONLY space_public_admission_requests
    ADD CONSTRAINT space_public_admission_reques_tenant_id_space_id_request_ha_key UNIQUE (tenant_id, space_id, request_handle);

ALTER TABLE ONLY space_public_admission_requests
    ADD CONSTRAINT space_public_admission_requests_arrival_handle_key UNIQUE (arrival_handle);

ALTER TABLE ONLY space_public_admission_requests
    ADD CONSTRAINT space_public_admission_requests_pkey PRIMARY KEY (request_handle);

ALTER TABLE ONLY space_public_arrivals
    ADD CONSTRAINT space_public_arrivals_pkey PRIMARY KEY (arrival_handle);

ALTER TABLE ONLY space_public_arrivals
    ADD CONSTRAINT space_public_arrivals_tenant_id_space_id_arrival_handle_key UNIQUE (tenant_id, space_id, arrival_handle);

ALTER TABLE ONLY space_public_arrivals
    ADD CONSTRAINT space_public_arrivals_tenant_id_space_id_idempotency_key_key UNIQUE (tenant_id, space_id, idempotency_key);

ALTER TABLE ONLY space_public_invites
    ADD CONSTRAINT space_public_invites_handle_key UNIQUE (handle);

ALTER TABLE ONLY space_public_invites
    ADD CONSTRAINT space_public_invites_pkey PRIMARY KEY (tenant_id, space_id);

ALTER TABLE ONLY space_roles
    ADD CONSTRAINT space_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY space_roles
    ADD CONSTRAINT space_roles_tenant_id_space_id_id_key UNIQUE (tenant_id, space_id, id);

ALTER TABLE ONLY space_roles
    ADD CONSTRAINT space_roles_tenant_id_space_id_name_key UNIQUE (tenant_id, space_id, name);

ALTER TABLE ONLY spaces
    ADD CONSTRAINT spaces_pkey PRIMARY KEY (id);

ALTER TABLE ONLY spaces
    ADD CONSTRAINT spaces_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY spaces
    ADD CONSTRAINT spaces_tenant_id_slug_key UNIQUE (tenant_id, slug);

ALTER TABLE ONLY sync_admission_requests
    ADD CONSTRAINT sync_admission_requests_pkey PRIMARY KEY (admission_request_id);

ALTER TABLE ONLY sync_admission_requests
    ADD CONSTRAINT sync_admission_requests_tenant_id_episode_id_participant_id_key UNIQUE (tenant_id, episode_id, participant_id);

ALTER TABLE ONLY sync_admission_requests
    ADD CONSTRAINT sync_admission_requests_tenant_id_episode_id_request_key_key UNIQUE (tenant_id, episode_id, request_key);

ALTER TABLE ONLY sync_admission_requests
    ADD CONSTRAINT sync_admission_requests_tenant_id_space_id_episode_id_admis_key UNIQUE (tenant_id, space_id, episode_id, admission_request_id);

ALTER TABLE ONLY sync_chat_attachments
    ADD CONSTRAINT sync_chat_attachments_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY sync_chat_attachments
    ADD CONSTRAINT sync_chat_attachments_pkey PRIMARY KEY (tenant_id, space_id, attachment_id);

ALTER TABLE ONLY sync_chat_attachments
    ADD CONSTRAINT sync_chat_attachments_tenant_id_space_id_message_sequence_m_key UNIQUE (tenant_id, space_id, message_sequence, message_ordinal);

ALTER TABLE ONLY sync_chat_attachments
    ADD CONSTRAINT sync_chat_attachments_tenant_id_space_id_participant_id_par_key UNIQUE (tenant_id, space_id, participant_id, participant_generation, client_attachment_id);

ALTER TABLE ONLY sync_chat_attachments
    ADD CONSTRAINT sync_chat_attachments_upload_id_key UNIQUE (upload_id);

ALTER TABLE ONLY sync_chat_message_reactions
    ADD CONSTRAINT sync_chat_message_reactions_pkey PRIMARY KEY (tenant_id, space_id, message_id, participant_id, emoji);

ALTER TABLE ONLY sync_chat_messages
    ADD CONSTRAINT sync_chat_messages_pkey PRIMARY KEY (tenant_id, space_id, sequence);

ALTER TABLE ONLY sync_chat_messages
    ADD CONSTRAINT sync_chat_messages_tenant_id_space_id_message_id_key UNIQUE (tenant_id, space_id, message_id);

ALTER TABLE ONLY sync_chat_messages
    ADD CONSTRAINT sync_chat_messages_tenant_id_space_id_participant_id_partic_key UNIQUE (tenant_id, space_id, participant_id, participant_generation, client_message_id);

ALTER TABLE ONLY sync_chat_read_receipts
    ADD CONSTRAINT sync_chat_read_receipts_pkey PRIMARY KEY (tenant_id, space_id, participant_id, participant_generation);

ALTER TABLE ONLY sync_chat_streams
    ADD CONSTRAINT sync_chat_streams_pkey PRIMARY KEY (tenant_id, space_id);

ALTER TABLE ONLY sync_command_receipts
    ADD CONSTRAINT sync_command_receipts_pkey PRIMARY KEY (tenant_id, episode_id, participant_id, command_id);

ALTER TABLE ONLY sync_control_events
    ADD CONSTRAINT sync_control_events_event_id_key UNIQUE (event_id);

ALTER TABLE ONLY sync_control_events
    ADD CONSTRAINT sync_control_events_pkey PRIMARY KEY (tenant_id, episode_id, revision);

ALTER TABLE ONLY sync_control_events
    ADD CONSTRAINT sync_control_events_tenant_id_episode_id_actor_participant__key UNIQUE (tenant_id, episode_id, actor_participant_id, actor_generation, command_id, event_id, revision);

ALTER TABLE ONLY sync_control_events
    ADD CONSTRAINT sync_control_events_tenant_id_episode_id_event_id_revision_key UNIQUE (tenant_id, episode_id, event_id, revision);

ALTER TABLE ONLY sync_control_events
    ADD CONSTRAINT sync_control_events_tenant_id_episode_id_external_operation_key UNIQUE (tenant_id, episode_id, external_operation_id, event_id, revision);

ALTER TABLE ONLY sync_control_events
    ADD CONSTRAINT sync_control_events_tenant_id_episode_id_lifecycle_intent_i_key UNIQUE (tenant_id, episode_id, lifecycle_intent_id, event_id, revision);

ALTER TABLE ONLY sync_entry_rollout
    ADD CONSTRAINT sync_entry_rollout_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY sync_episode_control
    ADD CONSTRAINT sync_episode_control_pkey PRIMARY KEY (tenant_id, episode_id);

ALTER TABLE ONLY sync_episode_control
    ADD CONSTRAINT sync_episode_control_tenant_id_space_id_episode_id_key UNIQUE (tenant_id, space_id, episode_id);

ALTER TABLE ONLY sync_external_operations
    ADD CONSTRAINT sync_external_operations_pkey PRIMARY KEY (external_operation_id);

ALTER TABLE ONLY sync_external_operations
    ADD CONSTRAINT sync_external_operations_tenant_id_episode_id_external_oper_key UNIQUE (tenant_id, episode_id, external_operation_id);

ALTER TABLE ONLY sync_external_operations
    ADD CONSTRAINT sync_external_operations_tenant_id_episode_id_operation_nam_key UNIQUE (tenant_id, episode_id, operation_name, request_key);

ALTER TABLE ONLY sync_external_operations
    ADD CONSTRAINT sync_external_operations_tenant_id_space_id_episode_id_exte_key UNIQUE (tenant_id, space_id, episode_id, external_operation_id);

ALTER TABLE ONLY sync_lifecycle_intents
    ADD CONSTRAINT sync_lifecycle_intents_pkey PRIMARY KEY (lifecycle_intent_id);

ALTER TABLE ONLY sync_lifecycle_intents
    ADD CONSTRAINT sync_lifecycle_intents_tenant_id_episode_id_intent_name_req_key UNIQUE (tenant_id, episode_id, intent_name, request_key);

ALTER TABLE ONLY sync_lifecycle_intents
    ADD CONSTRAINT sync_lifecycle_intents_tenant_id_space_id_episode_id_lifecy_key UNIQUE (tenant_id, space_id, episode_id, lifecycle_intent_id);

ALTER TABLE ONLY sync_media_pauses
    ADD CONSTRAINT sync_media_pauses_pkey PRIMARY KEY (tenant_id, episode_id, participant_id, source);

ALTER TABLE ONLY sync_media_stops
    ADD CONSTRAINT sync_media_stops_pkey PRIMARY KEY (tenant_id, episode_id, participant_id, source);

ALTER TABLE ONLY sync_presence_runtime
    ADD CONSTRAINT sync_presence_runtime_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY sync_publication_fences
    ADD CONSTRAINT sync_publication_fences_pkey PRIMARY KEY (tenant_id, episode_id, participant_id, source);

ALTER TABLE ONLY sync_publication_grant_reservations
    ADD CONSTRAINT sync_publication_grant_reserv_tenant_id_episode_id_operatio_key UNIQUE (tenant_id, episode_id, operation_id);

ALTER TABLE ONLY sync_publication_grant_reservations
    ADD CONSTRAINT sync_publication_grant_reservations_pkey PRIMARY KEY (reservation_id);

ALTER TABLE ONLY sync_recordings
    ADD CONSTRAINT sync_recordings_pkey PRIMARY KEY (recording_id);

ALTER TABLE ONLY sync_recordings
    ADD CONSTRAINT sync_recordings_tenant_id_space_id_episode_id_recording_id_key UNIQUE (tenant_id, space_id, episode_id, recording_id);

ALTER TABLE ONLY sync_screen_share_leases
    ADD CONSTRAINT sync_screen_share_leases_lease_id_key UNIQUE (lease_id);

ALTER TABLE ONLY sync_screen_share_leases
    ADD CONSTRAINT sync_screen_share_leases_pkey PRIMARY KEY (tenant_id, episode_id);

ALTER TABLE ONLY sync_whiteboard_draw_policies
    ADD CONSTRAINT sync_whiteboard_draw_policies_pkey PRIMARY KEY (tenant_id, space_id, episode_id);

ALTER TABLE ONLY sync_whiteboard_draw_policy_receipts
    ADD CONSTRAINT sync_whiteboard_draw_policy_receipts_pkey PRIMARY KEY (tenant_id, space_id, participant_id, operation_id);

ALTER TABLE ONLY sync_whiteboard_elements
    ADD CONSTRAINT sync_whiteboard_elements_pkey PRIMARY KEY (tenant_id, space_id, scene_id, element_id);

ALTER TABLE ONLY sync_whiteboard_files
    ADD CONSTRAINT sync_whiteboard_files_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY sync_whiteboard_files
    ADD CONSTRAINT sync_whiteboard_files_pkey PRIMARY KEY (upload_id);

ALTER TABLE ONLY sync_whiteboard_files
    ADD CONSTRAINT sync_whiteboard_files_tenant_id_space_id_scene_id_file_id_key UNIQUE (tenant_id, space_id, scene_id, file_id);

ALTER TABLE ONLY sync_whiteboard_operation_receipts
    ADD CONSTRAINT sync_whiteboard_operation_receipts_pkey PRIMARY KEY (tenant_id, space_id, participant_id, operation_id);

ALTER TABLE ONLY sync_whiteboard_permissions
    ADD CONSTRAINT sync_whiteboard_permissions_pkey PRIMARY KEY (tenant_id, space_id, participant_id);

ALTER TABLE ONLY sync_whiteboard_scenes
    ADD CONSTRAINT sync_whiteboard_scenes_pkey PRIMARY KEY (tenant_id, space_id, scene_id);

ALTER TABLE ONLY tenant_artifact_policies
    ADD CONSTRAINT tenant_artifact_policies_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY tenant_onboarding_requests
    ADD CONSTRAINT tenant_onboarding_requests_pkey PRIMARY KEY (account_id, request_key);

ALTER TABLE ONLY tenant_onboarding_requests
    ADD CONSTRAINT tenant_onboarding_requests_tenant_access_id_key UNIQUE (tenant_access_id);

ALTER TABLE ONLY tenant_onboarding_requests
    ADD CONSTRAINT tenant_onboarding_requests_tenant_id_key UNIQUE (tenant_id);

ALTER TABLE ONLY tenant_signing_keys
    ADD CONSTRAINT tenant_signing_keys_key_id_key UNIQUE (key_id);

ALTER TABLE ONLY tenant_signing_keys
    ADD CONSTRAINT tenant_signing_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_service_external_id_key UNIQUE (created_by_service_id, external_id);

ALTER TABLE ONLY transcript_chunks
    ADD CONSTRAINT transcript_chunks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY transcript_chunks
    ADD CONSTRAINT transcript_chunks_transcript_id_generation_chunk_index_key UNIQUE (transcript_id, generation, chunk_index);

ALTER TABLE ONLY transcription_attempts
    ADD CONSTRAINT transcription_attempts_chunk_id_generation_attempt_key UNIQUE (chunk_id, generation, attempt);

ALTER TABLE ONLY transcription_attempts
    ADD CONSTRAINT transcription_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY transcription_chunk_results
    ADD CONSTRAINT transcription_chunk_results_attempt_id_key UNIQUE (attempt_id);

ALTER TABLE ONLY transcription_chunk_results
    ADD CONSTRAINT transcription_chunk_results_chunk_id_generation_key UNIQUE (chunk_id, generation);

ALTER TABLE ONLY transcription_chunk_results
    ADD CONSTRAINT transcription_chunk_results_pkey PRIMARY KEY (id);

ALTER TABLE ONLY transcription_cleanup_jobs
    ADD CONSTRAINT transcription_cleanup_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY transcriptions
    ADD CONSTRAINT transcriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY webhook_delivery_attempts
    ADD CONSTRAINT webhook_delivery_attempts_number_key UNIQUE (tenant_id, delivery_id, attempt_number);

ALTER TABLE ONLY webhook_delivery_attempts
    ADD CONSTRAINT webhook_delivery_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_delivery_attempts
    ADD CONSTRAINT webhook_delivery_attempts_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY webhook_endpoint_revisions
    ADD CONSTRAINT webhook_endpoint_revisions_delivery_key UNIQUE (tenant_id, id, endpoint_id, revision);

ALTER TABLE ONLY webhook_endpoint_revisions
    ADD CONSTRAINT webhook_endpoint_revisions_identity_key UNIQUE (tenant_id, endpoint_id, revision);

ALTER TABLE ONLY webhook_endpoint_revisions
    ADD CONSTRAINT webhook_endpoint_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_endpoint_revisions
    ADD CONSTRAINT webhook_endpoint_revisions_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY webhook_events
    ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_events
    ADD CONSTRAINT webhook_events_semantic_transition_key UNIQUE (tenant_id, semantic_transition_key, api_version);

ALTER TABLE ONLY webhook_events
    ADD CONSTRAINT webhook_events_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY webhook_idempotency_records
    ADD CONSTRAINT webhook_idempotency_records_pkey PRIMARY KEY (tenant_id, operation, idempotency_key);

ALTER TABLE ONLY webhook_tenant_state
    ADD CONSTRAINT webhook_tenant_state_pkey PRIMARY KEY (tenant_id);

CREATE INDEX api_key_mutation_requests_resource_idx ON api_key_mutation_requests USING btree (tenant_id, api_key_id) WHERE (api_key_id IS NOT NULL);

CREATE INDEX artifact_jobs_claim_idx ON artifact_jobs USING btree (priority DESC, available_at, created_at, id) WHERE (state = ANY (ARRAY['pending'::text, 'retryable'::text]));

CREATE INDEX artifact_jobs_lease_expiry_idx ON artifact_jobs USING btree (lease_expires_at) WHERE (state = 'leased'::text);

CREATE INDEX artifact_jobs_tenant_created_idx ON artifact_jobs USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX auto_space_lifecycles_due_idx ON auto_space_lifecycles USING btree (deadline_at, next_retry_at, claim_expires_at) WHERE (state <> 'archived'::text);

CREATE UNIQUE INDEX episodes_one_live_per_space_idx ON episodes USING btree (tenant_id, space_id) WHERE (status = ANY (ARRAY['active'::text, 'ending'::text]));

CREATE INDEX episodes_sync_ended_cleanup_idx ON episodes USING btree (ended_at, tenant_id, id) WHERE (status = 'ended'::text);

CREATE INDEX episodes_tenant_space_created_at_id_idx ON episodes USING btree (tenant_id, space_id, created_at DESC, id DESC);

CREATE INDEX identities_tenant_created_at_id_idx ON identities USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX mcp_oauth_codes_grant_idx ON mcp_oauth_codes USING btree (grant_id);

CREATE INDEX mcp_oauth_grants_tenant_idx ON mcp_oauth_grants USING btree (tenant_id, created_at DESC) WHERE (revoked_at IS NULL);

CREATE INDEX mcp_oauth_tokens_expiry_idx ON mcp_oauth_tokens USING btree (expires_at);

CREATE INDEX mcp_oauth_tokens_grant_idx ON mcp_oauth_tokens USING btree (grant_id);

CREATE INDEX memberships_tenant_created_at_id_idx ON memberships USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX memberships_user_id_idx ON memberships USING btree (user_id);

CREATE INDEX observability_journey_events_journey_order_idx ON observability_journey_events USING btree (journey_id, sequence, occurred_at, event_id);

CREATE INDEX observability_journey_events_terminal_idx ON observability_journey_events USING btree (journey_id, sequence DESC, occurred_at DESC, event_id DESC) WHERE ((phase = 'terminal'::text) AND (state = ANY (ARRAY['completed'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'canceled'::text, 'exhausted'::text, 'erased'::text])));

CREATE INDEX participant_presence_leases_expiry_idx ON participant_presence_leases USING btree (expires_at);

CREATE INDEX participants_admission_cleanup_active_idx ON participants USING btree (tenant_id, episode_id, id) WHERE (status = 'active'::text);

CREATE INDEX participants_chat_person_idx ON participants USING btree (tenant_id, space_id, COALESCE(account_id, identity_id, id));

CREATE UNIQUE INDEX participants_dashboard_account_episode_idx ON participants USING btree (tenant_id, episode_id, account_id) WHERE ((account_id IS NOT NULL) AND (status = ANY (ARRAY['joining'::text, 'active'::text])));

CREATE INDEX participants_dashboard_account_space_idx ON participants USING btree (tenant_id, space_id, account_id, created_at DESC) WHERE (account_id IS NOT NULL);

CREATE INDEX participants_episode_recent_join_idx ON participants USING btree (tenant_id, space_id, episode_id, COALESCE(first_joined_at, joined_at) DESC, id) WHERE (COALESCE(first_joined_at, joined_at) IS NOT NULL);

CREATE INDEX participants_sync_active_episode_capacity_idx ON participants USING btree (tenant_id, space_id, episode_id) WHERE (status = ANY (ARRAY['joining'::text, 'active'::text, 'leaving'::text]));

CREATE INDEX password_resets_expires_at_idx ON password_resets USING btree (expires_at);

CREATE INDEX provider_operation_observations_episode_cursor_idx ON provider_operation_observations USING btree (tenant_id, episode_id, incarnation, sequence);

CREATE INDEX provider_operation_receipts_episode_idx ON provider_operation_receipts USING btree (tenant_id, episode_id, created_at DESC, operation_id, effect);

CREATE INDEX provider_operation_receipts_reconciliation_idx ON provider_operation_receipts USING btree (state, created_at, operation_id, effect) WHERE (state = ANY (ARRAY['prepared'::text, 'dispatching'::text]));

CREATE INDEX recording_bundle_allocations_authority_idx ON recording_bundle_allocations USING btree (tenant_id, recording_id, capture_epoch, sequence_number);

CREATE INDEX recording_bundles_recording_sequence_idx ON recording_bundles USING btree (recording_id, sequence_number);

CREATE INDEX recording_capture_commands_ready_idx ON recording_capture_commands USING btree (signaling_handle, capture_epoch, sequence, not_before) WHERE (state = ANY (ARRAY['queued'::text, 'retryable'::text, 'leased'::text]));

CREATE UNIQUE INDEX recording_capture_connections_recording_epoch_idx ON recording_capture_connections USING btree (recording_id, capture_epoch);

CREATE INDEX recording_capture_plans_attempt_idx ON recording_capture_plans USING btree (job_id, attempt_count, fencing_generation, revision DESC);

CREATE INDEX recording_capture_stop_publications_due ON recording_capture_stop_publications USING btree (next_attempt_at, recording_id) WHERE (resolved_at IS NULL);

CREATE INDEX recording_data_keys_authority_idx ON recording_data_keys USING btree (tenant_id, recording_id, capture_epoch);

CREATE INDEX recording_fleet_nodes_role_state_idx ON recording_fleet_nodes USING btree (environment, role, state, provider_id);

CREATE INDEX recording_job_attempt_authorities_job_idx ON recording_job_attempt_authorities USING btree (job_id, issued_at DESC);

CREATE INDEX recording_jobs_active_lease_owner_idx ON recording_jobs USING btree (lease_owner) WHERE (state = 'leased'::text);

CREATE INDEX recording_jobs_claim_idx ON recording_jobs USING btree (kind, state, available_at, priority DESC, id) WHERE (state = 'pending'::text);

CREATE INDEX recording_jobs_dead_letter_idx ON recording_jobs USING btree (tenant_id, terminal_at DESC, id) WHERE (state = 'terminal_failure'::text);

CREATE INDEX recording_jobs_lease_recovery_idx ON recording_jobs USING btree (lease_expires_at, id) WHERE (state = 'leased'::text);

CREATE UNIQUE INDEX recording_jobs_recording_kind_idx ON recording_jobs USING btree (recording_id, kind);

CREATE UNIQUE INDEX recording_pipelines_stop_operation_id_idx ON recording_pipelines USING btree (stop_operation_id) WHERE (stop_operation_id IS NOT NULL);

CREATE INDEX recording_pipelines_tenant_state_idx ON recording_pipelines USING btree (tenant_id, state, updated_at DESC);

CREATE INDEX recording_preparations_due_idx ON recording_preparations USING btree (starts_at, tenant_id, space_id) WHERE (state = 'scheduled'::text);

CREATE INDEX recording_presentation_reactions_timeline_idx ON recording_presentation_reactions USING btree (presentation_handle, occurred_at, reaction_id);

CREATE INDEX recording_render_allocations_authority_idx ON recording_render_object_allocations USING btree (render_job_id, attempt_count, fencing_generation, purpose, state);

CREATE INDEX recording_render_allocations_token_idx ON recording_render_object_allocations USING btree (upload_token_hash) WHERE (upload_token_hash IS NOT NULL);

CREATE INDEX recording_render_inputs_recording_idx ON recording_render_inputs USING btree (tenant_id, recording_id, capture_epoch);

CREATE INDEX recording_reservations_active_idx ON recording_reservations USING btree (state, starts_at, ends_at) WHERE (state = 'reserved'::text);

CREATE UNIQUE INDEX recording_reservations_recording_id_idx ON recording_reservations USING btree (recording_id);

CREATE INDEX recording_reservations_tenant_created_idx ON recording_reservations USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX recording_transcription_source_chunks_recording_idx ON recording_transcription_source_chunks USING btree (recording_id, generation, chunk_index);

CREATE INDEX recording_transcription_sources_cleanup_idx ON recording_transcription_sources USING btree (cleanup_due_at, recording_id) WHERE (status = ANY (ARRAY['cleanup_pending'::text, 'deleting'::text]));

CREATE INDEX recording_transcription_sources_expiry_idx ON recording_transcription_sources USING btree (expires_at, recording_id) WHERE (status = 'ready'::text);

CREATE INDEX recording_transcription_sources_lease_expiry_idx ON recording_transcription_sources USING btree (lease_expires_at, recording_id) WHERE (status = 'leased'::text);

CREATE UNIQUE INDEX recording_transcription_sources_recording_generation_uidx ON recording_transcription_sources USING btree (recording_id, generation);

CREATE INDEX recordings_tenant_created_at_id_idx ON recordings USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX recordings_tenant_episode_created_at_id_idx ON recordings USING btree (tenant_id, episode_id, created_at DESC, id DESC);

CREATE INDEX recordings_tenant_space_created_at_id_idx ON recordings USING btree (tenant_id, space_id, created_at DESC, id DESC);

CREATE INDEX sfu_retirement_debts_due_idx ON sfu_retirement_debts USING btree (next_attempt_at);

CREATE INDEX space_create_requests_space_idx ON space_create_requests USING btree (tenant_id, space_id);

CREATE INDEX space_members_space_created_at_id_idx ON space_members USING btree (space_id, created_at DESC, id DESC);

CREATE INDEX space_public_admission_requests_pending_idx ON space_public_admission_requests USING btree (tenant_id, space_id, requested_at) WHERE (state = 'pending'::text);

CREATE INDEX space_public_arrivals_expiry_idx ON space_public_arrivals USING btree (expires_at, state);

CREATE INDEX space_public_arrivals_space_state_idx ON space_public_arrivals USING btree (tenant_id, space_id, state, created_at);

CREATE INDEX space_public_invites_handle_idx ON space_public_invites USING btree (handle);

CREATE UNIQUE INDEX space_public_invites_invite_code_idx ON space_public_invites USING btree (invite_code);

CREATE UNIQUE INDEX space_public_invites_invite_words_idx ON space_public_invites USING btree (invite_words);

CREATE INDEX space_roles_space_created_at_id_idx ON space_roles USING btree (space_id, created_at DESC, id DESC);

CREATE INDEX spaces_tenant_archived_created_at_id_idx ON spaces USING btree (tenant_id, archived_at, created_at DESC, id DESC);

CREATE INDEX spaces_tenant_created_at_id_idx ON spaces USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX sync_admission_requests_admitted_participant_idx ON sync_admission_requests USING btree (tenant_id, episode_id, participant_id) WHERE (status = 'admitted'::text);

CREATE INDEX sync_admission_requests_pending_idx ON sync_admission_requests USING btree (expires_at, admission_request_id) WHERE (status = 'pending'::text);

CREATE INDEX sync_chat_attachments_cleanup_idx ON sync_chat_attachments USING btree (status, expires_at) WHERE (status <> 'attached'::text);

CREATE INDEX sync_chat_attachments_finalize_lease_idx ON sync_chat_attachments USING btree (finalize_claimed_until) WHERE (status = 'finalizing'::text);

CREATE INDEX sync_chat_attachments_space_status_idx ON sync_chat_attachments USING btree (tenant_id, space_id, status);

CREATE INDEX sync_chat_messages_episode_sequence_idx ON sync_chat_messages USING btree (tenant_id, space_id, episode_id, sequence);

CREATE INDEX sync_chat_messages_participant_usage_idx ON sync_chat_messages USING btree (tenant_id, space_id, participant_id) INCLUDE (created_at, encoded_bytes);

CREATE INDEX sync_chat_messages_space_created_at_idx ON sync_chat_messages USING btree (tenant_id, space_id, created_at, sequence);

CREATE UNIQUE INDEX sync_control_events_command_origin_key ON sync_control_events USING btree (tenant_id, episode_id, actor_participant_id, command_id) WHERE (command_id IS NOT NULL);

CREATE UNIQUE INDEX sync_control_events_lifecycle_origin_key ON sync_control_events USING btree (tenant_id, episode_id, lifecycle_intent_id) WHERE (lifecycle_intent_id IS NOT NULL);

CREATE UNIQUE INDEX sync_external_operations_parent_source_key ON sync_external_operations USING btree (tenant_id, episode_id, parent_external_operation_id, source) WHERE (parent_external_operation_id IS NOT NULL);

CREATE INDEX sync_external_operations_pending_idx ON sync_external_operations USING btree (next_attempt_at, external_operation_id) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX sync_lifecycle_intents_episode_end_key ON sync_lifecycle_intents USING btree (tenant_id, episode_id) WHERE (intent_name = 'episode_ended'::text);

CREATE INDEX sync_lifecycle_intents_episode_pending_idx ON sync_lifecycle_intents USING btree (tenant_id, episode_id) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX sync_lifecycle_intents_participant_transition_key ON sync_lifecycle_intents USING btree (tenant_id, episode_id, intent_name, participant_id, participant_generation) WHERE (intent_name = ANY (ARRAY['participant_joined'::text, 'participant_left'::text]));

CREATE INDEX sync_lifecycle_intents_pending_attempt_idx ON sync_lifecycle_intents USING btree (next_attempt_at, attempt_count, created_at, lifecycle_intent_id) WHERE (status = 'pending'::text);

CREATE INDEX sync_publication_fences_expiry_idx ON sync_publication_fences USING btree (expires_at, external_operation_id);

CREATE UNIQUE INDEX sync_publication_grant_reservations_active_source_key ON sync_publication_grant_reservations USING btree (tenant_id, episode_id, participant_id, source) WHERE (status = ANY (ARRAY['pending'::text, 'ambiguous'::text]));

CREATE INDEX sync_publication_grant_reservations_confirmed_source_idx ON sync_publication_grant_reservations USING btree (tenant_id, episode_id, participant_id, source, control_revision DESC) WHERE ((status = 'confirmed'::text) AND (control_revision IS NOT NULL));

CREATE INDEX sync_publication_grant_reservations_expiry_idx ON sync_publication_grant_reservations USING btree (expires_at, reservation_id);

CREATE UNIQUE INDEX sync_recordings_one_active_per_episode_idx ON sync_recordings USING btree (tenant_id, episode_id) WHERE (status = ANY (ARRAY['starting'::text, 'recording'::text, 'stopping'::text]));

CREATE INDEX sync_screen_share_leases_expiry_idx ON sync_screen_share_leases USING btree (hard_expires_at, lease_id);

CREATE INDEX sync_whiteboard_draw_policy_receipts_episode ON sync_whiteboard_draw_policy_receipts USING btree (tenant_id, space_id, episode_id);

CREATE INDEX sync_whiteboard_elements_snapshot_idx ON sync_whiteboard_elements USING btree (tenant_id, space_id, scene_id, element_index, element_id);

CREATE INDEX sync_whiteboard_files_pending_cleanup_idx ON sync_whiteboard_files USING btree (expires_at, cleanup_claimed_until, tenant_id, space_id) WHERE (status = ANY (ARRAY['pending'::text, 'finalizing'::text, 'failed'::text]));

CREATE INDEX sync_whiteboard_files_space_cleanup_idx ON sync_whiteboard_files USING btree (tenant_id, space_id, cleanup_claimed_until);

CREATE INDEX sync_whiteboard_operation_receipts_retention_idx ON sync_whiteboard_operation_receipts USING btree (tenant_id, space_id, completed_at);

CREATE UNIQUE INDEX sync_whiteboard_scenes_current_idx ON sync_whiteboard_scenes USING btree (tenant_id, space_id, episode_id) WHERE is_current;

CREATE INDEX tenant_onboarding_requests_created_at_idx ON tenant_onboarding_requests USING btree (created_at DESC);

CREATE INDEX tenants_created_at_id_idx ON tenants USING btree (created_at DESC, id DESC);

CREATE INDEX tenants_service_created_at_id_idx ON tenants USING btree (created_by_service_id, created_at DESC, id DESC);

CREATE INDEX transcript_chunks_transcript_idx ON transcript_chunks USING btree (transcript_id, generation, chunk_index);

CREATE INDEX transcription_cleanup_jobs_claim_idx ON transcription_cleanup_jobs USING btree (due_at, created_at, id) WHERE (state = ANY (ARRAY['pending'::text, 'retryable'::text]));

CREATE UNIQUE INDEX transcription_cleanup_jobs_recording_object_uidx ON transcription_cleanup_jobs USING btree (recording_id, object_key);

CREATE UNIQUE INDEX transcriptions_recording_id_uidx ON transcriptions USING btree (recording_id);

CREATE INDEX transcriptions_tenant_created_at_id_idx ON transcriptions USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX transcriptions_tenant_recording_created_at_id_idx ON transcriptions USING btree (tenant_id, recording_id, created_at DESC, id DESC);

CREATE INDEX users_created_at_id_idx ON users USING btree (created_at DESC, id DESC);

CREATE UNIQUE INDEX webhook_deliveries_automatic_fanout_key ON webhook_deliveries USING btree (tenant_id, event_id, endpoint_revision_id) WHERE (parent_delivery_id IS NULL);

CREATE INDEX webhook_deliveries_claim_idx ON webhook_deliveries USING btree (next_attempt_at, created_at, id) WHERE (state = ANY (ARRAY['pending'::text, 'retry_wait'::text]));

CREATE INDEX webhook_deliveries_endpoint_state_idx ON webhook_deliveries USING btree (tenant_id, endpoint_id, state, created_at DESC, id DESC);

CREATE INDEX webhook_deliveries_lease_expiry_idx ON webhook_deliveries USING btree (lease_expires_at, tenant_id, id) WHERE (state = 'delivering'::text);

CREATE INDEX webhook_deliveries_tenant_created_at_id_idx ON webhook_deliveries USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX webhook_delivery_attempts_delivery_idx ON webhook_delivery_attempts USING btree (tenant_id, delivery_id, attempt_number);

CREATE INDEX webhook_endpoints_tenant_created_at_id_idx ON webhook_endpoints USING btree (tenant_id, created_at DESC, id DESC) WHERE (deleted_at IS NULL);

CREATE INDEX webhook_events_linked_user_id_idx ON webhook_events USING btree (linked_user_id, occurred_at, id) WHERE ((linked_user_id IS NOT NULL) AND (erased_at IS NULL));

CREATE INDEX webhook_events_retention_idx ON webhook_events USING btree (occurred_at, tenant_id, id);

CREATE INDEX webhook_events_tenant_occurred_at_id_idx ON webhook_events USING btree (tenant_id, occurred_at DESC, id DESC);

CREATE INDEX webhook_idempotency_records_expiry_idx ON webhook_idempotency_records USING btree (expires_at, tenant_id);

CREATE TRIGGER episodes_immutable_config_snapshot BEFORE UPDATE ON episodes FOR EACH ROW EXECUTE FUNCTION protect_immutable_episode_policy();

CREATE TRIGGER participant_join_seat_departure AFTER UPDATE OF status ON participants FOR EACH ROW EXECUTE FUNCTION complete_participant_join_seat();

CREATE TRIGGER provider_publication_observation_notify AFTER INSERT ON provider_operation_observations FOR EACH ROW EXECUTE FUNCTION notify_provider_publication_observation();

CREATE TRIGGER public_arrival_media_connection AFTER INSERT OR UPDATE OF state, provider_subject, participant_generation, participant_id ON space_public_arrivals FOR EACH ROW EXECUTE FUNCTION bind_public_arrival_media_connection();

CREATE TRIGGER recording_artifacts_immutable BEFORE UPDATE ON recording_artifacts FOR EACH ROW EXECUTE FUNCTION reject_recording_object_mutation();

CREATE TRIGGER recording_bundle_allocations_authority_immutable BEFORE UPDATE ON recording_bundle_allocations FOR EACH ROW EXECUTE FUNCTION protect_recording_bundle_allocation_mutation();

CREATE TRIGGER recording_bundle_allocations_no_delete BEFORE DELETE ON recording_bundle_allocations FOR EACH ROW EXECUTE FUNCTION reject_recording_bundle_allocation_delete();

CREATE TRIGGER recording_bundle_allocations_no_truncate BEFORE TRUNCATE ON recording_bundle_allocations FOR EACH STATEMENT EXECUTE FUNCTION reject_recording_bundle_allocation_delete();

CREATE TRIGGER recording_bundles_immutable BEFORE UPDATE ON recording_bundles FOR EACH ROW EXECUTE FUNCTION reject_recording_object_mutation();

CREATE TRIGGER recording_capture_commands_authority_immutable BEFORE UPDATE ON recording_capture_commands FOR EACH ROW EXECUTE FUNCTION protect_recording_capture_command();

CREATE TRIGGER recording_capture_commands_no_delete BEFORE DELETE ON recording_capture_commands FOR EACH ROW EXECUTE FUNCTION reject_recording_capture_queue_delete();

CREATE TRIGGER recording_capture_commands_no_truncate BEFORE TRUNCATE ON recording_capture_commands FOR EACH STATEMENT EXECUTE FUNCTION reject_recording_capture_queue_delete();

CREATE TRIGGER recording_capture_connections_authority_immutable BEFORE UPDATE ON recording_capture_connections FOR EACH ROW EXECUTE FUNCTION protect_recording_capture_connection_authority();

CREATE TRIGGER recording_capture_connections_no_delete BEFORE DELETE ON recording_capture_connections FOR EACH ROW EXECUTE FUNCTION reject_recording_capture_queue_delete();

CREATE TRIGGER recording_capture_connections_no_truncate BEFORE TRUNCATE ON recording_capture_connections FOR EACH STATEMENT EXECUTE FUNCTION reject_recording_capture_queue_delete();

CREATE TRIGGER recording_capture_plans_immutable BEFORE DELETE OR UPDATE ON recording_capture_plans FOR EACH ROW EXECUTE FUNCTION reject_recording_capture_plan_mutation();

CREATE TRIGGER recording_capture_plans_no_truncate BEFORE TRUNCATE ON recording_capture_plans FOR EACH STATEMENT EXECUTE FUNCTION reject_recording_capture_plan_mutation();

CREATE TRIGGER recording_completion_recoveries_immutable BEFORE DELETE OR UPDATE ON recording_completion_recoveries FOR EACH ROW EXECUTE FUNCTION reject_recording_completion_recovery_mutation();

CREATE TRIGGER recording_completion_recoveries_no_truncate BEFORE TRUNCATE ON recording_completion_recoveries FOR EACH STATEMENT EXECUTE FUNCTION reject_recording_completion_recovery_mutation();

CREATE TRIGGER recording_data_keys_immutable BEFORE DELETE OR UPDATE ON recording_data_keys FOR EACH ROW EXECUTE FUNCTION protect_recording_data_key_mutation();

CREATE TRIGGER recording_data_keys_no_truncate BEFORE TRUNCATE ON recording_data_keys FOR EACH STATEMENT EXECUTE FUNCTION protect_recording_data_key_mutation();

CREATE TRIGGER recording_job_attempt_authorities_immutable BEFORE DELETE OR UPDATE ON recording_job_attempt_authorities FOR EACH ROW EXECUTE FUNCTION reject_recording_job_attempt_authority_mutation();

CREATE TRIGGER recording_job_attempt_authorities_no_truncate BEFORE TRUNCATE ON recording_job_attempt_authorities FOR EACH STATEMENT EXECUTE FUNCTION reject_recording_job_attempt_authority_mutation();

CREATE TRIGGER recording_presentation_assets_immutable BEFORE DELETE OR UPDATE ON recording_presentation_assets FOR EACH ROW EXECUTE FUNCTION reject_recording_presentation_mutation();

CREATE TRIGGER recording_presentation_baselines_immutable BEFORE DELETE OR UPDATE ON recording_presentation_baselines FOR EACH ROW EXECUTE FUNCTION reject_recording_presentation_mutation();

CREATE TRIGGER recording_presentation_reactions_immutable BEFORE DELETE OR UPDATE ON recording_presentation_reactions FOR EACH ROW EXECUTE FUNCTION reject_recording_presentation_mutation();

CREATE TRIGGER recording_presentation_sources_immutable BEFORE DELETE OR UPDATE ON recording_presentation_sources FOR EACH ROW EXECUTE FUNCTION reject_recording_presentation_mutation();

CREATE TRIGGER recording_presentations_immutable BEFORE DELETE OR UPDATE ON recording_presentations FOR EACH ROW EXECUTE FUNCTION reject_recording_presentation_mutation();

CREATE TRIGGER recording_render_allocations_authority_immutable BEFORE UPDATE ON recording_render_object_allocations FOR EACH ROW EXECUTE FUNCTION protect_recording_render_allocation_mutation();

CREATE TRIGGER recording_render_allocations_no_delete BEFORE DELETE ON recording_render_object_allocations FOR EACH ROW EXECUTE FUNCTION reject_recording_render_authority_mutation();

CREATE TRIGGER recording_render_allocations_no_truncate BEFORE TRUNCATE ON recording_render_object_allocations FOR EACH STATEMENT EXECUTE FUNCTION reject_recording_render_authority_mutation();

CREATE TRIGGER recording_render_commits_immutable BEFORE DELETE OR UPDATE ON recording_render_commits FOR EACH ROW EXECUTE FUNCTION reject_recording_render_authority_mutation();

CREATE TRIGGER recording_render_commits_no_truncate BEFORE TRUNCATE ON recording_render_commits FOR EACH STATEMENT EXECUTE FUNCTION reject_recording_render_authority_mutation();

CREATE TRIGGER recording_render_inputs_immutable BEFORE DELETE OR UPDATE ON recording_render_inputs FOR EACH ROW EXECUTE FUNCTION reject_recording_render_authority_mutation();

CREATE TRIGGER recording_render_inputs_no_truncate BEFORE TRUNCATE ON recording_render_inputs FOR EACH STATEMENT EXECUTE FUNCTION reject_recording_render_authority_mutation();

CREATE TRIGGER recording_terminal_capture_source_cleanup AFTER UPDATE OF state ON recording_jobs FOR EACH ROW WHEN (((new.kind = 'capture'::text) AND (new.state = 'terminal_failure'::text) AND (old.state IS DISTINCT FROM new.state))) EXECUTE FUNCTION recording_terminal_capture_source_cleanup_trigger();

CREATE TRIGGER space_public_admission_requests_canonical_decision BEFORE UPDATE OF state ON space_public_admission_requests FOR EACH ROW WHEN ((old.state IS DISTINCT FROM new.state)) EXECUTE FUNCTION guard_canonical_public_admission_decision();

CREATE CONSTRAINT TRIGGER sync_command_receipts_event_origin AFTER INSERT OR UPDATE ON sync_command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_validate_receipt_event_origin();

CREATE TRIGGER sync_entry_event_writer BEFORE INSERT ON sync_control_events FOR EACH ROW EXECUTE FUNCTION require_sync_entry_writer();

CREATE TRIGGER sync_entry_leave_writer BEFORE INSERT OR UPDATE ON sync_external_operations FOR EACH ROW WHEN ((new.operation_name = 'participant_leave'::text)) EXECUTE FUNCTION require_sync_entry_writer();

CREATE TRIGGER sync_entry_participant_writer BEFORE UPDATE OF status ON participants FOR EACH ROW WHEN (((new.status IS DISTINCT FROM old.status) AND ((new.status = 'active'::text) OR ((new.status = 'left'::text) AND (old.first_joined_at IS NOT NULL))))) EXECUTE FUNCTION require_sync_entry_writer();

CREATE TRIGGER tenants_guard_media_plane_approval BEFORE INSERT OR UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION guard_tenant_media_plane_approval();

ALTER TABLE ONLY api_key_mutation_requests
    ADD CONSTRAINT api_key_mutation_requests_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES api_keys(id);

ALTER TABLE ONLY api_key_mutation_requests
    ADD CONSTRAINT api_key_mutation_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_created_by_user_id_fkey1 FOREIGN KEY (created_by_user_id) REFERENCES users(id);

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY artifact_jobs
    ADD CONSTRAINT artifact_jobs_chunk_fkey FOREIGN KEY (chunk_id) REFERENCES transcript_chunks(id) ON DELETE RESTRICT;

ALTER TABLE ONLY artifact_jobs
    ADD CONSTRAINT artifact_jobs_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id);

ALTER TABLE ONLY artifact_jobs
    ADD CONSTRAINT artifact_jobs_recording_id_fkey1 FOREIGN KEY (recording_id) REFERENCES recordings(id);

ALTER TABLE ONLY artifact_jobs
    ADD CONSTRAINT artifact_jobs_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY artifact_jobs
    ADD CONSTRAINT artifact_jobs_transcript_id_fkey1 FOREIGN KEY (transcript_id) REFERENCES transcriptions(id);

ALTER TABLE ONLY auth_identities
    ADD CONSTRAINT auth_identities_user_id_fkey1 FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY auto_space_lifecycles
    ADD CONSTRAINT auto_space_lifecycles_tenant_id_space_id_creator_arrival_h_fkey FOREIGN KEY (tenant_id, space_id, creator_arrival_handle) REFERENCES space_public_arrivals(tenant_id, space_id, arrival_handle) ON DELETE RESTRICT;

ALTER TABLE ONLY auto_space_lifecycles
    ADD CONSTRAINT auto_space_lifecycles_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY episode_create_requests
    ADD CONSTRAINT episode_create_requests_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES episodes(tenant_id, space_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY episode_presence_leases
    ADD CONSTRAINT episode_presence_leases_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES episodes(tenant_id, space_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY episodes
    ADD CONSTRAINT episodes_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES users(id);

ALTER TABLE ONLY episodes
    ADD CONSTRAINT episodes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY episodes
    ADD CONSTRAINT episodes_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY identities
    ADD CONSTRAINT identities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY login_sessions
    ADD CONSTRAINT login_sessions_user_id_fkey1 FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY mcp_oauth_authorization_requests
    ADD CONSTRAINT mcp_oauth_authorization_requests_client_id_fkey FOREIGN KEY (client_id) REFERENCES mcp_oauth_clients(id);

ALTER TABLE ONLY mcp_oauth_codes
    ADD CONSTRAINT mcp_oauth_codes_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_grants
    ADD CONSTRAINT mcp_oauth_grants_client_id_fkey FOREIGN KEY (client_id) REFERENCES mcp_oauth_clients(id);

ALTER TABLE ONLY mcp_oauth_grants
    ADD CONSTRAINT mcp_oauth_grants_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY mcp_oauth_tokens
    ADD CONSTRAINT mcp_oauth_tokens_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE;

ALTER TABLE ONLY memberships
    ADD CONSTRAINT memberships_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY memberships
    ADD CONSTRAINT memberships_user_id_fkey1 FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY participant_device_hints
    ADD CONSTRAINT participant_device_hints_tenant_id_space_id_episode_id_par_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id) REFERENCES participants(tenant_id, space_id, episode_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY participant_join_seats
    ADD CONSTRAINT participant_join_seats_tenant_id_space_id_episode_id_parti_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id) REFERENCES participants(tenant_id, space_id, episode_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY participant_media_refreshes
    ADD CONSTRAINT participant_media_refreshes_tenant_id_space_id_episode_id__fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id) REFERENCES participants(tenant_id, space_id, episode_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY participant_presence_leases
    ADD CONSTRAINT participant_presence_leases_tenant_id_space_id_episode_id__fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id) REFERENCES participants(tenant_id, space_id, episode_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY participants
    ADD CONSTRAINT participants_account_id_fkey FOREIGN KEY (account_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY participants
    ADD CONSTRAINT participants_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY participants
    ADD CONSTRAINT participants_tenant_id_identity_id_fkey FOREIGN KEY (tenant_id, identity_id) REFERENCES identities(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY participants
    ADD CONSTRAINT participants_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES episodes(tenant_id, space_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY password_resets
    ADD CONSTRAINT password_resets_account_id_fkey FOREIGN KEY (account_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY provider_operation_observation_heads
    ADD CONSTRAINT provider_operation_observation_heads_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY provider_operation_observation_heads
    ADD CONSTRAINT provider_operation_observation_heads_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY provider_operation_observations
    ADD CONSTRAINT provider_operation_observations_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY provider_operation_observations
    ADD CONSTRAINT provider_operation_observations_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY provider_operation_receipts
    ADD CONSTRAINT provider_operation_receipts_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY provider_operation_receipts
    ADD CONSTRAINT provider_operation_receipts_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_artifacts
    ADD CONSTRAINT recording_artifacts_recording_id_fkey1 FOREIGN KEY (recording_id) REFERENCES recordings(id);

ALTER TABLE ONLY recording_artifacts
    ADD CONSTRAINT recording_artifacts_render_job_id_fkey1 FOREIGN KEY (render_job_id) REFERENCES recording_jobs(id);

ALTER TABLE ONLY recording_artifacts
    ADD CONSTRAINT recording_artifacts_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY recording_bundle_allocations
    ADD CONSTRAINT recording_bundle_allocations_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_bundle_allocations
    ADD CONSTRAINT recording_bundle_allocations_job_id_fkey FOREIGN KEY (job_id) REFERENCES recording_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_bundle_allocations
    ADD CONSTRAINT recording_bundle_allocations_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_bundle_allocations
    ADD CONSTRAINT recording_bundle_allocations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_bundles
    ADD CONSTRAINT recording_bundles_allocation_id_fkey FOREIGN KEY (allocation_id) REFERENCES recording_bundle_allocations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_bundles
    ADD CONSTRAINT recording_bundles_capture_job_id_fkey1 FOREIGN KEY (capture_job_id) REFERENCES recording_jobs(id);

ALTER TABLE ONLY recording_bundles
    ADD CONSTRAINT recording_bundles_recording_id_fkey1 FOREIGN KEY (recording_id) REFERENCES recordings(id);

ALTER TABLE ONLY recording_bundles
    ADD CONSTRAINT recording_bundles_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY recording_capture_commands
    ADD CONSTRAINT recording_capture_commands_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_commands
    ADD CONSTRAINT recording_capture_commands_signaling_handle_capture_epoch_fkey FOREIGN KEY (signaling_handle, capture_epoch) REFERENCES recording_capture_connections(signaling_handle, capture_epoch) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_connections
    ADD CONSTRAINT recording_capture_connections_active_command_fkey FOREIGN KEY (active_command_id) REFERENCES recording_capture_commands(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_connections
    ADD CONSTRAINT recording_capture_connections_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_connections
    ADD CONSTRAINT recording_capture_connections_job_id_attempt_count_fencing_fkey FOREIGN KEY (job_id, attempt_count, fencing_generation, capture_epoch) REFERENCES recording_job_attempt_authorities(job_id, attempt_count, fencing_generation, capture_epoch) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_connections
    ADD CONSTRAINT recording_capture_connections_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_connections
    ADD CONSTRAINT recording_capture_connections_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_connections
    ADD CONSTRAINT recording_capture_connections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_plans
    ADD CONSTRAINT recording_capture_plans_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_plans
    ADD CONSTRAINT recording_capture_plans_job_id_attempt_count_fencing_gener_fkey FOREIGN KEY (job_id, attempt_count, fencing_generation) REFERENCES recording_job_attempt_authorities(job_id, attempt_count, fencing_generation) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_plans
    ADD CONSTRAINT recording_capture_plans_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_plans
    ADD CONSTRAINT recording_capture_plans_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_plans
    ADD CONSTRAINT recording_capture_plans_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_publication_failures
    ADD CONSTRAINT recording_capture_publication_job_id_attempt_count_fencing_fkey FOREIGN KEY (job_id, attempt_count, fencing_generation) REFERENCES recording_job_attempt_authorities(job_id, attempt_count, fencing_generation);

ALTER TABLE ONLY recording_capture_retired_publications
    ADD CONSTRAINT recording_capture_retired_publications_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_retired_publications
    ADD CONSTRAINT recording_capture_retired_publications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_capture_stop_publications
    ADD CONSTRAINT recording_capture_stop_publications_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recording_pipelines(recording_id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_completion_recoveries
    ADD CONSTRAINT recording_completion_recoveries_job_id_fkey FOREIGN KEY (job_id) REFERENCES recording_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_data_keys
    ADD CONSTRAINT recording_data_keys_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_data_keys
    ADD CONSTRAINT recording_data_keys_job_id_fkey FOREIGN KEY (job_id) REFERENCES recording_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_data_keys
    ADD CONSTRAINT recording_data_keys_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_data_keys
    ADD CONSTRAINT recording_data_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_job_attempt_authorities
    ADD CONSTRAINT recording_job_attempt_authorities_job_id_fkey FOREIGN KEY (job_id) REFERENCES recording_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_job_attempt_failures
    ADD CONSTRAINT recording_job_attempt_failures_job_id_fkey FOREIGN KEY (job_id) REFERENCES recording_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_job_failure_history
    ADD CONSTRAINT recording_job_failure_history_job_id_fkey FOREIGN KEY (job_id) REFERENCES recording_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_jobs
    ADD CONSTRAINT recording_jobs_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id);

ALTER TABLE ONLY recording_jobs
    ADD CONSTRAINT recording_jobs_recording_id_fkey1 FOREIGN KEY (recording_id) REFERENCES recordings(id);

ALTER TABLE ONLY recording_jobs
    ADD CONSTRAINT recording_jobs_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY recording_pipelines
    ADD CONSTRAINT recording_pipelines_recording_id_fkey1 FOREIGN KEY (recording_id) REFERENCES recordings(id);

ALTER TABLE ONLY recording_pipelines
    ADD CONSTRAINT recording_pipelines_reservation_id_fkey1 FOREIGN KEY (reservation_id) REFERENCES recording_reservations(id);

ALTER TABLE ONLY recording_pipelines
    ADD CONSTRAINT recording_pipelines_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY recording_preparations
    ADD CONSTRAINT recording_preparations_consumed_recording_id_fkey FOREIGN KEY (consumed_recording_id) REFERENCES recordings(id);

ALTER TABLE ONLY recording_preparations
    ADD CONSTRAINT recording_preparations_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_presentation_assets
    ADD CONSTRAINT recording_presentation_assets_tenant_id_recording_id_prese_fkey FOREIGN KEY (tenant_id, recording_id, presentation_handle) REFERENCES recording_presentations(tenant_id, recording_id, presentation_handle) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_presentation_baselines
    ADD CONSTRAINT recording_presentation_baselines_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_presentation_baselines
    ADD CONSTRAINT recording_presentation_baselines_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_presentation_baselines
    ADD CONSTRAINT recording_presentation_baselines_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_presentation_baselines
    ADD CONSTRAINT recording_presentation_baselines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_presentation_reactions
    ADD CONSTRAINT recording_presentation_react_tenant_id_space_id_episode_i_fkey1 FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_presentation_reactions
    ADD CONSTRAINT recording_presentation_reacti_tenant_id_space_id_episode_i_fkey FOREIGN KEY (tenant_id, space_id, episode_id, recording_id, presentation_handle) REFERENCES recording_presentation_sources(tenant_id, space_id, episode_id, recording_id, presentation_handle) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_presentation_sources
    ADD CONSTRAINT recording_presentation_source_tenant_id_space_id_episode_i_fkey FOREIGN KEY (tenant_id, space_id, episode_id, recording_id) REFERENCES recording_presentation_baselines(tenant_id, space_id, episode_id, recording_id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_presentation_sources
    ADD CONSTRAINT recording_presentation_sources_presentation_handle_fkey FOREIGN KEY (presentation_handle) REFERENCES recording_presentation_baselines(presentation_handle) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_presentations
    ADD CONSTRAINT recording_presentations_presentation_handle_fkey FOREIGN KEY (presentation_handle) REFERENCES recording_presentation_sources(presentation_handle) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_presentations
    ADD CONSTRAINT recording_presentations_tenant_id_space_id_episode_id_reco_fkey FOREIGN KEY (tenant_id, space_id, episode_id, recording_id, presentation_handle) REFERENCES recording_presentation_sources(tenant_id, space_id, episode_id, recording_id, presentation_handle) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_commits
    ADD CONSTRAINT recording_render_commits_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_commits
    ADD CONSTRAINT recording_render_commits_render_input_handle_fkey FOREIGN KEY (render_input_handle) REFERENCES recording_render_inputs(render_input_handle) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_commits
    ADD CONSTRAINT recording_render_commits_render_job_id_fkey FOREIGN KEY (render_job_id) REFERENCES recording_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_commits
    ADD CONSTRAINT recording_render_commits_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_commits
    ADD CONSTRAINT recording_render_commits_transcription_source_id_fkey FOREIGN KEY (transcription_source_id) REFERENCES recording_transcription_sources(recording_id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_commits
    ADD CONSTRAINT recording_render_commits_video_allocation_id_fkey FOREIGN KEY (video_allocation_id) REFERENCES recording_render_object_allocations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_inputs
    ADD CONSTRAINT recording_render_inputs_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_inputs
    ADD CONSTRAINT recording_render_inputs_presentation_handle_fkey FOREIGN KEY (presentation_handle) REFERENCES recording_presentations(presentation_handle) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_inputs
    ADD CONSTRAINT recording_render_inputs_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_inputs
    ADD CONSTRAINT recording_render_inputs_render_job_id_attempt_count_fencin_fkey FOREIGN KEY (render_job_id, attempt_count, fencing_generation) REFERENCES recording_job_attempt_authorities(job_id, attempt_count, fencing_generation) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_inputs
    ADD CONSTRAINT recording_render_inputs_render_job_id_fkey FOREIGN KEY (render_job_id) REFERENCES recording_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_inputs
    ADD CONSTRAINT recording_render_inputs_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_inputs
    ADD CONSTRAINT recording_render_inputs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_object_allocations
    ADD CONSTRAINT recording_render_object_allocations_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_object_allocations
    ADD CONSTRAINT recording_render_object_allocations_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_object_allocations
    ADD CONSTRAINT recording_render_object_allocations_render_input_handle_fkey FOREIGN KEY (render_input_handle) REFERENCES recording_render_inputs(render_input_handle) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_object_allocations
    ADD CONSTRAINT recording_render_object_allocations_render_job_id_fkey FOREIGN KEY (render_job_id) REFERENCES recording_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_render_object_allocations
    ADD CONSTRAINT recording_render_object_allocations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_reservations
    ADD CONSTRAINT recording_reservations_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id);

ALTER TABLE ONLY recording_reservations
    ADD CONSTRAINT recording_reservations_recording_id_fkey1 FOREIGN KEY (recording_id) REFERENCES recordings(id);

ALTER TABLE ONLY recording_reservations
    ADD CONSTRAINT recording_reservations_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id);

ALTER TABLE ONLY recording_reservations
    ADD CONSTRAINT recording_reservations_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY recording_transcription_preparation_commits
    ADD CONSTRAINT recording_transcription_preparatio_transcription_source_id_fkey FOREIGN KEY (transcription_source_id) REFERENCES recording_transcription_sources(recording_id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_transcription_preparation_commits
    ADD CONSTRAINT recording_transcription_preparation_c_transcription_job_id_fkey FOREIGN KEY (transcription_job_id) REFERENCES recording_jobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_transcription_preparation_commits
    ADD CONSTRAINT recording_transcription_preparation_co_render_input_handle_fkey FOREIGN KEY (render_input_handle) REFERENCES recording_render_inputs(render_input_handle) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_transcription_preparation_commits
    ADD CONSTRAINT recording_transcription_preparation_commits_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_transcription_preparation_commits
    ADD CONSTRAINT recording_transcription_preparation_commits_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_transcription_source_chunks
    ADD CONSTRAINT recording_transcription_source_chunks_allocation_id_fkey FOREIGN KEY (allocation_id) REFERENCES recording_render_object_allocations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_transcription_source_chunks
    ADD CONSTRAINT recording_transcription_source_chunks_recording_id_fkey1 FOREIGN KEY (recording_id) REFERENCES recording_transcription_sources(recording_id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_transcription_source_chunks
    ADD CONSTRAINT recording_transcription_source_chunks_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY recording_transcription_sources
    ADD CONSTRAINT recording_transcription_sources_lease_transcript_id_fkey FOREIGN KEY (lease_transcript_id) REFERENCES transcriptions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_transcription_sources
    ADD CONSTRAINT recording_transcription_sources_manifest_allocation_id_fkey FOREIGN KEY (manifest_allocation_id) REFERENCES recording_render_object_allocations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_transcription_sources
    ADD CONSTRAINT recording_transcription_sources_recording_id_fkey1 FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY recording_transcription_sources
    ADD CONSTRAINT recording_transcription_sources_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY recordings
    ADD CONSTRAINT recordings_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id);

ALTER TABLE ONLY recordings
    ADD CONSTRAINT recordings_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id);

ALTER TABLE ONLY recordings
    ADD CONSTRAINT recordings_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY space_create_requests
    ADD CONSTRAINT space_create_requests_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY space_members
    ADD CONSTRAINT space_members_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY space_members
    ADD CONSTRAINT space_members_tenant_id_identity_id_fkey FOREIGN KEY (tenant_id, identity_id) REFERENCES identities(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY space_members
    ADD CONSTRAINT space_members_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY space_members
    ADD CONSTRAINT space_members_tenant_id_space_id_role_id_fkey FOREIGN KEY (tenant_id, space_id, role_id) REFERENCES space_roles(tenant_id, space_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY space_public_admission_requests
    ADD CONSTRAINT space_public_admission_reques_tenant_id_space_id_arrival_h_fkey FOREIGN KEY (tenant_id, space_id, arrival_handle) REFERENCES space_public_arrivals(tenant_id, space_id, arrival_handle) ON DELETE CASCADE;

ALTER TABLE ONLY space_public_admission_requests
    ADD CONSTRAINT space_public_admission_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES users(id);

ALTER TABLE ONLY space_public_admission_requests
    ADD CONSTRAINT space_public_admission_requests_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY space_public_arrivals
    ADD CONSTRAINT space_public_arrivals_account_id_fkey FOREIGN KEY (account_id) REFERENCES users(id);

ALTER TABLE ONLY space_public_arrivals
    ADD CONSTRAINT space_public_arrivals_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES episodes(tenant_id, space_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY space_public_arrivals
    ADD CONSTRAINT space_public_arrivals_tenant_id_space_id_episode_id_partic_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY space_public_arrivals
    ADD CONSTRAINT space_public_arrivals_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY space_public_arrivals
    ADD CONSTRAINT space_public_arrivals_tenant_id_space_id_fkey1 FOREIGN KEY (tenant_id, space_id) REFERENCES space_public_invites(tenant_id, space_id) ON DELETE CASCADE;

ALTER TABLE ONLY space_public_invites
    ADD CONSTRAINT space_public_invites_last_actor_id_fkey FOREIGN KEY (last_actor_id) REFERENCES users(id);

ALTER TABLE ONLY space_public_invites
    ADD CONSTRAINT space_public_invites_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY space_roles
    ADD CONSTRAINT space_roles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY space_roles
    ADD CONSTRAINT space_roles_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY spaces
    ADD CONSTRAINT spaces_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES users(id);

ALTER TABLE ONLY spaces
    ADD CONSTRAINT spaces_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY sync_admission_requests
    ADD CONSTRAINT sync_admission_requests_tenant_id_episode_id_decision_exte_fkey FOREIGN KEY (tenant_id, episode_id, decision_external_operation_id) REFERENCES sync_external_operations(tenant_id, episode_id, external_operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_admission_requests
    ADD CONSTRAINT sync_admission_requests_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES sync_episode_control(tenant_id, space_id, episode_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_chat_attachments
    ADD CONSTRAINT sync_chat_attachments_tenant_id_space_id_episode_id_partic_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_chat_attachments
    ADD CONSTRAINT sync_chat_attachments_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES sync_chat_streams(tenant_id, space_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_chat_attachments
    ADD CONSTRAINT sync_chat_attachments_tenant_id_space_id_message_sequence_fkey FOREIGN KEY (tenant_id, space_id, message_sequence) REFERENCES sync_chat_messages(tenant_id, space_id, sequence) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_chat_message_reactions
    ADD CONSTRAINT sync_chat_message_reactions_tenant_id_space_id_message_id_fkey FOREIGN KEY (tenant_id, space_id, message_id) REFERENCES sync_chat_messages(tenant_id, space_id, message_id) ON DELETE CASCADE;

ALTER TABLE ONLY sync_chat_messages
    ADD CONSTRAINT sync_chat_messages_tenant_id_space_id_episode_id_participa_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_chat_messages
    ADD CONSTRAINT sync_chat_messages_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES sync_chat_streams(tenant_id, space_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_chat_read_receipts
    ADD CONSTRAINT sync_chat_read_receipts_tenant_id_space_id_episode_id_part_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_chat_read_receipts
    ADD CONSTRAINT sync_chat_read_receipts_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES sync_chat_streams(tenant_id, space_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_chat_streams
    ADD CONSTRAINT sync_chat_streams_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_command_receipts
    ADD CONSTRAINT sync_command_receipts_sync_event_fkey FOREIGN KEY (tenant_id, episode_id, event_id, resulting_revision) REFERENCES sync_control_events(tenant_id, episode_id, event_id, revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY sync_command_receipts
    ADD CONSTRAINT sync_command_receipts_tenant_id_episode_id_external_operat_fkey FOREIGN KEY (tenant_id, episode_id, external_operation_id) REFERENCES sync_external_operations(tenant_id, episode_id, external_operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_command_receipts
    ADD CONSTRAINT sync_command_receipts_tenant_id_episode_id_fkey FOREIGN KEY (tenant_id, episode_id) REFERENCES sync_episode_control(tenant_id, episode_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_control_events
    ADD CONSTRAINT sync_control_events_tenant_id_episode_id_external_operatio_fkey FOREIGN KEY (tenant_id, episode_id, external_operation_id) REFERENCES sync_external_operations(tenant_id, episode_id, external_operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_control_events
    ADD CONSTRAINT sync_control_events_tenant_id_space_id_episode_id_actor_p_fkey1 FOREIGN KEY (tenant_id, space_id, episode_id, actor_participant_id, actor_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_control_events
    ADD CONSTRAINT sync_control_events_tenant_id_space_id_episode_id_actor_pa_fkey FOREIGN KEY (tenant_id, space_id, episode_id, actor_participant_id) REFERENCES participants(tenant_id, space_id, episode_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_control_events
    ADD CONSTRAINT sync_control_events_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES sync_episode_control(tenant_id, space_id, episode_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_episode_control
    ADD CONSTRAINT sync_episode_control_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES episodes(tenant_id, space_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_external_operations
    ADD CONSTRAINT sync_external_operations_tenant_id_episode_id_external_ope_fkey FOREIGN KEY (tenant_id, episode_id, external_operation_id, applied_event_id, applied_revision) REFERENCES sync_control_events(tenant_id, episode_id, external_operation_id, event_id, revision) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_external_operations
    ADD CONSTRAINT sync_external_operations_tenant_id_episode_id_parent_exter_fkey FOREIGN KEY (tenant_id, episode_id, parent_external_operation_id) REFERENCES sync_external_operations(tenant_id, episode_id, external_operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_external_operations
    ADD CONSTRAINT sync_external_operations_tenant_id_space_id_episode_id_act_fkey FOREIGN KEY (tenant_id, space_id, episode_id, actor_participant_id, actor_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_external_operations
    ADD CONSTRAINT sync_external_operations_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES sync_episode_control(tenant_id, space_id, episode_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_external_operations
    ADD CONSTRAINT sync_external_operations_tenant_id_space_id_episode_id_tar_fkey FOREIGN KEY (tenant_id, space_id, episode_id, target_participant_id, target_participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_lifecycle_intents
    ADD CONSTRAINT sync_lifecycle_intents_tenant_id_episode_id_lifecycle_inte_fkey FOREIGN KEY (tenant_id, episode_id, lifecycle_intent_id, applied_event_id, applied_revision) REFERENCES sync_control_events(tenant_id, episode_id, lifecycle_intent_id, event_id, revision) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_lifecycle_intents
    ADD CONSTRAINT sync_lifecycle_intents_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES sync_episode_control(tenant_id, space_id, episode_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_lifecycle_intents
    ADD CONSTRAINT sync_lifecycle_intents_tenant_id_space_id_episode_id_part_fkey1 FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY sync_lifecycle_intents
    ADD CONSTRAINT sync_lifecycle_intents_tenant_id_space_id_episode_id_parti_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id) REFERENCES participants(tenant_id, space_id, episode_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_media_pauses
    ADD CONSTRAINT sync_media_pauses_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES sync_episode_control(tenant_id, space_id, episode_id) ON DELETE CASCADE;

ALTER TABLE ONLY sync_media_pauses
    ADD CONSTRAINT sync_media_pauses_tenant_id_space_id_episode_id_participan_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE CASCADE;

ALTER TABLE ONLY sync_media_stops
    ADD CONSTRAINT sync_media_stops_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES sync_episode_control(tenant_id, space_id, episode_id) ON DELETE CASCADE;

ALTER TABLE ONLY sync_media_stops
    ADD CONSTRAINT sync_media_stops_tenant_id_space_id_episode_id_participant_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE CASCADE;

ALTER TABLE ONLY sync_publication_fences
    ADD CONSTRAINT sync_publication_fences_tenant_id_episode_id_external_oper_fkey FOREIGN KEY (tenant_id, episode_id, external_operation_id) REFERENCES sync_external_operations(tenant_id, episode_id, external_operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_publication_fences
    ADD CONSTRAINT sync_publication_fences_tenant_id_space_id_episode_id_part_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_publication_grant_reservations
    ADD CONSTRAINT sync_publication_grant_reser_tenant_id_space_id_episode_i_fkey1 FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_publication_grant_reservations
    ADD CONSTRAINT sync_publication_grant_reserv_tenant_id_space_id_episode_i_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES sync_episode_control(tenant_id, space_id, episode_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_recordings
    ADD CONSTRAINT sync_recordings_tenant_id_episode_id_start_external_operat_fkey FOREIGN KEY (tenant_id, episode_id, start_external_operation_id) REFERENCES sync_external_operations(tenant_id, episode_id, external_operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_recordings
    ADD CONSTRAINT sync_recordings_tenant_id_episode_id_stop_external_operati_fkey FOREIGN KEY (tenant_id, episode_id, stop_external_operation_id) REFERENCES sync_external_operations(tenant_id, episode_id, external_operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_recordings
    ADD CONSTRAINT sync_recordings_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES sync_episode_control(tenant_id, space_id, episode_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_recordings
    ADD CONSTRAINT sync_recordings_tenant_id_space_id_episode_id_started_by_p_fkey FOREIGN KEY (tenant_id, space_id, episode_id, started_by_participant_id, started_by_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_screen_share_leases
    ADD CONSTRAINT sync_screen_share_leases_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES sync_episode_control(tenant_id, space_id, episode_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_screen_share_leases
    ADD CONSTRAINT sync_screen_share_leases_tenant_id_space_id_episode_id_own_fkey FOREIGN KEY (tenant_id, space_id, episode_id, owner_participant_id, owner_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_whiteboard_draw_policies
    ADD CONSTRAINT sync_whiteboard_draw_policie_tenant_id_space_id_episode_i_fkey1 FOREIGN KEY (tenant_id, space_id, episode_id, updated_by_participant_id) REFERENCES participants(tenant_id, space_id, episode_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_whiteboard_draw_policies
    ADD CONSTRAINT sync_whiteboard_draw_policies_tenant_id_space_id_episode_i_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES episodes(tenant_id, space_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY sync_whiteboard_draw_policy_receipts
    ADD CONSTRAINT sync_whiteboard_draw_policy__tenant_id_space_id_episode_i_fkey1 FOREIGN KEY (tenant_id, space_id, episode_id, participant_id) REFERENCES participants(tenant_id, space_id, episode_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_whiteboard_draw_policy_receipts
    ADD CONSTRAINT sync_whiteboard_draw_policy_r_tenant_id_space_id_episode_i_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES episodes(tenant_id, space_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY sync_whiteboard_elements
    ADD CONSTRAINT sync_whiteboard_elements_tenant_id_space_id_episode_id_fkey FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES episodes(tenant_id, space_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_whiteboard_elements
    ADD CONSTRAINT sync_whiteboard_elements_tenant_id_space_id_scene_id_fkey FOREIGN KEY (tenant_id, space_id, scene_id) REFERENCES sync_whiteboard_scenes(tenant_id, space_id, scene_id) ON DELETE CASCADE;

ALTER TABLE ONLY sync_whiteboard_files
    ADD CONSTRAINT sync_whiteboard_files_tenant_id_space_id_episode_id_partic_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, participant_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_whiteboard_files
    ADD CONSTRAINT sync_whiteboard_files_tenant_id_space_id_scene_id_fkey FOREIGN KEY (tenant_id, space_id, scene_id) REFERENCES sync_whiteboard_scenes(tenant_id, space_id, scene_id) ON DELETE CASCADE;

ALTER TABLE ONLY sync_whiteboard_operation_receipts
    ADD CONSTRAINT sync_whiteboard_operation_rec_tenant_id_space_id_episode_i_fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id, submitted_generation) REFERENCES participants(tenant_id, space_id, episode_id, id, generation) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_whiteboard_permissions
    ADD CONSTRAINT sync_whiteboard_permissions_tenant_id_space_id_episode_id__fkey FOREIGN KEY (tenant_id, space_id, episode_id, participant_id) REFERENCES participants(tenant_id, space_id, episode_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY sync_whiteboard_permissions
    ADD CONSTRAINT sync_whiteboard_permissions_tenant_id_space_id_episode_id_fkey1 FOREIGN KEY (tenant_id, space_id, episode_id, granted_by_participant_id) REFERENCES participants(tenant_id, space_id, episode_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_whiteboard_scenes
    ADD CONSTRAINT sync_whiteboard_scenes_episode_fk FOREIGN KEY (tenant_id, space_id, episode_id) REFERENCES episodes(tenant_id, space_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY sync_whiteboard_scenes
    ADD CONSTRAINT sync_whiteboard_scenes_tenant_id_space_id_fkey FOREIGN KEY (tenant_id, space_id) REFERENCES spaces(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY tenant_artifact_policies
    ADD CONSTRAINT tenant_artifact_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY tenant_onboarding_requests
    ADD CONSTRAINT tenant_onboarding_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES users(id);

ALTER TABLE ONLY tenant_onboarding_requests
    ADD CONSTRAINT tenant_onboarding_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY tenant_signing_keys
    ADD CONSTRAINT tenant_signing_keys_created_by_api_key_id_fkey1 FOREIGN KEY (created_by_api_key_id) REFERENCES api_keys(id);

ALTER TABLE ONLY tenant_signing_keys
    ADD CONSTRAINT tenant_signing_keys_created_by_user_id_fkey1 FOREIGN KEY (created_by_user_id) REFERENCES users(id);

ALTER TABLE ONLY tenant_signing_keys
    ADD CONSTRAINT tenant_signing_keys_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY transcript_chunks
    ADD CONSTRAINT transcript_chunks_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY transcript_chunks
    ADD CONSTRAINT transcript_chunks_transcript_id_fkey1 FOREIGN KEY (transcript_id) REFERENCES transcriptions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY transcription_attempts
    ADD CONSTRAINT transcription_attempts_chunk_id_fkey1 FOREIGN KEY (chunk_id) REFERENCES transcript_chunks(id) ON DELETE RESTRICT;

ALTER TABLE ONLY transcription_attempts
    ADD CONSTRAINT transcription_attempts_transcript_id_fkey1 FOREIGN KEY (transcript_id) REFERENCES transcriptions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY transcription_chunk_results
    ADD CONSTRAINT transcription_chunk_results_attempt_id_fkey1 FOREIGN KEY (attempt_id) REFERENCES transcription_attempts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY transcription_chunk_results
    ADD CONSTRAINT transcription_chunk_results_chunk_id_fkey1 FOREIGN KEY (chunk_id) REFERENCES transcript_chunks(id) ON DELETE RESTRICT;

ALTER TABLE ONLY transcription_cleanup_jobs
    ADD CONSTRAINT transcription_cleanup_jobs_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY transcription_cleanup_jobs
    ADD CONSTRAINT transcription_cleanup_jobs_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY transcription_cleanup_jobs
    ADD CONSTRAINT transcription_cleanup_jobs_transcript_id_fkey1 FOREIGN KEY (transcript_id) REFERENCES transcriptions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY transcriptions
    ADD CONSTRAINT transcriptions_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES episodes(id);

ALTER TABLE ONLY transcriptions
    ADD CONSTRAINT transcriptions_recording_id_fkey1 FOREIGN KEY (recording_id) REFERENCES recordings(id);

ALTER TABLE ONLY transcriptions
    ADD CONSTRAINT transcriptions_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id);

ALTER TABLE ONLY transcriptions
    ADD CONSTRAINT transcriptions_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE ONLY webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_event_fkey FOREIGN KEY (tenant_id, event_id) REFERENCES webhook_events(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_parent_fkey FOREIGN KEY (tenant_id, parent_delivery_id) REFERENCES webhook_deliveries(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_revision_fkey FOREIGN KEY (tenant_id, endpoint_revision_id, endpoint_id, endpoint_revision) REFERENCES webhook_endpoint_revisions(tenant_id, id, endpoint_id, revision) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_delivery_attempts
    ADD CONSTRAINT webhook_delivery_attempts_delivery_fkey FOREIGN KEY (tenant_id, delivery_id) REFERENCES webhook_deliveries(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_endpoint_revisions
    ADD CONSTRAINT webhook_endpoint_revisions_endpoint_fkey FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_created_by_user_id_fkey1 FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_current_revision_fkey FOREIGN KEY (tenant_id, id, current_target_revision) REFERENCES webhook_endpoint_revisions(tenant_id, endpoint_id, revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_events
    ADD CONSTRAINT webhook_events_linked_user_id_fkey1 FOREIGN KEY (linked_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY webhook_events
    ADD CONSTRAINT webhook_events_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_idempotency_records
    ADD CONSTRAINT webhook_idempotency_records_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_tenant_state
    ADD CONSTRAINT webhook_tenant_state_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

insert into recording_capacity (id) values (1);
insert into recording_capture_provider_rate_budget (id) values (1);
insert into sync_entry_rollout (singleton) values (true);
insert into sync_presence_runtime (singleton, recover_after)
values (true, clock_timestamp() + interval '120 seconds');

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'the baseline migration cannot be reverted'; end $$;
-- +goose StatementEnd
