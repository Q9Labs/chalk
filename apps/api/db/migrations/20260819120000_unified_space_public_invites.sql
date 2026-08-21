-- +goose Up

create table space_public_invites (
    tenant_id uuid not null,
    space_id uuid not null,
    handle bytea not null,
    generation bigint not null default 1,
    state_epoch bigint not null default 1,
    enabled boolean not null default true,
    public_role text not null default 'collaborator',
    admission_mode text not null default 'open',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    rotated_at timestamptz,
    disabled_at timestamptz,
    last_actor_id uuid references users(id),
    last_rotation_request_key text,
    primary key (tenant_id, space_id),
    unique (handle),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    check (octet_length(handle) = 32),
    check (generation > 0),
    check (state_epoch > 0),
    check (public_role = 'collaborator'),
    check (admission_mode in ('open', 'knock', 'members_only')),
    check (last_rotation_request_key is null or octet_length(last_rotation_request_key) between 16 and 128)
);
create index space_public_invites_handle_idx on space_public_invites(handle);

create table space_public_arrivals (
    arrival_handle uuid primary key,
    tenant_id uuid not null,
    space_id uuid not null,
    invite_handle bytea not null,
    invite_generation bigint not null,
    invite_state_epoch bigint not null,
    identity_mode text not null check (identity_mode in ('account', 'guest')),
    display_name text not null,
    guest_credential_hash bytea,
    account_id uuid references users(id),
    credential_family text,
    idempotency_key text not null,
    idempotency_fingerprint bytea not null,
    state text not null check (state in ('pending', 'admitted', 'rejected', 'left', 'unavailable')),
    episode_id uuid,
    participant_id uuid,
    participant_generation bigint,
    provider text,
    provider_subject text,
    expires_at timestamptz not null,
    terminal_reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    terminal_at timestamptz,
    unique (tenant_id, space_id, idempotency_key),
    unique (tenant_id, space_id, arrival_handle),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id)
        references space_public_invites(tenant_id, space_id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    foreign key (tenant_id, space_id, episode_id, participant_id, participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (octet_length(invite_handle) = 32),
    check (invite_generation > 0 and invite_state_epoch > 0),
    check (octet_length(display_name) between 1 and 256 and display_name = btrim(display_name)),
    check (octet_length(idempotency_fingerprint) = 32),
    check (guest_credential_hash is null or octet_length(guest_credential_hash) = 32),
    check (identity_mode = 'guest' or (account_id is not null and guest_credential_hash is null)),
    check (identity_mode = 'account' or (account_id is null and guest_credential_hash is not null)),
    check (participant_generation is null or participant_generation > 0),
    check ((provider is null) = (provider_subject is null)),
    check (provider is null or octet_length(provider) between 1 and 128),
    check (provider_subject is null or octet_length(provider_subject) between 1 and 256),
    check (
        (state in ('pending', 'rejected', 'unavailable')
         and episode_id is null and participant_id is null and participant_generation is null
         and provider is null and provider_subject is null)
        or
        (state in ('admitted', 'left')
         and episode_id is not null and participant_id is not null and participant_generation is not null
         and provider is not null and provider_subject is not null)
    )
);
create index space_public_arrivals_expiry_idx on space_public_arrivals(expires_at, state);
create index space_public_arrivals_space_state_idx on space_public_arrivals(tenant_id, space_id, state, created_at);

create table space_public_admission_requests (
    request_handle uuid primary key,
    arrival_handle uuid not null,
    tenant_id uuid not null,
    space_id uuid not null,
    display_name text not null,
    state text not null check (state in ('pending', 'approved', 'denied', 'expired', 'invalidated')),
    requested_at timestamptz not null default now(),
    expires_at timestamptz not null,
    decided_at timestamptz,
    decided_by uuid references users(id),
    decision_request_key text,
    unique (tenant_id, space_id, request_handle),
    unique (arrival_handle),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, arrival_handle)
        references space_public_arrivals(tenant_id, space_id, arrival_handle)
        on delete cascade,
    check (octet_length(display_name) between 1 and 256 and display_name = btrim(display_name)),
    check (decision_request_key is null or octet_length(decision_request_key) between 16 and 128)
);
create index space_public_admission_requests_pending_idx
    on space_public_admission_requests(tenant_id, space_id, requested_at)
    where state = 'pending';

create table auto_space_lifecycles (
    tenant_id uuid not null,
    space_id uuid not null,
    deadline_at timestamptz not null,
    creator_arrival_handle uuid,
    state text not null check (state in ('active', 'archiving', 'archived')),
    claim_expires_at timestamptz,
    next_retry_at timestamptz,
    retry_count integer not null default 0,
    last_error_family text,
    archive_completed_at timestamptz,
    journey_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, creator_arrival_handle)
        references space_public_arrivals(tenant_id, space_id, arrival_handle)
        on delete restrict,
    check (retry_count >= 0),
    check (last_error_family is null or octet_length(last_error_family) between 1 and 64),
    check ((state = 'archiving') = (claim_expires_at is not null)),
    check (state <> 'archived' or archive_completed_at is not null)
);
create index auto_space_lifecycles_due_idx
    on auto_space_lifecycles(deadline_at, next_retry_at, claim_expires_at)
    where state <> 'archived';

-- +goose Down

drop table auto_space_lifecycles;
drop table space_public_admission_requests;
drop table space_public_arrivals;
drop table space_public_invites;
