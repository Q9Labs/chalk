-- +goose Up
create table sync_screen_annotation_layers (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    layer_id uuid not null unique,
    publication_id text not null,
    sharer_id uuid not null,
    sharer_generation bigint not null,
    frame jsonb not null,
    revision bigint not null default 1 check (revision > 0),
    fence bigint not null default 1 check (fence > 0),
    paused boolean not null default false,
    marks jsonb not null default '{}',
    requests jsonb not null default '{}',
    next_expiry_at_ms bigint,
    history jsonb not null default '{}',
    last_change jsonb,
    opened_event_id uuid not null default gen_random_uuid(),
    journey_id uuid,
    parent_event_id uuid,
    producing_trace_id text,
    producing_span_id text,
    primary key (tenant_id, space_id, episode_id),
    foreign key (tenant_id, space_id, episode_id) references episodes(tenant_id, space_id, id) on delete cascade
);

create index sync_screen_annotation_layers_expiry
    on sync_screen_annotation_layers(next_expiry_at_ms) where next_expiry_at_ms is not null;

create table sync_screen_annotation_receipts (
    layer_id uuid not null references sync_screen_annotation_layers(layer_id) on delete cascade,
    participant_id uuid not null,
    generation bigint not null,
    operation_id uuid not null,
    fingerprint bytea not null,
    revision bigint not null,
    expires_at_ms bigint not null,
    primary key (layer_id, participant_id, generation, operation_id)
);
create index sync_screen_annotation_receipts_expiry
    on sync_screen_annotation_receipts(layer_id, expires_at_ms);
create index sync_screen_annotation_receipts_idle_expiry
    on sync_screen_annotation_receipts(expires_at_ms);

-- The publication witness is disposable, but retirement must happen in the same
-- commit as lifecycle and draw authority changes, including writes from the API.
-- +goose StatementBegin
create function sync_screen_annotation_authority_changed() returns trigger language plpgsql as $$
declare
    scoped_tenant uuid;
    scoped_space uuid;
    scoped_episode uuid;
    close_reason text;
begin
    if tg_op = 'DELETE' then
        scoped_tenant := old.tenant_id;
        scoped_space := old.space_id;
        scoped_episode := old.episode_id;
    else
        scoped_tenant := new.tenant_id;
        scoped_space := new.space_id;
        if tg_table_name = 'episodes' then
            scoped_episode := new.id;
        else
            scoped_episode := new.episode_id;
        end if;
    end if;

    if tg_table_name = 'episodes' then
        close_reason := 'episode_ended';
    elsif tg_table_name = 'sync_screen_share_leases' then
        close_reason := case when tg_op = 'DELETE' then 'share_ended' else 'share_replaced' end;
    elsif tg_table_name = 'participants' then
        if exists (
            select 1 from sync_screen_annotation_layers
            where tenant_id = scoped_tenant and space_id = scoped_space and episode_id = scoped_episode
                and sharer_id = new.id and (sharer_generation <> new.generation or new.status <> 'active')
        ) then
            close_reason := 'share_ended';
        end if;
    end if;

    if close_reason is not null then
        delete from sync_screen_annotation_layers
        where tenant_id = scoped_tenant and space_id = scoped_space and episode_id = scoped_episode;
    else
        update sync_screen_annotation_layers
        set revision = revision + 1, fence = fence + 1, last_change = null,
            requests = case
                when tg_table_name = 'sync_whiteboard_draw_policies' then '{}'::jsonb
                else requests - coalesce(
                    case when tg_table_name = 'participants' then to_jsonb(new)->>'id'
                         when tg_op = 'DELETE' then to_jsonb(old)->>'participant_id'
                         else to_jsonb(new)->>'participant_id' end, '')
            end
        where tenant_id = scoped_tenant and space_id = scoped_space and episode_id = scoped_episode;
    end if;

    return null;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function sync_screen_annotation_layer_changed() returns trigger language plpgsql as $$
