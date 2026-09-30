-- +goose Up
-- +goose StatementBegin
create function recording_enqueue_terminal_capture_source_cleanup(source_recording_id uuid, stopped_at timestamptz)
returns void
language sql
as $$
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
create function recording_terminal_capture_source_cleanup_trigger()
returns trigger
language plpgsql
as $$
begin
    perform recording_enqueue_terminal_capture_source_cleanup(new.recording_id, coalesce(new.terminal_at, new.updated_at));
    return new;
end;
$$;
-- +goose StatementEnd

create trigger recording_terminal_capture_source_cleanup
after update of state on recording_jobs
for each row
when (new.kind = 'capture' and new.state = 'terminal_failure' and old.state is distinct from new.state)
execute function recording_terminal_capture_source_cleanup_trigger();

-- +goose StatementBegin
create function recording_backfill_terminal_capture_source_cleanup()
returns void
language plpgsql
as $$
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

select recording_backfill_terminal_capture_source_cleanup();

-- +goose Down
drop function recording_backfill_terminal_capture_source_cleanup();
drop trigger recording_terminal_capture_source_cleanup on recording_jobs;
drop function recording_terminal_capture_source_cleanup_trigger();
drop function recording_enqueue_terminal_capture_source_cleanup(uuid, timestamptz);
