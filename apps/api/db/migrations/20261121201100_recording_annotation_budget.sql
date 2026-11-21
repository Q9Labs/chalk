-- +goose Up
create table recording_screen_annotation_budgets (
    recording_id uuid primary key references recordings(id) on delete cascade,
    retained_bytes bigint not null,
    layer_count bigint not null,
    exhausted boolean not null default false
);

-- Count existing capture facts without discarding in-flight recording data.
insert into recording_screen_annotation_budgets (recording_id, retained_bytes, layer_count)
select recording_id, sum(retained_bytes)::bigint, sum(layer_count)::bigint
from (
    select recording_id,
        sum(octet_length(layer::text) + octet_length(initial_marks::text) + 256) as retained_bytes,
        count(*) as layer_count
    from recording_screen_annotation_layers
    group by recording_id
    union all
    select recording_id, sum(octet_length(change::text) + 80), 0::bigint
    from recording_screen_annotation_changes
    group by recording_id
) usage
group by recording_id;

-- +goose StatementBegin
create function bound_recording_annotation() returns trigger language plpgsql as $$
declare
    layer_delta bigint;
    byte_delta bigint;
    cut_ms bigint;
    is_exhausted boolean;
    -- Leave room below the completion limit and bound changes even at their
    -- minimum size (80 bytes of envelope per change).
    byte_budget constant bigint := 16777216;
    layer_budget constant bigint := 4096;
begin
    if tg_table_name = 'recording_screen_annotation_layers' then
        -- Multiple plans in one capture epoch can seed the same layer.
        if exists (
            select 1 from recording_screen_annotation_layers
            where (tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id) =
                (new.tenant_id, new.space_id, new.episode_id, new.recording_id, new.capture_epoch, new.layer_id)
        ) then
            return null;
        end if;
        layer_delta := 1;
        byte_delta := octet_length(new.layer::text) + octet_length(new.initial_marks::text) + 256;
        cut_ms := new.initial_at_ms;
    else
        layer_delta := 0;
        byte_delta := octet_length(new.change::text) + 80;
        cut_ms := new.at_ms;
    end if;

    insert into recording_screen_annotation_budgets as budget (recording_id, retained_bytes, layer_count)
    values (new.recording_id, byte_delta, layer_delta)
    on conflict (recording_id) do update
    set exhausted = budget.retained_bytes + byte_delta > byte_budget
                 or budget.layer_count + layer_delta > layer_budget,
        retained_bytes = case
            when budget.retained_bytes + byte_delta <= byte_budget and budget.layer_count + layer_delta <= layer_budget
                then budget.retained_bytes + byte_delta else budget.retained_bytes end,
        layer_count = case
            when budget.retained_bytes + byte_delta <= byte_budget and budget.layer_count + layer_delta <= layer_budget
                then budget.layer_count + layer_delta else budget.layer_count end
    where not budget.exhausted
    returning exhausted into is_exhausted;

    if not found then
        return null;
    end if;
    if is_exhausted then
        -- Keep a coherent prefix across all epochs. Do not allow a later small
        -- change through after an earlier change has been dropped.
        update recording_screen_annotation_layers
        set closed_at_ms = greatest(initial_at_ms, cut_ms)
        where (tenant_id, space_id, episode_id, recording_id) =
            (new.tenant_id, new.space_id, new.episode_id, new.recording_id)
          and closed_at_ms is null;
        return null;
    end if;
    return new;
end;
$$;
-- +goose StatementEnd

create trigger bound_recording_annotation_layers
    before insert on recording_screen_annotation_layers
    for each row execute function bound_recording_annotation();

create trigger bound_recording_annotation_changes
    before insert on recording_screen_annotation_changes
    for each row execute function bound_recording_annotation();

-- +goose Down
drop trigger bound_recording_annotation_changes on recording_screen_annotation_changes;
drop trigger bound_recording_annotation_layers on recording_screen_annotation_layers;
drop function bound_recording_annotation();
drop table recording_screen_annotation_budgets;
