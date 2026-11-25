-- +goose Up
create table sync_presenting_states (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    revision bigint not null default 0 check (revision >= 0),
    primary key (tenant_id, space_id, episode_id)
);

create table sync_presenting_documents (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    document_id uuid not null,
    presenter_id uuid not null,
    presenter_generation bigint not null check (presenter_generation > 0),
    position bigint not null check (position > 0),
    page integer not null check (page between 1 and 10000),
    zoom integer not null check (zoom between 25 and 400),
    started_at_ms bigint not null check (started_at_ms >= 0),
    primary key (tenant_id, space_id, episode_id, document_id),
    unique (tenant_id, space_id, episode_id, position),
    foreign key (tenant_id, space_id, episode_id)
        references sync_presenting_states(tenant_id, space_id, episode_id) on delete cascade
);

create table sync_presenting_receipts (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    actor_id uuid not null,
    actor_generation bigint not null check (actor_generation > 0),
    operation_id bytea not null,
    fingerprint bytea not null,
    revision bigint not null check (revision >= 0),
    expires_at_ms bigint not null,
    primary key (tenant_id, space_id, episode_id, actor_id, actor_generation, operation_id)
);

create index sync_presenting_receipts_expiry
    on sync_presenting_receipts(expires_at_ms);

-- +goose StatementBegin
create function sync_presenting_changed() returns trigger language plpgsql as $$
declare
    scope record;
begin
    if tg_op = 'DELETE' then scope := old; else scope := new; end if;
    perform pg_notify('chalk_presenting', concat_ws(':', scope.tenant_id, scope.space_id, scope.episode_id));
    return null;
end;
$$;
-- +goose StatementEnd

create trigger sync_presenting_state_changed
    after insert or update or delete on sync_presenting_states
    for each row execute function sync_presenting_changed();

create trigger sync_presenting_document_changed
    after insert or update or delete on sync_presenting_documents
    for each row execute function sync_presenting_changed();

-- +goose StatementBegin
create function sync_presenting_episode_ended() returns trigger language plpgsql as $$
begin
    if new.status = 'ended' and old.status is distinct from 'ended' then
        delete from sync_presenting_states state
        where state.tenant_id = new.tenant_id
          and state.space_id = new.space_id
          and state.episode_id = new.id;
    end if;
    return null;
end;
$$;
-- +goose StatementEnd

create trigger sync_presenting_episode_ended
    after update of status on episodes
    for each row execute function sync_presenting_episode_ended();

-- +goose StatementBegin
create function sync_presenting_participant_left() returns trigger language plpgsql as $$
begin
    if new.status = 'left' and old.status is distinct from 'left' then
        delete from sync_presenting_documents document
        where document.tenant_id = new.tenant_id
          and document.space_id = new.space_id
          and document.episode_id = new.episode_id
          and document.presenter_id = new.id
          and document.presenter_generation = new.generation;
    end if;
    return null;
end;
$$;
-- +goose StatementEnd

create trigger sync_presenting_participant_left
    after update of status on participants
    for each row execute function sync_presenting_participant_left();

-- +goose Down
drop trigger sync_presenting_participant_left on participants;
drop trigger sync_presenting_episode_ended on episodes;
drop trigger sync_presenting_document_changed on sync_presenting_documents;
drop trigger sync_presenting_state_changed on sync_presenting_states;
drop function sync_presenting_participant_left();
drop function sync_presenting_episode_ended();
drop function sync_presenting_changed();
drop table sync_presenting_receipts;
drop table sync_presenting_documents;
drop table sync_presenting_states;
