-- +goose Up
alter table room_sessions
    add column whiteboard_role_capabilities jsonb not null
        default '{"host":["drawWhiteboard","manageWhiteboard"],"cohost":["drawWhiteboard","manageWhiteboard"],"participant":["drawWhiteboard"]}'::jsonb,
    add constraint room_sessions_whiteboard_role_capabilities_check
        check (
            jsonb_typeof(whiteboard_role_capabilities) = 'object'
            and whiteboard_role_capabilities ?& array['host', 'cohost', 'participant']
            and whiteboard_role_capabilities - array['host', 'cohost', 'participant'] = '{}'::jsonb
            and jsonb_typeof(whiteboard_role_capabilities -> 'host') = 'array'
            and jsonb_typeof(whiteboard_role_capabilities -> 'cohost') = 'array'
            and jsonb_typeof(whiteboard_role_capabilities -> 'participant') = 'array'
            and not jsonb_path_exists(
                whiteboard_role_capabilities,
                '$.*[*] ? (@ != "drawWhiteboard" && @ != "manageWhiteboard")'
            )
        );

create table sync_whiteboard_scenes (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    scene_id uuid not null,
    is_current boolean not null default true,
    revision bigint not null default 0,
    app_state jsonb,
    element_count integer not null default 0,
    encoded_bytes bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, session_id, scene_id),
    unique (tenant_id, room_id, session_id, scene_id),
    foreign key (tenant_id, room_id, session_id)
        references room_sessions(tenant_id, room_id, id)
        on delete cascade,
    check (revision >= 0),
    check (element_count between 0 and 10000),
    check (encoded_bytes between 0 and 67108864),
    check (
        app_state is null
        or (
            jsonb_typeof(app_state) = 'object'
            and app_state ? 'view_background_color'
            and app_state - 'view_background_color' = '{}'::jsonb
            and jsonb_typeof(app_state -> 'view_background_color') = 'string'
        )
    )
);

create unique index sync_whiteboard_scenes_current_idx
    on sync_whiteboard_scenes(tenant_id, session_id)
    where is_current;

create table sync_whiteboard_elements (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    scene_id uuid not null,
    element_id text not null,
    element_type text not null,
    version bigint not null,
    version_nonce bigint not null,
    element_index text not null,
    is_deleted boolean not null,
    payload jsonb not null,
    encoded_bytes integer not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, session_id, scene_id, element_id),
    foreign key (tenant_id, room_id, session_id, scene_id)
        references sync_whiteboard_scenes(tenant_id, room_id, session_id, scene_id)
        on delete cascade,
    check (octet_length(element_id) between 1 and 128),
    check (octet_length(element_type) between 1 and 64),
    check (octet_length(element_index) between 1 and 64),
    check (version >= 0 and version_nonce >= 0),
    check (jsonb_typeof(payload) = 'object'),
    check (encoded_bytes between 2 and 16384)
);

create index sync_whiteboard_elements_snapshot_idx
    on sync_whiteboard_elements(tenant_id, session_id, scene_id, element_index, element_id);

create table sync_whiteboard_permissions (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    participant_session_id uuid not null,
    can_draw boolean not null,
    granted_by_participant_session_id uuid not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, session_id, participant_session_id),
    foreign key (tenant_id, room_id, session_id, participant_session_id)
        references participants(tenant_id, room_id, session_id, id)
        on delete cascade,
    foreign key (tenant_id, room_id, session_id, granted_by_participant_session_id)
        references participants(tenant_id, room_id, session_id, id)
        on delete restrict
);

create table sync_whiteboard_operation_receipts (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    participant_session_id uuid not null,
    submitted_generation bigint not null,
    operation_id text not null,
    request_fingerprint bytea not null,
    operation_name text not null,
    outcome text not null,
    scene_id uuid not null,
    revision bigint not null,
    event_elements jsonb,
    event_encoded_bytes integer not null default 0,
    completed_at timestamptz not null default now(),
    primary key (tenant_id, session_id, participant_session_id, operation_id),
    foreign key (
        tenant_id, room_id, session_id,
        participant_session_id, submitted_generation
    ) references participants(
        tenant_id, room_id, session_id,
        id, generation
    ) on delete restrict,
    check (octet_length(operation_id) between 16 and 64),
    check (octet_length(request_fingerprint) = 32),
    check (operation_name in ('submit_update', 'clear', 'set_draw_permission')),
    check (outcome = 'committed'),
    check (revision >= 0),
    check (
        (
            operation_name = 'submit_update'
            and jsonb_typeof(event_elements) = 'array'
            and event_encoded_bytes between 2 and 262144
        )
        or (
            operation_name <> 'submit_update'
            and event_elements is null
            and event_encoded_bytes = 0
        )
    )
);

create index sync_whiteboard_operation_receipts_retention_idx
    on sync_whiteboard_operation_receipts(tenant_id, session_id, completed_at);

create table sync_whiteboard_files (
    upload_id uuid primary key,
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    scene_id uuid not null,
    participant_session_id uuid not null,
    participant_generation bigint not null,
    file_id text not null,
    object_key text not null unique,
    mime_type text not null,
    byte_length bigint not null,
    sha256 bytea not null,
    status text not null default 'pending',
    immutable_object_identity text,
    expires_at timestamptz not null,
    finalized_at timestamptz,
    cleanup_claim_token uuid,
    cleanup_claimed_until timestamptz,
    cleanup_attempts integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, session_id, scene_id, file_id),
    foreign key (tenant_id, room_id, session_id, scene_id)
        references sync_whiteboard_scenes(tenant_id, room_id, session_id, scene_id)
        on delete cascade,
    foreign key (
        tenant_id, room_id, session_id,
        participant_session_id, participant_generation
    ) references participants(
        tenant_id, room_id, session_id,
        id, generation
    ) on delete restrict,
    check (octet_length(file_id) between 1 and 128),
    check (octet_length(object_key) between 1 and 1024),
    check (octet_length(mime_type) between 1 and 255),
    check (byte_length between 1 and 268435456),
    check (octet_length(sha256) = 32),
    check (status in ('pending', 'finalizing', 'ready', 'failed')),
    check (cleanup_attempts >= 0),
    check ((cleanup_claim_token is null) = (cleanup_claimed_until is null)),
    check (
        (status = 'pending' and immutable_object_identity is null and finalized_at is null)
        or (status = 'finalizing' and immutable_object_identity is null and finalized_at is null)
        or (status = 'ready' and immutable_object_identity is not null and finalized_at is not null)
        or status = 'failed'
    )
);

create index sync_whiteboard_files_pending_cleanup_idx
    on sync_whiteboard_files(expires_at, cleanup_claimed_until, tenant_id, session_id)
    where status in ('pending', 'finalizing', 'failed');

create index sync_whiteboard_files_session_cleanup_idx
    on sync_whiteboard_files(tenant_id, session_id, cleanup_claimed_until);

-- +goose Down
drop index sync_whiteboard_files_session_cleanup_idx;
drop index sync_whiteboard_files_pending_cleanup_idx;
drop table sync_whiteboard_files;
drop index sync_whiteboard_operation_receipts_retention_idx;
drop table sync_whiteboard_operation_receipts;
drop table sync_whiteboard_permissions;
drop index sync_whiteboard_elements_snapshot_idx;
drop table sync_whiteboard_elements;
drop index sync_whiteboard_scenes_current_idx;
drop table sync_whiteboard_scenes;

alter table room_sessions
    drop constraint room_sessions_whiteboard_role_capabilities_check,
    drop column whiteboard_role_capabilities;
