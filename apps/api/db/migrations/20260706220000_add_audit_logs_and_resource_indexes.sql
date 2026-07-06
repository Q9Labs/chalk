-- +goose Up
create table audit_logs (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    actor_user_id uuid references users(id),
    actor_type text not null,
    action text not null,
    details jsonb,
    outcome text not null,
    error_code text,
    error_message text,
    before jsonb,
    after jsonb,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create index rooms_tenant_created_at_id_idx on rooms(tenant_id, created_at desc, id desc);
create index room_sessions_tenant_room_created_at_id_idx on room_sessions(tenant_id, room_id, created_at desc, id desc);
create index recordings_tenant_created_at_id_idx on recordings(tenant_id, created_at desc, id desc);
create index recordings_tenant_session_created_at_id_idx on recordings(tenant_id, session_id, created_at desc, id desc);
create index transcriptions_tenant_created_at_id_idx on transcriptions(tenant_id, created_at desc, id desc);
create index transcriptions_tenant_recording_created_at_id_idx on transcriptions(tenant_id, recording_id, created_at desc, id desc);
create index audit_logs_tenant_created_at_id_idx on audit_logs(tenant_id, created_at desc, id desc);

-- +goose Down
drop index audit_logs_tenant_created_at_id_idx;
drop index transcriptions_tenant_recording_created_at_id_idx;
drop index transcriptions_tenant_created_at_id_idx;
drop index recordings_tenant_session_created_at_id_idx;
drop index recordings_tenant_created_at_id_idx;
drop index room_sessions_tenant_room_created_at_id_idx;
drop index rooms_tenant_created_at_id_idx;
drop table audit_logs;
