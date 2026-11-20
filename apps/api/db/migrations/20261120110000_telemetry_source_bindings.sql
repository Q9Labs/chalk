-- +goose Up
-- Binds each telemetry source to the first participant that sent a batch touching it
-- (docs/telemetry-delivery.md), so another participant of the tenant that knows a source_id
-- cannot add claims to it. identity_id is that participant's User or Agent, null for a guest; a
-- later participant of the same identity is a successor and may write too. No foreign keys, like
-- telemetry_sources: a late batch must not be refused because a participant row is gone, and a
-- tenant purge removes the rows by tenant_id. A new table: the previous release never reads or
-- writes it.
create table telemetry_source_bindings (
    tenant_id uuid not null,
    source_id uuid not null,
    participant_id uuid not null,
    identity_id uuid,
    bound_at timestamptz not null,
    primary key (tenant_id, source_id)
);

-- +goose Down
drop table telemetry_source_bindings;
