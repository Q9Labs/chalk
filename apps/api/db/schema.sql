create table tenants (
    id uuid primary key,
    name text not null,
    default_region text,
    -- cf_sfu, cf_rtk, mediasoup
    default_media_plane text,
    logo_key text,
    website text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create index tenants_created_at_id_idx on tenants(created_at desc, id desc);

create table users (
    id uuid primary key,
    name text not null,
    email text not null unique,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create table memberships (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    user_id uuid not null references users(id),
    -- owner, admin, member, viewer
    role text not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique(tenant_id, user_id)
);

create table auth_identities (
    id uuid primary key,
    user_id uuid not null references users(id),
    -- google, apple, password
    provider text not null,
    provider_subject text not null,
    password_hash text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique(provider, provider_subject)
);

create table login_sessions (
    id uuid primary key,
    user_id uuid not null references users(id),
    token_hash text not null,
    user_agent text,
    device_name text,
    ip_address inet,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique(token_hash)
);

create table api_keys (
    id uuid primary key,
    name text not null,
    scopes text[] not null,
    tenant_id uuid not null references tenants(id),
    key_hash text not null,
    key_prefix text not null,
    created_by_user_id uuid references users(id),
    last_used_ip inet,
    last_used_at timestamptz,
    revoked_at timestamptz,
    expires_at timestamptz not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (key_prefix)
);

-- Participant tokens: JWT/JWS
-- Algorithm: EdDSA / Ed25519
-- Key model: tenant signs with private key, Chalk stores public
-- key
-- Token TTL: short, like 5-15 minutes or longer like 60 minutes
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

create table rooms (
    id uuid primary key,
    name text not null,
    tenant_id uuid not null references tenants(id),
    status text not null,
    slug text not null,
    -- cf_sfu, cf_rtk, mediasoup
    media_plane text not null,
    metadata jsonb,
    -- recurring_policy is null for non-recurring rooms.
    -- Example:
    -- {
    --   "timezone": "Asia/Dubai",
    --   "dtstart": "2026-07-01T09:00:00",
    --   "rrule": "FREQ=WEEKLY;BYDAY=MO,WE"
    -- }
    recurring_policy jsonb,
    created_by_user_id uuid references users(id),
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, slug)
);

create table room_sessions (
    id uuid primary key,
    status text not null,
    metadata jsonb,
    room_id uuid not null references rooms(id),
    tenant_id uuid not null references tenants(id),
    created_by_user_id uuid references users(id),
    started_at timestamptz,
    ended_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create table participants (
    id uuid primary key,
    name text,
    metadata jsonb,
    capabilities text[] not null,
    tenant_id uuid not null references tenants(id),
    room_id uuid not null references rooms(id),
    session_id uuid not null references room_sessions(id),
    user_id uuid references users(id),
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create table recordings (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    room_id uuid not null references rooms(id),
    session_id uuid not null references room_sessions(id),
    -- pending (should be rare ideally), processing, completed, failed
    status text not null,
    -- s3, cf, do
    storage_provider text not null,
    storage_key text,
    metadata jsonb,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create table transcriptions (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    recording_id uuid not null references recordings(id),
    room_id uuid not null references rooms(id),
    session_id uuid not null references room_sessions(id),
    -- pending (should be rare ideally), processing, completed, failed
    status text not null,
    -- cf, openrouter, openai, groq
    provider text not null,
    model text not null,
    languages text[] not null,
    text text,
    metadata jsonb,
    completed_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
