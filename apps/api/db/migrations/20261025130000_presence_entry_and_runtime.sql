-- +goose Up
alter table participant_presence_leases
    add column entry_generation bigint not null default 0 check (entry_generation >= 0);

create table participant_presence_runtime (
    singleton boolean primary key default true check (singleton),
    recover_after timestamptz not null
);
insert into participant_presence_runtime(singleton, recover_after)
values (true, clock_timestamp() + interval '120 seconds');

-- +goose Down
drop table participant_presence_runtime;
alter table participant_presence_leases drop column entry_generation;
