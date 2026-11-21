-- +goose Up
-- Private recording data, keyed to a capture attempt. A worker translates
-- server wall times with its capture clock anchor when freezing the sidecar.
create table recording_screen_annotation_layers (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid not null references recordings(id) on delete cascade,
    capture_epoch bigint not null,
    layer_id uuid not null,
    publication_id text not null,
    sharer_generation bigint not null,
    layer jsonb not null,
    initial_at_ms bigint not null,
    initial_revision bigint not null,
    initial_paused boolean not null,
    initial_marks jsonb not null,
    closed_at_ms bigint,
    primary key (tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id),
    check (octet_length(initial_marks::text) <= 1048576)
);
create index recording_annotation_active_layer_idx
    on recording_screen_annotation_layers (tenant_id, space_id, episode_id, layer_id)
    where closed_at_ms is null;

create table recording_screen_annotation_changes (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid not null,
    capture_epoch bigint not null,
    layer_id uuid not null,
    revision bigint not null,
    at_ms bigint not null,
    change jsonb not null check (octet_length(change::text) <= 32768),
    primary key (tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id, revision),
    foreign key (tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id)
        references recording_screen_annotation_layers(tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id)
        on delete cascade
);

-- +goose StatementBegin
create function seed_recording_screen_annotation(
    target sync_screen_annotation_layers, plan recording_capture_plans, captured_at_ms bigint
) returns void language plpgsql as $$
begin
    if exists (
        select 1 from recording_pipelines pipeline
        where pipeline.tenant_id = plan.tenant_id and pipeline.recording_id = plan.recording_id
            and pipeline.state in ('capture_leased', 'capturing_segmented')
            and pipeline.stop_requested_at is null
    ) and exists (
        select 1 from jsonb_array_elements(convert_from(plan.plan_bytes, 'UTF8')::jsonb->'tracks') track
        where track->>'source' = 'screen' and track->>'kind' = 'video'
            and track->>'publication_reference' = target.publication_id
            and track->>'participant_id' = target.sharer_id::text
            and track->>'participant_generation' = target.sharer_generation::text
    ) then
        insert into recording_screen_annotation_layers (
            tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id, publication_id, sharer_generation, layer,
            initial_at_ms, initial_revision, initial_paused, initial_marks
        ) values (
            target.tenant_id, target.space_id, target.episode_id, plan.recording_id, plan.capture_epoch, target.layer_id,
            target.publication_id, target.sharer_generation, jsonb_build_object('layer_id', target.layer_id, 'publication_id', target.publication_id,
                'sharer_id', target.sharer_id, 'frame', target.frame),
            captured_at_ms, target.revision, target.paused, coalesce((
                select jsonb_agg(mark order by (mark->>'created_revision')::bigint)
                from jsonb_each(target.marks) item(id, mark)
                where mark->>'expires_at_ms' is null or (mark->>'expires_at_ms')::bigint > captured_at_ms
            ), '[]'::jsonb)
        ) on conflict do nothing;
    end if;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function recording_annotation_capture_plan() returns trigger language plpgsql as $$
declare
    layer sync_screen_annotation_layers;
    checkpoint_ms bigint;
begin
    -- Serialize creation of either the annotation layer or the capture cut.
    -- Do not lock the live layer here: its writer can be waiting for this lock.
    perform pg_advisory_xact_lock(hashtextextended(concat_ws(':', 'annotation-capture', new.tenant_id, new.space_id, new.episode_id), 0));
    checkpoint_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
    update recording_screen_annotation_layers
    set closed_at_ms = greatest(initial_at_ms, checkpoint_ms)
    where tenant_id = new.tenant_id and space_id = new.space_id and episode_id = new.episode_id
      and recording_id = new.recording_id and capture_epoch < new.capture_epoch and closed_at_ms is null;

    select live.* into layer from sync_screen_annotation_layers live
    where live.tenant_id = new.tenant_id and live.space_id = new.space_id and live.episode_id = new.episode_id;
    if found then
        perform seed_recording_screen_annotation(layer, new, checkpoint_ms);
    end if;
    return null;
end;
$$;
-- +goose StatementEnd
create trigger recording_annotation_capture_plan
    after insert on recording_capture_plans
    for each row execute function recording_annotation_capture_plan();

-- +goose StatementBegin
create function recording_annotation_layer_change() returns trigger language plpgsql as $$
declare
    current_layer sync_screen_annotation_layers;
    plan recording_capture_plans;
    event_at_ms bigint;
    lease_end_ms bigint;
