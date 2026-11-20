-- +goose Up
-- Pending evidence is kept until the relay gets a full ingest receipt. The
-- SDK transaction inserts this alongside its settled ranges.
create table telemetry_outbox (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    payload jsonb not null check (jsonb_typeof(payload) = 'array' and jsonb_array_length(payload) > 0),
    available_at timestamptz not null default now()
);
create index telemetry_outbox_ready_idx on telemetry_outbox (available_at, id);
create index telemetry_outbox_tenant_idx on telemetry_outbox (tenant_id);

-- +goose Down
drop table telemetry_outbox;
