-- +goose Up
create table participant_presence_leases (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid primary key,
    participant_generation bigint not null check (participant_generation > 0),
    expires_at timestamptz not null,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);

create index participant_presence_leases_expiry_idx on participant_presence_leases(expires_at);


-- Do not retain expired lease hints for historical attendance rows.
-- +goose StatementBegin
create function clear_terminal_participant_presence() returns trigger language plpgsql as $$
begin
    delete from participant_presence_leases
    where participant_id = new.id;
    return new;
end;
$$;
-- +goose StatementEnd

create trigger clear_terminal_participant_presence
    after update of status on participants
    for each row when (new.status = 'left')
    execute function clear_terminal_participant_presence();

-- +goose Down
drop trigger clear_terminal_participant_presence on participants;
drop function clear_terminal_participant_presence();
drop table participant_presence_leases;
