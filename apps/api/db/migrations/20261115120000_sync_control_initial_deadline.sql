-- +goose Up
-- Retention replays an Episode's events from their first state, and that state includes the first deadline. The
-- Episode keeps only its current deadline, so the first extension erased the first one and the replay could not
-- match any digest from before it. The control row keeps the first deadline from then on.
alter table sync_episode_control
    add column initial_deadline_at_ms bigint,
    add column initial_deadline_generation bigint,
    add constraint sync_episode_control_initial_deadline_check check (
        (initial_deadline_at_ms is null and initial_deadline_generation is null)
        or (initial_deadline_at_ms >= 1 and initial_deadline_generation >= 1)
    );

-- +goose StatementBegin
create function record_initial_episode_deadline() returns trigger
language plpgsql as $$
begin
    -- Generation 1 means no extension came before this one, so the old deadline is the first one. An Episode
    -- extended before this migration keeps its columns empty; retention works its first deadline out from the digests.
    if old.deadline_generation = 1 then
        update sync_episode_control
        set initial_deadline_at_ms = floor(extract(epoch from old.deadline_at) * 1000)::bigint,
            initial_deadline_generation = 1
        where tenant_id = old.tenant_id and episode_id = old.id and initial_deadline_at_ms is null;
    end if;
    return new;
end;
$$;
-- +goose StatementEnd

create trigger episodes_record_initial_deadline
after update of deadline_at on episodes
for each row when (old.deadline_at is distinct from new.deadline_at)
execute function record_initial_episode_deadline();

-- +goose Down
drop trigger episodes_record_initial_deadline on episodes;
drop function record_initial_episode_deadline();
alter table sync_episode_control
    drop constraint sync_episode_control_initial_deadline_check,
    drop column initial_deadline_generation,
    drop column initial_deadline_at_ms;