begin
    current_layer := case when tg_op = 'DELETE' then old else new end;
    if tg_op = 'UPDATE' and (new.last_change is null or new.revision = old.revision) then
        return null;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(concat_ws(':', 'annotation-capture', current_layer.tenant_id, current_layer.space_id, current_layer.episode_id), 0));
    event_at_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;

    if tg_op = 'INSERT' then
        for plan in
            select distinct on (plans.recording_id) plans.*
            from recording_capture_plans plans
            join recording_jobs job on job.id = plans.job_id and job.tenant_id = plans.tenant_id
                and job.state = 'leased' and job.fencing_generation = plans.fencing_generation
            where plans.tenant_id = new.tenant_id and plans.space_id = new.space_id and plans.episode_id = new.episode_id
            order by plans.recording_id, plans.capture_epoch desc, plans.revision desc
        loop
            perform seed_recording_screen_annotation(new, plan, event_at_ms);
        end loop;
    elsif tg_op = 'DELETE' then
        select (extract(epoch from least(renewed_until, hard_expires_at)) * 1000)::bigint
        into lease_end_ms from sync_screen_share_leases lease
        where lease.tenant_id = old.tenant_id and lease.space_id = old.space_id and lease.episode_id = old.episode_id
          and lease.owner_participant_id = old.sharer_id and lease.owner_generation = old.sharer_generation;

        event_at_ms := least(event_at_ms, lease_end_ms);
        update recording_screen_annotation_layers captured set closed_at_ms = greatest(captured.initial_at_ms, event_at_ms)
        where captured.tenant_id = old.tenant_id and captured.space_id = old.space_id
            and captured.episode_id = old.episode_id and captured.layer_id = old.layer_id and captured.closed_at_ms is null;
    elsif new.last_change is not null then
        insert into recording_screen_annotation_changes
            (tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id, revision, at_ms, change)
        select captured.tenant_id, captured.space_id, captured.episode_id, captured.recording_id,
            captured.capture_epoch, captured.layer_id, new.revision, greatest(captured.initial_at_ms, event_at_ms), new.last_change
        from recording_screen_annotation_layers captured
        where captured.tenant_id = new.tenant_id and captured.space_id = new.space_id
            and captured.episode_id = new.episode_id and captured.layer_id = new.layer_id
            and captured.closed_at_ms is null and new.revision > captured.initial_revision
        on conflict do nothing;
    end if;
    return null;
end;
$$;
-- +goose StatementEnd
create trigger recording_annotation_layer_change
    after insert or update or delete on sync_screen_annotation_layers
    for each row execute function recording_annotation_layer_change();

-- +goose StatementBegin
create function recording_annotation_cut() returns trigger language plpgsql as $$
declare
    recording recordings;
    cut_ms bigint;
begin
    select row.* into recording from recordings row
    where row.id = new.recording_id and row.tenant_id = new.tenant_id;
    if not found then
        return null;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(concat_ws(':', 'annotation-capture', recording.tenant_id, recording.space_id, recording.episode_id), 0));
    -- The presentation and its private object were frozen before successful
    -- completion. Keep the transient facts only while capture can be retried.
    if new.capture_completed_at is not null then
        delete from recording_screen_annotation_layers
        where tenant_id = recording.tenant_id and space_id = recording.space_id
          and episode_id = recording.episode_id and recording_id = recording.id;
        return null;
    end if;
    cut_ms := (extract(epoch from coalesce(new.stop_requested_at, new.capture_completed_at, clock_timestamp())) * 1000)::bigint;

    update recording_screen_annotation_layers captured
        set closed_at_ms = greatest(captured.initial_at_ms, cut_ms)
    where captured.tenant_id = recording.tenant_id and captured.space_id = recording.space_id
        and captured.episode_id = recording.episode_id and captured.recording_id = recording.id
        and (captured.closed_at_ms is null or captured.closed_at_ms > greatest(captured.initial_at_ms, cut_ms));
    return null;
end;
$$;
-- +goose StatementEnd
create trigger recording_annotation_cut
    after update on recording_pipelines
    for each row when (
        (new.capture_completed_at is not null and old.capture_completed_at is null)
        or (new.stop_requested_at is not null and old.stop_requested_at is distinct from new.stop_requested_at)
        or (old.state in ('capture_leased', 'capturing_segmented') and new.state not in ('capture_leased', 'capturing_segmented'))
    ) execute function recording_annotation_cut();

-- +goose Down
drop trigger recording_annotation_cut on recording_pipelines;
drop trigger recording_annotation_layer_change on sync_screen_annotation_layers;
drop trigger recording_annotation_capture_plan on recording_capture_plans;
drop function recording_annotation_cut();
drop function recording_annotation_layer_change();
drop function recording_annotation_capture_plan();
drop function seed_recording_screen_annotation(sync_screen_annotation_layers, recording_capture_plans, bigint);
drop table recording_screen_annotation_changes;
drop table recording_screen_annotation_layers;
