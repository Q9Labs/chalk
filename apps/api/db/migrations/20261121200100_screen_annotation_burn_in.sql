-- +goose Up
alter table sync_screen_annotation_layers add column burned_in boolean not null default false;

-- +goose StatementBegin
create or replace function seed_recording_screen_annotation(
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
                'sharer_id', target.sharer_id, 'frame', target.frame) ||
                case when target.burned_in then '{"burned_in": true}'::jsonb else '{}'::jsonb end,
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

-- +goose Down
-- +goose StatementBegin
create or replace function seed_recording_screen_annotation(
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

alter table sync_screen_annotation_layers drop column burned_in;
