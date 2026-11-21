-- +goose Up
-- Durable problem reports. A report commits here with its journey ledger event
-- before any Discord forward, so Sent means stored. The description lives only
-- in this row and in Discord; it never reaches logs, spans or Axiom.
create table problem_reports (
    id uuid primary key,
    chk_code text not null,
    tenant_id uuid not null references tenants(id) on delete cascade,
    space_id uuid,
    episode_id uuid,
    participant_id uuid,
    generation bigint,
    client_session_id uuid,
    sdk_version text,
    journey_id uuid,
    picked_symptom text not null,
    description text not null,
    diagnostics text,
    forward_outcome text not null default 'pending',
    created_at timestamptz not null default now(),
    updated_at timestamptz,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete cascade
);
-- The CHK code is a scoped lookup, never an authority, so the index is not unique.
create index problem_reports_chk_code_idx on problem_reports (tenant_id, chk_code);
create index problem_reports_episode_idx on problem_reports (tenant_id, episode_id);
comment on column problem_reports.chk_code is 'CHK-XXXX diagnostic code of the reporting client session';
comment on column problem_reports.client_session_id is 'Telemetry outbox session id (cs_), not the baggage session.id';
comment on column problem_reports.picked_symptom is 'Registry symptom code the reporter picked, or a bounded placeholder';
comment on column problem_reports.forward_outcome is 'Bounded forward class: pending, ok, not_configured, http_<status> or transport_<category>';

-- Presigned diagnostic-bundle uploads. Exactly one of report_id and
-- live_request_id names what the bundle answers; each target gets one upload.
create table diagnostic_uploads (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    episode_id uuid,
    report_id uuid references problem_reports(id) on delete cascade,
    live_request_id uuid,
    trigger text not null check (trigger in ('report', 'live')),
    state text not null default 'issued' check (state in ('issued', 'stored', 'failed', 'expired')),
    bytes bigint,
    sha256 text,
    object_key text not null,
    issued_at timestamptz not null default now(),
    stored_at timestamptz,
    failed_at timestamptz,
    expires_at timestamptz not null,
    check (num_nonnulls(report_id, live_request_id) = 1)
);
create unique index diagnostic_uploads_report_idx on diagnostic_uploads (report_id) where report_id is not null;
create unique index diagnostic_uploads_live_request_idx on diagnostic_uploads (live_request_id) where live_request_id is not null;
create index diagnostic_uploads_episode_idx on diagnostic_uploads (tenant_id, episode_id);

-- Operator live-introspection requests. The status snapshot at insert is the
-- evidence for whether the seat could have answered; Sync fills delivery.
create table live_introspection_requests (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    episode_id uuid not null references episodes(id) on delete cascade,
    participant_id uuid references participants(id) on delete cascade,
    requested_at timestamptz not null default now(),
    expires_at timestamptz not null,
    participant_status text,
    seat_left_at timestamptz,
    episode_status text,
    delivery text,
    delivered_at timestamptz,
    sockets integer,
    unavailable_reason text
);
create index live_introspection_requests_participant_idx
    on live_introspection_requests (tenant_id, episode_id, participant_id, expires_at);
create index live_introspection_requests_episode_idx
    on live_introspection_requests (tenant_id, episode_id, requested_at);

-- Sync listens on chalk_live_requests the way it does for publications; a lost
-- notification leaves delivery null, so there is no polling to fall back on.
-- +goose StatementBegin
create function notify_live_introspection_request() returns trigger
language plpgsql as $$
begin
    perform pg_notify(
        'chalk_live_requests',
        new.tenant_id::text || ':' || new.episode_id::text || ':' || new.id::text
    );
    return new;
end;
$$;
-- +goose StatementEnd

create trigger live_introspection_request_notify
after insert on live_introspection_requests
for each row execute function notify_live_introspection_request();

-- +goose Down
drop trigger live_introspection_request_notify on live_introspection_requests;
drop function notify_live_introspection_request();
drop table live_introspection_requests;
drop table diagnostic_uploads;
drop table problem_reports;
