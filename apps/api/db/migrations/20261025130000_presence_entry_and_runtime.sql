-- +goose Up
alter table participant_presence_leases
    add column entry_generation bigint not null default 0 check (entry_generation >= 0);

create table participant_presence_runtime (
    singleton boolean primary key default true check (singleton),
    recover_after timestamptz not null
);
insert into participant_presence_runtime(singleton, recover_after)
values (true, clock_timestamp() + interval '120 seconds');

-- +goose StatementBegin
create function clear_unfenced_participant_presence() returns trigger language plpgsql as $$
begin
    delete from participant_presence_leases;
    return new;
end;
$$;
-- +goose StatementEnd
create trigger clear_unfenced_participant_presence
    after update of enforced on sync_entry_rollout
    for each row when (old.enforced and not new.enforced)
    execute function clear_unfenced_participant_presence();

-- +goose Down
drop trigger clear_unfenced_participant_presence on sync_entry_rollout;
drop function clear_unfenced_participant_presence();
drop table participant_presence_runtime;
alter table participant_presence_leases drop column entry_generation;
