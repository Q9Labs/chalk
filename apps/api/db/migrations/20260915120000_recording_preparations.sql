-- +goose Up
create table recording_preparations (
    tenant_id uuid not null,
    space_id uuid not null,
    starts_at timestamptz not null,
    state text not null check (state in ('scheduled', 'consumed', 'canceled', 'expired')),
    revision bigint not null check (revision > 0),
    request_revision bigint not null check (request_revision >= 0),
    request_kind text not null check (request_kind in ('prepare', 'cancel')),
    consumed_recording_id uuid references recordings(id),
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id),
    foreign key (tenant_id, space_id) references spaces(tenant_id, id) on delete cascade,
    check ((state = 'consumed') = (consumed_recording_id is not null))
);

create index recording_preparations_due_idx on recording_preparations(starts_at, tenant_id, space_id)
    where state = 'scheduled';

-- +goose Down
-- +goose StatementBegin
do $$
begin
    if exists (select 1 from recording_preparations) then
        raise exception 'recording preparations must be retained; disable the feature instead of dropping durable intents';
    end if;
end;
$$;
-- +goose StatementEnd
drop table recording_preparations;
