-- +goose Up
create table session_create_requests (
    tenant_id uuid not null,
    room_id uuid not null,
    request_key text not null,
    request_fingerprint bytea not null,
    session_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, room_id, request_key),
    constraint session_create_requests_session_context_fkey
        foreign key (tenant_id, room_id, session_id)
        references room_sessions(tenant_id, room_id, id)
        on delete restrict
        deferrable initially deferred,
    constraint session_create_requests_request_key_check
        check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    constraint session_create_requests_request_fingerprint_check
        check (octet_length(request_fingerprint) = 32)
);

-- +goose Down
drop table session_create_requests;