begin
    if tg_op = 'UPDATE' and new.revision = old.revision then
        return null;
    end if;
    if tg_op = 'DELETE' then
        perform pg_notify('chalk_screen_annotation', concat_ws(':', old.tenant_id, old.space_id, old.episode_id, 'control'));
    else
        perform pg_notify('chalk_screen_annotation', concat_ws(':', new.tenant_id, new.space_id, new.episode_id,
            case when tg_op = 'INSERT' or old.fence is distinct from new.fence then 'control' else 'marks' end));
    end if;
    return null;
end;
$$;
-- +goose StatementEnd

create trigger sync_screen_annotation_layer_changed
    after insert or update or delete on sync_screen_annotation_layers
    for each row execute function sync_screen_annotation_layer_changed();

create trigger sync_screen_annotation_episode_ended
    after update of status on episodes
    for each row when (old.status is distinct from new.status and new.status = 'ended')
    execute function sync_screen_annotation_authority_changed();
create trigger sync_screen_annotation_lease_deleted
    after delete on sync_screen_share_leases
    for each row execute function sync_screen_annotation_authority_changed();
create trigger sync_screen_annotation_lease_replaced
    after update on sync_screen_share_leases
    for each row when (
        old.owner_participant_id is distinct from new.owner_participant_id
        or old.owner_generation is distinct from new.owner_generation
        or (old.lease_id is distinct from new.lease_id and old.renewed_until <= new.acquired_at)
    ) execute function sync_screen_annotation_authority_changed();
create trigger sync_screen_annotation_participant_changed
    after update on participants
    for each row when (
        old.status is distinct from new.status or old.generation is distinct from new.generation
        or old.capabilities is distinct from new.capabilities or old.name is distinct from new.name
    ) execute function sync_screen_annotation_authority_changed();
create trigger sync_screen_annotation_policy_changed
    after insert or update or delete on sync_whiteboard_draw_policies
    for each row execute function sync_screen_annotation_authority_changed();
create trigger sync_screen_annotation_grant_changed
    after insert or update or delete on sync_whiteboard_permissions
    for each row execute function sync_screen_annotation_authority_changed();

-- +goose StatementBegin
create function sync_screen_annotation_observation_changed() returns trigger language plpgsql as $$
begin
    if exists (
        select 1 from provider_operation_observation_heads head
        where head.tenant_id = new.tenant_id and head.episode_id = new.episode_id
          and head.incarnation = new.incarnation and head.sequence = new.sequence
    ) then
        delete from sync_screen_annotation_layers layer
        where layer.tenant_id = new.tenant_id and layer.episode_id = new.episode_id
          and not exists (
              select 1 from jsonb_array_elements(new.publications) publication
              where publication->>'participant_id' = layer.sharer_id::text
                and publication->>'source' = 'screen' and publication->>'enabled' = 'true'
                and publication->>'publication_id' = layer.publication_id
          );
    end if;
    return null;
end;
$$;
-- +goose StatementEnd
create trigger sync_screen_annotation_observation_changed
    after insert on provider_operation_observations
    for each row execute function sync_screen_annotation_observation_changed();

-- Record only lifecycle evidence. Annotation payloads and display names never enter telemetry.
-- +goose StatementBegin
create function sync_screen_annotation_ledger() returns trigger language plpgsql as $$
declare
    current_layer sync_screen_annotation_layers;
    cause text;
    event_name text;
    event_id uuid;
    parent_id uuid;
    lifecycle_phase text;
    end_trace_id text;
    end_span_id text;
