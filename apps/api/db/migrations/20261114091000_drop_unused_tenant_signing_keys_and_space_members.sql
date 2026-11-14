-- +goose Up
-- Both tables are empty in production and no code reads or writes them. Participant tokens do not
-- use tenant_signing_keys, and Space access runs through space_roles and participants, not
-- space_members. The running release never names either table, so the drop is safe while it is live.
-- chalk:removed-in #1387
drop table if exists tenant_signing_keys;
drop table if exists space_members;

-- +goose Down
create table tenant_signing_keys (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    key_id text not null,
    algorithm text not null,
    public_key_jwk jsonb not null,
    last_used_at timestamptz,
    created_by_api_key_id uuid references api_keys(id),
    created_by_user_id uuid references users(id),
    revoked_at timestamptz,
    expires_at timestamptz not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (key_id)
);

create table space_members (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    space_id uuid not null,
    identity_id uuid not null,
    role_id uuid not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (space_id, identity_id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, role_id)
        references space_roles(tenant_id, space_id, id)
        on delete restrict,
    foreign key (tenant_id, identity_id)
        references identities(tenant_id, id)
        on delete restrict
);
create index space_members_space_created_at_id_idx on space_members(space_id, created_at desc, id desc);
