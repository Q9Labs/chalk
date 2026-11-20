-- +goose Up
-- Pending evidence is kept until the relay gets a full ingest receipt. The
-- SDK transaction inserts this alongside its settled ranges.
create table telemetry_outbox (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    payload jsonb not null check (jsonb_typeof(payload) = 'array' and jsonb_array_length(payload) > 0),
    available_at timestamptz not null default now(),
    retry boolean not null default false
);
create index telemetry_outbox_ready_idx on telemetry_outbox (available_at, id);
create index telemetry_outbox_tenant_idx on telemetry_outbox (tenant_id);

-- Abort an enqueue at capacity rather than evict acknowledged evidence. The
-- same counter covers both writers and is debited on relay or Tenant purge.
create table telemetry_outbox_capacity (
    singleton boolean primary key default true check (singleton),
    max_bytes bigint not null default 67108864,
    queued_bytes bigint not null default 0 check (queued_bytes between 0 and max_bytes)
);
insert into telemetry_outbox_capacity default values;

-- +goose StatementBegin
create function account_telemetry_outbox() returns trigger language plpgsql as $$
begin
    if TG_OP = 'INSERT' then
        update telemetry_outbox_capacity set queued_bytes = queued_bytes + octet_length(new.payload::text) + 256;
    elsif TG_OP = 'DELETE' then
        update telemetry_outbox_capacity set queued_bytes = queued_bytes - octet_length(old.payload::text) - 256;
    else
        update telemetry_outbox_capacity set queued_bytes = 0;
    end if;
    return null;
end;
$$;
-- +goose StatementEnd
create trigger account_telemetry_outbox_rows after insert or delete on telemetry_outbox
    for each row execute function account_telemetry_outbox();
create trigger account_telemetry_outbox_truncate after truncate on telemetry_outbox
    for each statement execute function account_telemetry_outbox();

-- +goose Down
drop table telemetry_outbox;
drop function account_telemetry_outbox();
drop table telemetry_outbox_capacity;