begin
    if tg_op = 'INSERT' then
        current_layer := new;
        event_name := 'screen_annotation.opened';
        event_id := new.opened_event_id;
        parent_id := new.parent_event_id;
        lifecycle_phase := 'phase';
    else
        current_layer := old;
        event_name := 'screen_annotation.closed';
        event_id := gen_random_uuid();
        parent_id := old.opened_event_id;
        lifecycle_phase := 'terminal';

        select case when episode.status = 'ended' then 'episode_ended'
                    when exists (
                      select 1
                      from provider_operation_observation_heads head
                      join provider_operation_observations observation using (tenant_id, episode_id, incarnation, sequence)
                      cross join lateral jsonb_array_elements(observation.publications) item
                      where head.tenant_id = old.tenant_id and head.episode_id = old.episode_id
                        and item->>'source' = 'screen' and item->>'enabled' = 'true'
                        and item->>'publication_id' <> old.publication_id
                    ) then 'share_replaced' else 'share_ended' end
        into cause
        from episodes episode
        where episode.tenant_id = old.tenant_id and episode.space_id = old.space_id and episode.id = old.episode_id;

        if cause = 'episode_ended' then
            -- The finalizer has already persisted this Episode's end event.
            select operation.producing_trace_id, operation.producing_span_id
            into end_trace_id, end_span_id
            from sync_control_events ended
            join sync_external_operations operation
              on operation.tenant_id = ended.tenant_id and operation.space_id = ended.space_id
             and operation.episode_id = ended.episode_id
             and operation.external_operation_id = ended.external_operation_id
            where ended.tenant_id = old.tenant_id and ended.space_id = old.space_id
              and ended.episode_id = old.episode_id and ended.event_name = 'episode_ended'
              and operation.producing_trace_id is not null and operation.producing_span_id is not null
            order by ended.revision desc
            limit 1;
        else
            -- The media teardown can retire the share just before End settles.
            select operation.producing_trace_id, operation.producing_span_id
            into end_trace_id, end_span_id
            from sync_external_operations operation
            join provider_operation_receipts receipt
              on receipt.tenant_id = operation.tenant_id and receipt.episode_id = operation.episode_id
             and receipt.operation_id = operation.external_operation_id::text
             and receipt.effect = 'media.end_episode'
            where operation.tenant_id = old.tenant_id and operation.space_id = old.space_id
              and operation.episode_id = old.episode_id and operation.fence_active
              and operation.operation_name in ('end_episode', 'tenant_end_episode', 'maximum_episode_duration_expired')
              and (receipt.state = 'dispatching' or receipt.outcome in ('satisfied', 'confirmed'))
            order by receipt.dispatching_at desc
            limit 1;
            if found then
                cause := 'episode_ended';
            end if;
        end if;
    end if;

    insert into observability_journey_events (
        event_id, journey_id, sequence, occurred_at, name, phase, state, origin_kind,
        first_observed_layer, upstream_visibility, parent_event_id, trace_id, span_id, attributes
    ) values (
        event_id, coalesce(current_layer.journey_id, current_layer.episode_id),
        coalesce((
            select max(events.sequence) + 1 from observability_journey_events events
            where events.journey_id = coalesce(current_layer.journey_id, current_layer.episode_id)
        ), 0),
        clock_timestamp(), event_name, lifecycle_phase,
        case when tg_op = 'INSERT' then 'started' else 'completed' end,
        'user', 'sync', 'visible', parent_id, coalesce(end_trace_id, current_layer.producing_trace_id),
        coalesce(end_span_id, current_layer.producing_span_id),
        jsonb_strip_nulls(jsonb_build_object(
          'tenantId', current_layer.tenant_id, 'spaceId', current_layer.space_id,
          'episodeId', current_layer.episode_id, 'layerId', current_layer.layer_id,
          'publicationId', current_layer.publication_id, 'cause', cause
        ))
    );
    return null;
end;
$$;
-- +goose StatementEnd
create trigger sync_screen_annotation_ledger
    after insert or delete on sync_screen_annotation_layers
    for each row execute function sync_screen_annotation_ledger();

-- +goose Down
drop trigger sync_screen_annotation_observation_changed on provider_operation_observations;
drop function sync_screen_annotation_observation_changed();
drop trigger sync_screen_annotation_grant_changed on sync_whiteboard_permissions;
drop trigger sync_screen_annotation_policy_changed on sync_whiteboard_draw_policies;
drop trigger sync_screen_annotation_participant_changed on participants;
drop trigger sync_screen_annotation_lease_replaced on sync_screen_share_leases;
drop trigger sync_screen_annotation_lease_deleted on sync_screen_share_leases;
drop trigger sync_screen_annotation_episode_ended on episodes;
drop table sync_screen_annotation_receipts;
drop table sync_screen_annotation_layers;
drop function sync_screen_annotation_ledger();
drop function sync_screen_annotation_layer_changed();
drop function sync_screen_annotation_authority_changed();
