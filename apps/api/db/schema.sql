-- Schema snapshot through migration 20261127110000.
create table tenants (
    recording_render_mode text not null default 'on_demand' check (recording_render_mode in ('on_demand', 'automatic')),
    id uuid primary key,
    name text not null,
    default_region text,
    -- Retained for the public contract and rollback; new media uses chalk_sfu.
    default_media_plane text,
    -- Set only by the operator command; a trigger clears it whenever the default changes otherwise.
    default_media_plane_approved boolean not null default false,
    -- A Tenant can disable media with {"enabled": false}.
    -- Previous-release provider documents can remain stored for rollback.
    media_plane_provider_config jsonb,
    ai_provider_config jsonb,
    -- {
    --   "enabled": true,
    --   "provider": "cloudflare_r2" | "aws_s3",
    --   "mode": "chalk_managed" | "tenant_managed",
    --   "bucket": "chalk-recordings",
    --   "prefix": "recordings/",
    --   "access_key_id": string,
    --   "secret_access_key": string
    -- }
    storage_provider_config jsonb,
    cors_allowed_origins text[] not null default '{}',
    constraint tenants_cors_allowed_origins_count_check
        check (cardinality(cors_allowed_origins) <= 32),
    logo_key text,
    website text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create index tenants_created_at_id_idx on tenants(created_at desc, id desc);

create table tenant_artifact_policies (
    transcript_language text not null default 'auto' check (transcript_language in ('auto','af','am','ar','as','az','ba','be','bg','bn','bo','br','bs','ca','cs','cy','da','de','el','en','es','et','eu','fa','fi','fo','fr','gl','gu','ha','haw','he','hi','hr','ht','hu','hy','id','is','it','ja','jw','ka','kk','km','kn','ko','la','lb','ln','lo','lt','lv','mg','mi','mk','ml','mn','mr','ms','mt','my','ne','nl','nn','no','oc','pa','pl','ps','pt','ro','ru','sa','sd','si','sk','sl','sn','so','sq','sr','su','sv','sw','ta','te','tg','th','tk','tl','tr','tt','uk','ur','uz','vi','yi','yo','yue','zh')),
    tenant_id uuid primary key references tenants(id) on delete cascade,
    transcription_ceiling text not null default 'automatic',
    transcription_default_mode text not null default 'automatic',
    provider_policy_version text not null default 'chalk-automatic-v1',
    recording_retention_seconds bigint not null default 2592000,
    transcript_retention_seconds bigint not null default 0,
    source_window_seconds bigint not null default 86400,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint tenant_artifact_policies_ceiling_check
        check (transcription_ceiling in ('disabled', 'on_demand', 'automatic')),
    constraint tenant_artifact_policies_default_check
        check (transcription_default_mode in ('disabled', 'on_demand', 'automatic')),
    constraint tenant_artifact_policies_default_ceiling_check
        check (
            (transcription_ceiling = 'disabled' and transcription_default_mode = 'disabled')
            or (transcription_ceiling = 'on_demand' and transcription_default_mode in ('disabled', 'on_demand'))
            or (transcription_ceiling = 'automatic')
        ),
    constraint tenant_artifact_policies_recording_retention_check
        check (recording_retention_seconds between 0 and 9223372036),
    constraint tenant_artifact_policies_transcript_retention_check
        check (transcript_retention_seconds between 0 and 9223372036),
    constraint tenant_artifact_policies_source_window_check
        check (
            (transcription_ceiling = 'disabled' and source_window_seconds = 0)
            or (transcription_ceiling in ('on_demand', 'automatic') and source_window_seconds between 1 and 2592000)
        ),
    constraint tenant_artifact_policies_provider_policy_check
        check (transcription_ceiling = 'disabled' or btrim(provider_policy_version) <> '')
);

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
    -- owner, collaborator, observer
    role text not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique(tenant_id, user_id)
);
create index memberships_tenant_created_at_id_idx on memberships(tenant_id, created_at desc, id desc);
create index memberships_user_id_idx on memberships(user_id);

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

-- API-key mutation reservations contain no secret material. They make retries
-- deterministic while preserving one-time secret display semantics.
create table api_key_mutation_requests (
    tenant_id uuid not null references tenants(id),
    operation text not null check (operation in ('create', 'rotate')),
    request_key text not null,
    request_fingerprint bytea not null,
    api_key_id uuid references api_keys(id),
    created_at timestamptz not null default now(),
    primary key (tenant_id, operation, request_key)
);


-- Self-hosted OAuth for the hosted MCP server. Every bearer value (authorization
-- request handle, code, access token, refresh token) is stored as a SHA-256 hash.
create table mcp_oauth_clients (
    id uuid primary key,
    client_id text not null unique,
    client_name text not null,
    redirect_uris text[] not null,
    created_at timestamptz not null default now(),
    constraint mcp_oauth_clients_redirect_uris_count_check
        check (cardinality(redirect_uris) between 1 and 5)
);

create table mcp_oauth_authorization_requests (
    request_hash text primary key,
    client_id uuid not null references mcp_oauth_clients(id),
    redirect_uri text not null,
    -- False when the client omitted redirect_uri and the registered one was used (RFC 6749 4.1.3).
    redirect_uri_supplied boolean not null,
    state text,
    code_challenge text not null,
    scopes text[] not null,
    resource text not null,
    expires_at timestamptz not null,
    decided_at timestamptz,
    created_at timestamptz not null default now()
);

-- A grant is one connected app: a tenant's consent for one client and resource.
create table mcp_oauth_grants (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    client_id uuid not null references mcp_oauth_clients(id),
    scopes text[] not null,
    resource text not null,
    approved_by_service_id text not null,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz not null default now()
);

create index mcp_oauth_grants_tenant_idx
    on mcp_oauth_grants (tenant_id, created_at desc)
    where revoked_at is null;

create table mcp_oauth_codes (
    code_hash text primary key,
    grant_id uuid not null references mcp_oauth_grants(id) on delete cascade,
    redirect_uri text not null,
    -- False when the client omitted redirect_uri and the registered one was used (RFC 6749 4.1.3).
    redirect_uri_supplied boolean not null,
    code_challenge text not null,
    expires_at timestamptz not null,
    consumed_at timestamptz
);

create index mcp_oauth_codes_grant_idx on mcp_oauth_codes (grant_id);

create table mcp_oauth_tokens (
    token_hash text primary key,
    kind text not null check (kind in ('access', 'refresh')),
    grant_id uuid not null references mcp_oauth_grants(id) on delete cascade,
    resource text not null,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz not null default now()
);

create index mcp_oauth_tokens_grant_idx on mcp_oauth_tokens (grant_id);
create index mcp_oauth_tokens_expiry_idx on mcp_oauth_tokens (expires_at);

create table spaces (
    id uuid primary key,
    name text not null,
    tenant_id uuid not null references tenants(id),
    slug text not null,
    -- chalk_sfu for new Spaces; historical snapshots retain their original binding.
    media_plane text not null,
    -- The Space's own plane choice, with the media_plane value it was written against; null inherits the Tenant, then the platform default.
    media_plane_setting_written text check (media_plane_setting_written in ('cf_sfu', 'chalk_sfu')),
    media_plane_setting_against text,
    constraint spaces_media_plane_setting_witness check ((media_plane_setting_written is null) = (media_plane_setting_against is null)),
    -- What readers use: the choice while media_plane still equals what it was written against, else the older release's media_plane.
    media_plane_setting text generated always as (
        case
            when media_plane_setting_written is null then null
            when media_plane_setting_against = btrim(media_plane) then media_plane_setting_written
            when btrim(media_plane) in ('cf_sfu', 'chalk_sfu') then btrim(media_plane)
            else null
        end
    ) stored,
    metadata jsonb,
    -- recurring_policy is null for non-recurring spaces.
    -- Example:
    -- {
    --   "timezone": "Asia/Dubai",
    --   "dtstart": "2026-07-01T09:00:00",
    --   "rrule": "FREQ=WEEKLY;BYDAY=MO,WE"
    -- }
    recurring_policy jsonb,
    admission_policy jsonb not null default '{"mode":"open"}'::jsonb
        check (jsonb_typeof(admission_policy) = 'object' and admission_policy ->> 'mode' in ('open', 'knock', 'members_only')),
    recording_policy text not null default 'automatic'
        check (recording_policy in ('disabled', 'manual', 'automatic')),
    transcription_policy text not null default 'automatic'
        check (transcription_policy in ('disabled', 'on_demand', 'automatic')),
    transcript_language text check (transcript_language in ('auto','af','am','ar','as','az','ba','be','bg','bn','bo','br','bs','ca','cs','cy','da','de','el','en','es','et','eu','fa','fi','fo','fr','gl','gu','ha','haw','he','hi','hr','ht','hu','hy','id','is','it','ja','jw','ka','kk','km','kn','ko','la','lb','ln','lo','lt','lv','mg','mi','mk','ml','mn','mr','ms','mt','my','ne','nl','nn','no','oc','pa','pl','ps','pt','ro','ru','sa','sd','si','sk','sl','sn','so','sq','sr','su','sv','sw','ta','te','tg','th','tk','tl','tr','tt','uk','ur','uz','vi','yi','yo','yue','zh')),
    focus jsonb not null default '{"enabled":false}'::jsonb,
    default_episode_duration_seconds integer not null default 86400,
    maximum_episode_duration_seconds integer not null default 86400,
    linger_window_seconds integer not null default 0,
    created_by_user_id uuid references users(id),
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    archived_at timestamptz,
    unique (tenant_id, slug),
    unique (tenant_id, id),
    check (default_episode_duration_seconds between 60 and 604800),
    check (maximum_episode_duration_seconds between 60 and 604800),
    check (default_episode_duration_seconds <= maximum_episode_duration_seconds),
    check (linger_window_seconds >= 0),
    constraint spaces_focus_check check (
        jsonb_typeof(focus) = 'object'
        and focus - 'enabled' = '{}'::jsonb
        and jsonb_typeof(focus -> 'enabled') = 'boolean'
    )
);
create index spaces_tenant_created_at_id_idx on spaces(tenant_id, created_at desc, id desc);
create index spaces_tenant_archived_created_at_id_idx on spaces(tenant_id, archived_at, created_at desc, id desc);

create table space_create_requests (
    tenant_id uuid not null,
    request_key text not null,
    request_fingerprint bytea not null,
    space_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, request_key),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete no action
        deferrable initially deferred,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32)
);
create index space_create_requests_space_idx on space_create_requests(tenant_id, space_id);

create function valid_capabilities(value text[])
returns boolean
language sql
immutable
strict
as $$
    select value <@ array[
        'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
        'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
        'drawWhiteboard', 'manageWhiteboard', 'manageAdmission',
        'assignRoles', 'muteOthers', 'stopVideoOthers', 'stopScreenOthers',
        'requestMediaOthers', 'removeParticipant', 'manageRecording',
        'startEpisode', 'extendEpisode', 'endEpisode', 'manageMembers',
        'clearSpaceContent', 'focus.view', 'focus.manage', 'focus.exempt'
    ]::text[]
        and cardinality(value) <= 26
        and cardinality(value) = (select count(distinct capability) from unnest(value) as capability)
$$;

create table identities (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    kind text not null check (kind in ('user', 'agent')),
    external_id text not null,
    display_name text not null,
    metadata jsonb,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, external_id),
    unique (tenant_id, id)
);

create table space_roles (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    space_id uuid not null,
    name text not null,
    capabilities text[] not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, space_id, name),
    unique (tenant_id, space_id, id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    check (name <> '' and cardinality(capabilities) > 0 and valid_capabilities(capabilities))
);

create function validate_episode_config_snapshot(value jsonb)
returns boolean
language sql
immutable
strict
as $$
    select jsonb_typeof(value) = 'object'
        and jsonb_typeof(value -> 'roles') = 'object'
        and not exists (
            select 1
            from jsonb_each(value -> 'roles') role_entry
            where jsonb_typeof(role_entry.value) <> 'array'
                or not valid_capabilities(array(select jsonb_array_elements_text(role_entry.value)))
        )
        and jsonb_typeof(value -> 'admission_policy') = 'object'
        and value -> 'admission_policy' ->> 'mode' in ('open', 'knock', 'members_only')
        and (value ->> 'default_episode_duration_seconds')::integer between 60 and 604800
        and (value ->> 'maximum_episode_duration_seconds')::integer between 60 and 604800
        and (value ->> 'default_episode_duration_seconds')::integer <=
            (value ->> 'maximum_episode_duration_seconds')::integer
        and (value ->> 'linger_window_seconds')::integer >= 0
        and (
            not (value ? 'artifact_policy')
            or (
                jsonb_typeof(value -> 'artifact_policy') = 'object'
                and value -> 'artifact_policy' ->> 'schema_version' = 'episode_config.v2'
                and jsonb_typeof(value -> 'artifact_policy' -> 'recording') = 'object'
                and value -> 'artifact_policy' -> 'recording' ->> 'mode' in ('disabled', 'manual', 'automatic')
                and value -> 'artifact_policy' -> 'recording' ->> 'profile' = 'composite_720p_v1'
                and jsonb_typeof(value -> 'artifact_policy' -> 'recording' -> 'retention_seconds') = 'number'
                and (value -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint between 0 and 9223372036
                and jsonb_typeof(value -> 'artifact_policy' -> 'transcription') = 'object'
                and value -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('disabled', 'on_demand', 'automatic')
                and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'retention_seconds') = 'number'
                and (value -> 'artifact_policy' -> 'transcription' ->> 'retention_seconds')::bigint between 0 and 9223372036
                and (
                    (
                        value -> 'artifact_policy' -> 'transcription' ->> 'mode' = 'disabled'
                        and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'source_window_seconds') = 'number'
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint = 0
                    )
                    or (
                        value -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('on_demand', 'automatic')
                        and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'source_window_seconds') = 'number'
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint between 1 and 2592000
                        and value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version' is not null
                        and btrim(value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version') <> ''
                    )
                )
            )
        )
$$;

-- A zero recording retention was valid before deferred Export but did not
-- govern rendered MP4 lifetime. Keep those immutable legacy snapshots intact
-- while giving their newly deferred source and MP4 a capture-anchored 30-day
-- operational window. Explicit positive snapshot values remain exact.
create function recording_deferred_retention_seconds(config_snapshot jsonb)
returns bigint
language sql
immutable
strict
as $$
    select coalesce(
        nullif((config_snapshot -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint, 0),
        2592000
    );
$$;

-- Transcription uses its immutable source window, never extending beyond the
-- recording source window that also fences deferred Export.
create function recording_transcription_source_window_seconds(config_snapshot jsonb)
returns bigint
language sql
immutable
strict
as $$
    select least(
        recording_deferred_retention_seconds(config_snapshot),
        coalesce((config_snapshot -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint, 0)
    );
$$;

create table episodes (
    id uuid primary key,
    status text not null check (status in ('active', 'ending', 'ended')),
    metadata jsonb,
    space_id uuid not null,
    tenant_id uuid not null references tenants(id),
    created_by_user_id uuid references users(id),
    started_at timestamptz,
    ended_at timestamptz,
    config_snapshot jsonb not null check (validate_episode_config_snapshot(config_snapshot)),
    end_reason text check (end_reason in ('ended_by_participant', 'tenant_recovery', 'linger_expired', 'maximum_duration')),
    deadline_at timestamptz not null default (now() + interval '24 hours'),
    deadline_generation bigint not null default 1,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, space_id, id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete restrict,
    check (
        deadline_generation > 0
    )
);
create index episodes_tenant_space_created_at_id_idx on episodes(tenant_id, space_id, created_at desc, id desc);
create index episodes_sync_ended_cleanup_idx
    on episodes(ended_at, tenant_id, id)
    where status = 'ended';
create unique index episodes_one_live_per_space_idx
    on episodes(tenant_id, space_id)
    where status in ('active', 'ending');

create function protect_immutable_episode_policy()
returns trigger
language plpgsql
as $$
declare
    old_binding jsonb := old.config_snapshot -> 'media_plane_binding';
    new_binding jsonb := new.config_snapshot -> 'media_plane_binding';
    placement constant text[] := array['node', 'node_incarnation', 'placement_reason', 'generation', 'previous_allocations'];
begin
    if new.config_snapshot is distinct from old.config_snapshot then
        if not coalesce(
            (new.config_snapshot - 'media_plane_binding') = (old.config_snapshot - 'media_plane_binding')
            and jsonb_typeof(old_binding) = 'object'
            and jsonb_typeof(new_binding) = 'object'
            and old_binding ->> 'provider' = 'chalk_sfu'
            and ((new_binding - placement) = (old_binding - placement)
                 or (new_binding - placement) = (old_binding - placement - 'selected_by'))
            and coalesce((new_binding ->> 'generation')::bigint, 0) = coalesce((old_binding ->> 'generation')::bigint, 0) + 1,
            false
        ) then
            raise exception 'Episode config_snapshot is immutable';
        end if;
    end if;

    if new.deadline_at is distinct from old.deadline_at
        then
        if new.deadline_generation <> old.deadline_generation + 1 then
            raise exception 'Episode deadline mutation must advance generation exactly once';
        end if;
    elsif new.deadline_generation is distinct from old.deadline_generation then
            raise exception 'Episode deadline generation cannot change without a deadline mutation';
    end if;

    return new;
end;
$$;

create trigger episodes_immutable_config_snapshot
before update on episodes
for each row execute function protect_immutable_episode_policy();

create function record_initial_episode_deadline() returns trigger
language plpgsql as $$
begin
    if old.deadline_generation = 1 then
        update sync_episode_control
        set initial_deadline_at_ms = floor(extract(epoch from old.deadline_at) * 1000)::bigint,
            initial_deadline_generation = 1
        where tenant_id = old.tenant_id and episode_id = old.id and initial_deadline_at_ms is null;
    end if;
    return new;
end;
$$;

create trigger episodes_record_initial_deadline
after update of deadline_at on episodes
for each row when (old.deadline_at is distinct from new.deadline_at)
execute function record_initial_episode_deadline();

-- When each Space was last active: when it was created, or when an Episode in it was created, started or ended,
-- whichever is latest. Triggers keep it, so every writer of Spaces and Episodes keeps it current.
create table space_activity (
    tenant_id uuid not null,
    space_id uuid not null,
    active_at timestamptz not null,
    primary key (tenant_id, space_id),
    foreign key (tenant_id, space_id) references spaces(tenant_id, id) on delete cascade
);
create index space_activity_tenant_active_at_idx on space_activity(tenant_id, active_at desc, space_id desc);

create function record_space_created()
returns trigger
language plpgsql
as $$
begin
    insert into space_activity (tenant_id, space_id, active_at)
    values (new.tenant_id, new.id, new.created_at)
    on conflict (tenant_id, space_id) do nothing;
    return null;
end;
$$;

create function record_episode_activity()
returns trigger
language plpgsql
as $$
begin
    insert into space_activity (tenant_id, space_id, active_at)
    values (new.tenant_id, new.space_id, coalesce(new.ended_at, new.started_at, new.created_at))
    on conflict (tenant_id, space_id) do update set active_at = greatest(space_activity.active_at, excluded.active_at);
    return null;
end;
$$;

create trigger spaces_record_activity
after insert on spaces
for each row execute function record_space_created();

create trigger episodes_record_activity
after insert or update of started_at, ended_at on episodes
for each row execute function record_episode_activity();

create table episode_create_requests (
    tenant_id uuid not null,
    space_id uuid not null,
    request_key text not null,
    request_fingerprint bytea not null,
    episode_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id, request_key),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict
        deferrable initially deferred,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32)
);

create table participants (
    id uuid primary key,
    name text,
    metadata jsonb,
    capabilities text[] not null,
    tenant_id uuid not null references tenants(id),
    space_id uuid not null,
    episode_id uuid not null,
    account_id uuid references users(id) on delete restrict,
    identity_id uuid,
    media_connection_id text,
    media_connection_generation bigint,
    generation bigint not null check (generation > 0),
    status text not null check (status in ('joining', 'active', 'leaving', 'left')),
    role text not null,
    joined_at timestamptz,
    left_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, space_id, episode_id, id),
    unique (tenant_id, space_id, episode_id, id, generation),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    foreign key (tenant_id, identity_id)
        references identities(tenant_id, id)
        on delete restrict,
    check (cardinality(capabilities) > 0 and valid_capabilities(capabilities))
);
create index participants_sync_active_episode_capacity_idx
    on participants(tenant_id, space_id, episode_id)
    where status in ('joining', 'active', 'leaving');
create index participants_admission_cleanup_active_idx
    on participants(tenant_id, episode_id, id)
    where status = 'active';
create unique index participants_dashboard_account_episode_idx
    on participants(tenant_id, episode_id, account_id)
    where account_id is not null and status in ('joining', 'active');
-- Chat limits apply to a person: the account, else the identity, else that one row.
create index participants_chat_person_idx
    on participants(tenant_id, space_id, (coalesce(account_id, identity_id, id)));
create function chat_person_participant_ids(p_tenant_id uuid, p_space_id uuid, p_participant_id uuid)
returns table (participant_id uuid)
language sql
stable
as $$
    select sibling.id
    from participants sender
    join participants sibling
        on sibling.tenant_id = sender.tenant_id
        and sibling.space_id = sender.space_id
        and coalesce(sibling.account_id, sibling.identity_id, sibling.id)
            = coalesce(sender.account_id, sender.identity_id, sender.id)
    where sender.tenant_id = p_tenant_id
        and sender.space_id = p_space_id
        and sender.id = p_participant_id
$$;

create table participant_media_refreshes (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null check (participant_generation > 0),
    request_hash bytea not null check (octet_length(request_hash) = 32),
    connection_id text not null,
    response_ciphertext bytea not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id, episode_id, participant_id, participant_generation, request_hash),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete cascade
);

create table sync_chat_streams (
    tenant_id uuid not null,
    space_id uuid not null,
    head_sequence bigint not null default 0,
    retained_floor_sequence bigint,
    message_count bigint not null default 0,
    message_bytes bigint not null default 0,
    attachment_count bigint not null default 0,
    attachment_bytes bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete restrict,
    check (
        head_sequence >= 0
        and message_count between 0 and 250000
        and message_bytes between 0 and 2147483648
        and attachment_count between 0 and 1000
        and attachment_bytes between 0 and 5368709120
        and (
            (
                head_sequence = 0
                and retained_floor_sequence is null
                and message_count = 0
                and message_bytes = 0
            )
            or (
                head_sequence > 0
                and retained_floor_sequence between 1 and head_sequence + 1
                and message_count = head_sequence - retained_floor_sequence + 1
            )
        )
    )
);

create table sync_chat_messages (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    sequence bigint not null,
    message_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    client_message_id text not null,
    request_fingerprint bytea not null,
    display_name text not null,
    message_text text not null,
    encoded_bytes bigint not null,
    created_at timestamptz not null,
    primary key (tenant_id, space_id, sequence),
    unique (tenant_id, space_id, message_id),
    unique (
        tenant_id,
        space_id,
        participant_id,
        participant_generation,
        client_message_id
    ),
    foreign key (tenant_id, space_id)
        references sync_chat_streams(tenant_id, space_id)
        on delete restrict,
    foreign key (
        tenant_id,
        space_id,
        episode_id,
        participant_id,
        participant_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (sequence > 0),
    check (octet_length(client_message_id) between 16 and 64),
    check (octet_length(request_fingerprint) = 32),
    check (octet_length(display_name) between 1 and 256),
    check (
        octet_length(message_text) between 0 and 16384
        and char_length(message_text) <= 4000
    ),
    check (encoded_bytes between 1 and 32768)
);
create index sync_chat_messages_space_created_at_idx
    on sync_chat_messages(tenant_id, space_id, created_at, sequence);
create index sync_chat_messages_episode_sequence_idx
    on sync_chat_messages(tenant_id, space_id, episode_id, sequence);
create index sync_chat_messages_participant_usage_idx
    on sync_chat_messages(tenant_id, space_id, participant_id) include (created_at, encoded_bytes);

create table sync_chat_attachments (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    attachment_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    client_attachment_id text not null,
    request_fingerprint bytea not null,
    upload_id uuid not null,
    object_key text not null,
    original_filename text not null,
    mime_type text not null,
    byte_length bigint not null,
    sha256 bytea not null,
    immutable_object_identity text,
    status text not null,
    expires_at timestamptz not null,
    message_sequence bigint,
    message_ordinal smallint,
    finalize_claim_token uuid,
    finalize_claimed_until timestamptz,
    finalize_attempts integer not null default 0,
    cleanup_claim_token uuid,
    cleanup_claimed_until timestamptz,
    cleanup_attempts integer not null default 0,
    finalized_at timestamptz,
    attached_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id, attachment_id),
    unique (upload_id),
    unique (object_key),
    unique (
        tenant_id,
        space_id,
        participant_id,
        participant_generation,
        client_attachment_id
    ),
    unique (tenant_id, space_id, message_sequence, message_ordinal),
    foreign key (tenant_id, space_id)
        references sync_chat_streams(tenant_id, space_id)
        on delete restrict,
    foreign key (
        tenant_id,
        space_id,
        episode_id,
        participant_id,
        participant_generation
    )
        references participants(
            tenant_id,
            space_id,
            episode_id,
            id,
            generation
        )
        on delete restrict,
    foreign key (tenant_id, space_id, message_sequence)
        references sync_chat_messages(tenant_id, space_id, sequence)
        on delete restrict,
    check (octet_length(client_attachment_id) between 16 and 64),
    check (octet_length(request_fingerprint) = 32),
    check (octet_length(object_key) between 1 and 1024),
    check (octet_length(original_filename) between 1 and 255),
    check (
        mime_type in (
            'image/png',
            'image/jpeg',
            'image/gif',
            'image/webp',
            'application/pdf',
            'text/plain',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/vnd.oasis.opendocument.text',
            'application/vnd.oasis.opendocument.spreadsheet',
            'application/vnd.oasis.opendocument.presentation'
        )
    ),
    check (byte_length between 1 and 26214400),
    check (octet_length(sha256) = 32),
    check (
        immutable_object_identity is null
        or octet_length(immutable_object_identity) between 1 and 512
    ),
    check (status in ('pending', 'finalizing', 'ready', 'attached', 'failed')),
    check (
        (
            status = 'attached'
            and message_sequence is not null
            and message_ordinal between 0 and 4
            and attached_at is not null
        )
        or (
            status <> 'attached'
            and message_sequence is null
            and message_ordinal is null
            and attached_at is null
        )
    ),
    check (
        (
            status in ('ready', 'attached')
            and immutable_object_identity is not null
            and finalized_at is not null
        )
        or status in ('pending', 'finalizing', 'failed')
    ),
    check (
        finalize_attempts >= 0
        and (
            (
                status = 'finalizing'
                and finalize_claim_token is not null
                and finalize_claimed_until is not null
            )
            or (
                status <> 'finalizing'
                and finalize_claim_token is null
                and finalize_claimed_until is null
            )
        )
    ),
    check (
        cleanup_attempts >= 0
        and (
            (cleanup_claim_token is null and cleanup_claimed_until is null)
            or (cleanup_claim_token is not null and cleanup_claimed_until is not null)
        )
    )
);
create index sync_chat_attachments_space_status_idx
    on sync_chat_attachments(tenant_id, space_id, status);
create index sync_chat_attachments_finalize_lease_idx
    on sync_chat_attachments(finalize_claimed_until)
    where status = 'finalizing';

create table sync_chat_read_receipts (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    sequence bigint not null,
    read_at timestamptz not null,
    updated_at timestamptz not null default now(),
    primary key (
        tenant_id,
        space_id,
        participant_id,
        participant_generation
    ),
    foreign key (tenant_id, space_id)
        references sync_chat_streams(tenant_id, space_id)
        on delete restrict,
    foreign key (
        tenant_id,
        space_id,
        episode_id,
        participant_id,
        participant_generation
    )
        references participants(
            tenant_id,
            space_id,
            episode_id,
            id,
            generation
        )
        on delete restrict,
    check (sequence > 0)
);

create table sync_whiteboard_scenes (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    scene_id uuid not null,
    is_current boolean not null default true,
    presenting_episode_id uuid,
    presenting_participant_id uuid,
    revision bigint not null default 0,
    app_state jsonb,
    element_count integer not null default 0,
    encoded_bytes bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, scene_id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
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
    on sync_whiteboard_scenes(tenant_id, space_id, episode_id)
    where is_current;

create table sync_whiteboard_elements (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
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
    primary key (tenant_id, space_id, scene_id, element_id),
    foreign key (tenant_id, space_id, scene_id)
        references sync_whiteboard_scenes(tenant_id, space_id, scene_id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    check (octet_length(element_id) between 1 and 128),
    check (octet_length(element_type) between 1 and 64),
    check (octet_length(element_index) between 1 and 64),
    check (version >= 0 and version_nonce >= 0),
    check (jsonb_typeof(payload) = 'object'),
    check (encoded_bytes between 2 and 16384)
);
create index sync_whiteboard_elements_snapshot_idx
    on sync_whiteboard_elements(tenant_id, space_id, scene_id, element_index, element_id);

create function space_public_invite_code(handle bytea) returns text
language sql immutable strict parallel safe
as $$
    select string_agg(chr(97 + get_byte(digest, i) % 26), '' order by i)
    from (select sha256('chalk/public-invite/code/v1'::bytea || handle) as digest) hashed,
         generate_series(0, 9) as i
$$;

create function space_public_invite_words(handle bytea) returns text
language sql immutable strict parallel safe
as $$
    select string_agg(words[1 + ((get_byte(digest, (i * 10) / 8)::bigint * 65536
        + get_byte(digest, (i * 10) / 8 + 1) * 256
        + get_byte(digest, (i * 10) / 8 + 2)) >> (14 - (i * 10) % 8) & 1023)], '-' order by i)
    from (select sha256('chalk/public-invite/words/v1'::bytea || handle) as digest,
        array['abacus','able','accent','acorn','acoustic','acre','acrobat','active','actor','adore','aerial','agenda','agent','agile','ahead','aim','airport','album','alike','alive','almond','aloe','aloha','alone','alpaca','alto','alumni','amber','amend','ample','amuse','anchor','angle','animal','anthem','antique','anvil','apple','april','apron','aqua','arcade','arctic','area','arena','arise','aroma','array','art','artist','aspire','astute','atlas','atom','attach','attain','attic','audio','autumn','avenue','avocado','awake','award','awning','bacon','badge','bagel','baked','baker','bakery','bamboo','banana','banjo','banner','barge','barn','basil','basket','batch','baton','beacon','beetle','blank','blanket','blaze','blend','blink','blog','blossom','bluebird','boat','bobcat','bolt','bonsai','bonus','book','booth','boots','boss','botany','both','bottle','boulder','bounce','bowler','branch','breeze','brick','bright','brim','bring','brisk','broil','bronze','brook','broom','brush','bubble','bucket','budget','buffalo','builder','bulb','bulk','bunch','bundle','bunny','busy','butter','button','buzz','cabana','cable','cactus','cake','calm','cameo','camera','camper','campus','canal','canary','candle','candy','canopy','canyon','cape','captain','carbon','card','cargo','carrot','carry','cartoon','case','castle','catalog','cedar','celery','chair','charm','cheer','cheese','chef','cherry','chess','chief','chill','chip','chunk','churn','cinema','circle','circus','citrus','city','civic','civil','claim','clamp','clap','clasp','class','clay','clean','clear','clever','click','cling','clip','cloak','clock','clone','closet','cloth','cloud','clover','clump','coach','coast','coat','cobalt','cocoa','coconut','coffee','coil','cola','cold','colony','comfy','comic','compass','concert','condor','cone','cookie','cope','copper','copy','coral','cork','corner','cosmic','cost','cotton','couch','cover','craft','crane','crate','crave','crawl','crayon','create','cricket','crisp','crop','crowd','crown','crumb','crust','crystal','cub','cube','cupcake','curl','curry','cursor','curve','cut','cycle','daffodil','daily','daisy','dance','dash','date','dawn','deal','debug','decaf','deck','decor','delta','deluxe','denim','depth','desk','device','dial','diary','dice','dig','dime','diner','dinner','disco','dish','dock','doing','doll','dolphin','domain','dome','donut','dot','down','dragon','dragonfly','drama','draw','drawing','dress','dried','drift','drill','drive','drizzle','drove','drum','dry','duck','duke','duo','dusk','dust','duty','eagle','early','earth','easel','east','echo','eclipse','edge','editor','eel','effort','elder','elf','elk','elm','email','ember','emblem','emboss','emerald','encore','energy','engine','enrich','enter','entry','equal','equator','eraser','errand','even','evolve','exact','exit','expert','fable','fabric','fact','factory','falcon','fall','fame','family','fancy','feast','feather','feed','fence','fern','ferry','fetch','fiber','fiddle','figure','film','filter','final','finale','finch','firefly','fit','five','flag','flame','flap','flick','flight','flip','float','flock','flower','foam','fog','foil','folk','font','food','forest','fossil','found','fountain','fox','frame','fresh','fridge','friend','from','front','frost','fruit','gala','galaxy','game','gap','garage','garden','garlic','gave','gazebo','gear','gecko','gem','gerbil','giant','gift','gig','ginger','giraffe','glacier','glad','glass','glide','glitter','glory','gloss','glove','glow','glue','goal','going','golden','golf','good','gown','grab','grain','granite','grant','grape','graph','grasp','grass','gravy','green','greet','grew','grid','grill','grip','groom','groove','guide','guitar','gulf','gummy','gush','habit','half','hamster','happy','harvest','hatch','haven','hazel','hazy','heap','heat','hedge','helium','helmet','help','heron','hickory','holiday','honey','horizon','hub','hula','hull','human','humid','hurry','hut','ice','iceberg','icing','icon','igloo','image','insect','iron','island','item','ivory','ivy','jacket','jaguar','jam','jasmine','jazz','jelly','jersey','jet','jigsaw','job','jog','jolly','jolt','journal','joy','judge','juice','juicy','july','jumbo','jump','jungle','keep','kettle','kilt','king','kite','kitten','kiwi','koala','ladder','lady','lagoon','lake','lamp','land','lantern','laptop','large','latch','laurel','lavender','leaflet','legend','lemon','length','lens','leopard','letter','lettuce','level','lever','library','lid','life','lift','lilac','lily','limit','line','linen','lint','lion','liquid','list','little','lively','lizard','lobster','locket','lotus','luggage','lumber','lunar','lunch','lyric','magnet','maker','mango','manor','many','map','maple','marble','marine','market','mascot','mash','match','math','meadow','melon','mercury','meteor','mitten','mocha','monkey','mop','mosaic','motor','motto','mount','mouse','move','movie','mud','muffin','mug','mural','muse','museum','mushroom','music','nacho','nail','name','nap','napkin','nature','neat','nectar','neon','nest','net','next','nickel','noodle','nugget','nutmeg','nylon','oak','oasis','oat','oatmeal','ocean','octagon','octopus','oil','olive','onion','opal','open','opera','orchid','origami','otter','outdoor','outer','oval','oven','owl','oxygen','oyster','ozone','pace','packet','pager','palace','palm','panda','panther','pantry','pants','papaya','paper','parade','parcel','park','parrot','parsley','party','pasta','pastel','patch','path','patio','pebble','pecan','pelican','pencil','penguin','penny','pepper','perch','petal','photo','picnic','pigeon','pillow','plank','plant','plaza','plenty','pluck','plug','plus','pod','poem','poet','point','polar','polka','polo','pond','pony','poppy','portal','poster','pouch','pound','power','press','print','prism','prize','proof','pug','pull','pulp','pulse','puma','pupil','puppet','puppy','purse','push','puzzle','quiet','quilt','quota','quote','race','rack','radar','radio','radish','raft','rail','rake','rally','ramp','ranch','range','ranger','rank','raven','reach','react','recap','relax','relay','relic','remix','repay','reply','rerun','reset','rhyme','ribbon','rice','rich','ride','rinse','ripple','rise','river','robe','robin','rock','rocket','rope','rover','royal','ruby','rug','rule','rush','safari','sage','salad','salon','salsa','salt','sample','sandy','satin','say','scale','scan','scarf','scoop','scoot','scope','score','scout','scrap','screen','script','scrub','scuba','scuff','sedan','send','serve','seven','shack','shade','shaky','shape','shed','sheep','shelf','shell','shine','shiny','ship','shirt','shop','shore','sift','silk','silly','silver','simple','single','sip','size','skate','sketch','skid','skip','skirt','sky','slab','slack','slate','sled','sleek','sleep','slice','slick','sling','slip','slush','small','smile','snack','snap','snowy','speak','speed','spend','spent','spill','spiny','spoke','sponge','spool','spoon','sport','spot','spout','spray','spring','sprint','sprout','spruce','spur','squad','squid','stack','staff','stage','stall','stamp','stand','staple','start','state','statue','steam','steep','stem','step','stereo','stew','stick','sting','stir','stock','stool','stop','storm','stove','straw','stream','street','strut','stuck','studio','stuff','stump','stunt','subway','sugar','surf','sushi','swan','sway','sweep','swell','swim','swing','swipe','swirl','swoop','syrup','tablet','taco','tag','take','tall','task','taste','tasty','thaw','theme','think','thread','thumb','tiara','tidal','tidy','tiger','tile','tilt','tint','tiny','trace','track','trade','train','travel','tray','treat','tree','trek','trend','trial','trick','trio','trophy','trout','truck','trunk','try','tug','tulip','turf','turtle','tutor','tweak','tweet','twice','twins','twirl','twist','uncle','undo','unify','unit','untie','update','upper','urban','user','valley','value','velvet','venue','verify','verse','vest','video','view','violet','vista','vocal','voice','volt','vowel','voyage','wafer','wagon','wake','walk','walnut','wand','watch','water','wavy','wheat','whoop','widen','width','willow','wing','wink','wipe','wise','wish','wizard','wok','wolf','wool','word','work','woven','yam','yard','year','yelp','yield','yoga','yogurt','yummy','zebra','zero','zesty','zippy','zone','zoom' ] as words) hashed,
        generate_series(0, 3) as i
$$;

create table space_public_invites (
    tenant_id uuid not null,
    space_id uuid not null,
    handle bytea not null,
    invite_code text not null generated always as (space_public_invite_code(handle)) stored,
    invite_words text not null generated always as (space_public_invite_words(handle)) stored,
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
create unique index space_public_invites_invite_code_idx on space_public_invites(invite_code);
create unique index space_public_invites_invite_words_idx on space_public_invites(invite_words);

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

create function bind_public_arrival_media_connection() returns trigger
language plpgsql as $$
begin
    if new.state = 'admitted' and new.provider_subject is not null and
       (TG_OP = 'INSERT' or old.state is distinct from new.state or
        old.provider_subject is distinct from new.provider_subject or
        old.participant_generation is distinct from new.participant_generation or
        old.participant_id is distinct from new.participant_id) then
        update participants set media_connection_id = new.provider_subject,
            media_connection_generation = new.participant_generation
        where tenant_id = new.tenant_id and episode_id = new.episode_id
          and id = new.participant_id and generation = new.participant_generation;
    end if;
    return new;
end;
$$;
create trigger public_arrival_media_connection
    after insert or update of state, provider_subject, participant_generation, participant_id
    on space_public_arrivals for each row execute function bind_public_arrival_media_connection();

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

create table sync_whiteboard_permissions (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    can_draw boolean not null,
    granted_by_participant_id uuid not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, participant_id),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, granted_by_participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict
);

create table sync_whiteboard_draw_policies (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    policy text not null check (policy in ('everyone', 'hosts', 'picked')),
    updated_by_participant_id uuid not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, episode_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, updated_by_participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict
);

create table sync_whiteboard_draw_policy_receipts (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    operation_id text not null check (octet_length(operation_id) between 16 and 64),
    policy text not null check (policy in ('everyone', 'hosts', 'picked')),
    completed_at timestamptz not null default now(),
    primary key (tenant_id, space_id, participant_id, operation_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict
);

create index sync_whiteboard_draw_policy_receipts_episode
    on sync_whiteboard_draw_policy_receipts (tenant_id, space_id, episode_id);

create table sync_whiteboard_operation_receipts (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    submitted_generation bigint not null,
    operation_id text not null,
    request_fingerprint bytea not null,
    operation_name text not null,
    outcome text not null,
    scene_id uuid not null,
    revision bigint not null,
    event_elements jsonb,
    event_presenting boolean,
    event_encoded_bytes integer not null default 0,
    completed_at timestamptz not null default now(),
    primary key (tenant_id, space_id, participant_id, operation_id),
    foreign key (
        tenant_id,
        space_id,
        episode_id,
        participant_id,
        submitted_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (octet_length(operation_id) between 16 and 64),
    check (octet_length(request_fingerprint) = 32),
    check (operation_name in ('submit_update', 'clear', 'set_draw_permission', 'set_presentation')),
    check (outcome = 'committed'),
    check (revision >= 0),
    check (
        (
            operation_name = 'submit_update'
            and jsonb_typeof(event_elements) = 'array'
            and event_presenting is null
            and event_encoded_bytes between 2 and 16777216
        )
        or (
            operation_name = 'set_presentation'
            and event_elements is null
            and event_presenting is not null
            and event_encoded_bytes = 0
        )
        or (
            operation_name not in ('submit_update', 'set_presentation')
            and event_elements is null
            and event_presenting is null
            and event_encoded_bytes = 0
        )
    )
);
create index sync_whiteboard_operation_receipts_retention_idx
    on sync_whiteboard_operation_receipts(tenant_id, space_id, completed_at);

create table sync_whiteboard_files (
    upload_id uuid primary key,
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    scene_id uuid not null,
    participant_id uuid not null,
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
    referenced_at timestamptz,
    cleanup_claim_token uuid,
    cleanup_claimed_until timestamptz,
    cleanup_attempts integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, space_id, scene_id, file_id),
    foreign key (tenant_id, space_id, scene_id)
        references sync_whiteboard_scenes(tenant_id, space_id, scene_id)
        on delete cascade,
    foreign key (
        tenant_id,
        space_id,
        episode_id,
        participant_id,
        participant_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
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
    on sync_whiteboard_files(expires_at, cleanup_claimed_until, tenant_id, space_id)
    where status in ('pending', 'finalizing', 'failed');
create index sync_whiteboard_files_space_cleanup_idx
    on sync_whiteboard_files(tenant_id, space_id, cleanup_claimed_until);

create view sync_whiteboard_file_writers as
select participant.tenant_id, participant.space_id, participant.episode_id,
       participant.id as participant_id, participant.generation as participant_generation,
       scene.scene_id
from participants participant
join episodes episode
    on (episode.tenant_id, episode.space_id, episode.id) =
       (participant.tenant_id, participant.space_id, participant.episode_id)
join sync_whiteboard_scenes scene
    on (scene.tenant_id, scene.space_id, scene.episode_id) =
       (participant.tenant_id, participant.space_id, participant.episode_id)
left join sync_whiteboard_permissions permission
    on (permission.tenant_id, permission.space_id, permission.episode_id, permission.participant_id) =
       (participant.tenant_id, participant.space_id, participant.episode_id, participant.id)
left join sync_whiteboard_draw_policies policy
    on (policy.tenant_id, policy.space_id, policy.episode_id) =
       (participant.tenant_id, participant.space_id, participant.episode_id)
where participant.status = 'active' and episode.status = 'active' and scene.is_current
    -- Same effective drawing rule as ChalkSync.WhiteboardV1.SQL.lock_authority/0.
    and case coalesce(policy.policy, 'everyone')
        when 'hosts' then 'manageWhiteboard' = any(participant.capabilities)
        when 'picked' then 'manageWhiteboard' = any(participant.capabilities)
            or coalesce(permission.can_draw, false)
        else coalesce(permission.can_draw, 'drawWhiteboard' = any(participant.capabilities))
    end;

create table sync_episode_control (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    control_revision bigint not null default 0,
    folded_state jsonb not null,
    state_schema_version integer not null check (state_schema_version > 0),
    state_digest bytea not null check (octet_length(state_digest) = 32),
    snapshot_bytes bigint not null,
    snapshot_reserved_bytes bigint not null default 0,
    participant_event_count bigint not null default 0,
    participant_event_bytes bigint not null default 0,
    lifecycle_event_count bigint not null default 0,
    lifecycle_event_bytes bigint not null default 0,
    lifecycle_reserved_events bigint not null default 1,
    lifecycle_reserved_bytes bigint not null default 16384,
    lifecycle_intent_count bigint not null default 0,
    lifecycle_intent_bytes bigint not null default 0,
    lifecycle_reserved_intents bigint not null default 1,
    lifecycle_reserved_intent_bytes bigint not null default 16384,
    receipt_count bigint not null default 0,
    receipt_bytes bigint not null default 0,
    retention_checkpoint_revision bigint,
    retention_checkpoint_state_digest bytea,
    retention_checkpoint_event_count bigint,
    retention_cleaned_at timestamptz,
    retention_deleted_event_rows bigint not null default 0,
    retention_deleted_event_bytes bigint not null default 0,
    retention_deleted_receipt_rows bigint not null default 0,
    retention_deleted_receipt_bytes bigint not null default 0,
    retention_deleted_lifecycle_intent_rows bigint not null default 0,
    retention_deleted_lifecycle_intent_bytes bigint not null default 0,
    retention_deleted_external_operation_rows bigint not null default 0,
    retention_deleted_external_operation_bytes bigint not null default 0,
    retention_deleted_admission_request_rows bigint not null default 0,
    retention_deleted_admission_request_bytes bigint not null default 0,
    retention_deleted_recording_rows bigint not null default 0,
    retention_deleted_recording_bytes bigint not null default 0,
    retention_deleted_screen_share_lease_rows bigint not null default 0,
    retention_deleted_screen_share_lease_bytes bigint not null default 0,
    retention_deleted_publication_fence_rows bigint not null default 0,
    retention_deleted_publication_fence_bytes bigint not null default 0,
    retention_deleted_publication_grant_reservation_rows bigint not null default 0,
    retention_deleted_publication_grant_reservation_bytes bigint not null default 0,
    initial_deadline_at_ms bigint,
    initial_deadline_generation bigint,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, episode_id),
    unique (tenant_id, space_id, episode_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    constraint sync_episode_control_initial_deadline_check check (
        (initial_deadline_at_ms is null and initial_deadline_generation is null)
        or (initial_deadline_at_ms >= 1 and initial_deadline_generation >= 1)
    ),
    check (
        control_revision >= 0
        and snapshot_bytes >= 0
        and snapshot_reserved_bytes >= 0
        and participant_event_count between 0 and 250000
        and participant_event_bytes between 0 and 2147483648
        and lifecycle_event_count >= 0
        and lifecycle_event_bytes >= 0
        and lifecycle_reserved_events >= 0
        and lifecycle_reserved_bytes >= 0
        and lifecycle_intent_count >= 0
        and lifecycle_intent_bytes >= 0
        and lifecycle_reserved_intents >= 0
        and lifecycle_reserved_intent_bytes >= 0
        and receipt_count between 0 and 500000
        and receipt_bytes between 0 and 4294967296
        and snapshot_bytes + snapshot_reserved_bytes <= 1048576
        and lifecycle_event_count + lifecycle_reserved_events <= 2048
        and lifecycle_event_bytes + lifecycle_reserved_bytes <= 33554432
        and lifecycle_intent_count + lifecycle_reserved_intents <= 2048
        and lifecycle_intent_bytes + lifecycle_reserved_intent_bytes <= 33554432
    ),
    check (
        (
            retention_cleaned_at is null
            and retention_checkpoint_revision is null
            and retention_checkpoint_state_digest is null
            and retention_checkpoint_event_count is null
            and retention_deleted_event_rows = 0
            and retention_deleted_event_bytes = 0
            and retention_deleted_receipt_rows = 0
            and retention_deleted_receipt_bytes = 0
            and retention_deleted_lifecycle_intent_rows = 0
            and retention_deleted_lifecycle_intent_bytes = 0
            and retention_deleted_external_operation_rows = 0
            and retention_deleted_external_operation_bytes = 0
            and retention_deleted_admission_request_rows = 0
            and retention_deleted_admission_request_bytes = 0
            and retention_deleted_recording_rows = 0
            and retention_deleted_recording_bytes = 0
            and retention_deleted_screen_share_lease_rows = 0
            and retention_deleted_screen_share_lease_bytes = 0
            and retention_deleted_publication_fence_rows = 0
            and retention_deleted_publication_fence_bytes = 0
            and retention_deleted_publication_grant_reservation_rows = 0
            and retention_deleted_publication_grant_reservation_bytes = 0
        )
        or (
            retention_cleaned_at is not null
            and retention_checkpoint_revision is not null
            and retention_checkpoint_revision >= 0
            and retention_checkpoint_state_digest is not null
            and octet_length(retention_checkpoint_state_digest) = 32
            and retention_checkpoint_event_count is not null
            and retention_checkpoint_event_count = retention_checkpoint_revision
            and retention_deleted_event_rows = retention_checkpoint_event_count
            and retention_deleted_event_bytes >= 0
            and retention_deleted_receipt_rows >= 0
            and retention_deleted_receipt_bytes >= 0
            and retention_deleted_lifecycle_intent_rows >= 0
            and retention_deleted_lifecycle_intent_bytes >= 0
            and retention_deleted_external_operation_rows >= 0
            and retention_deleted_external_operation_bytes >= 0
            and retention_deleted_admission_request_rows >= 0
            and retention_deleted_admission_request_bytes >= 0
            and retention_deleted_recording_rows >= 0
            and retention_deleted_recording_bytes >= 0
            and retention_deleted_screen_share_lease_rows >= 0
            and retention_deleted_screen_share_lease_bytes >= 0
            and retention_deleted_publication_fence_rows >= 0
            and retention_deleted_publication_fence_bytes >= 0
            and retention_deleted_publication_grant_reservation_rows >= 0
            and retention_deleted_publication_grant_reservation_bytes >= 0
        )
    )
);
create index sync_episode_control_retention_pending_idx
    on sync_episode_control(tenant_id, space_id, episode_id) where retention_cleaned_at is null;

create table sync_lifecycle_intents (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    lifecycle_intent_id uuid primary key,
    request_key text not null check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
    intent_name text not null,
    participant_id uuid,
    participant_generation bigint,
    payload jsonb not null check (octet_length(payload::text) <= 16384),
    status text not null,
    terminal_reason text,
    applied_event_id uuid,
    applied_revision bigint,
    attempt_count integer not null default 0 check (attempt_count >= 0),
    last_error_code text,
    next_attempt_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, space_id, episode_id, lifecycle_intent_id),
    unique (tenant_id, episode_id, intent_name, request_key),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict,
    constraint sync_lifecycle_intents_sync_v3_generation_fkey
    foreign key (
        tenant_id, space_id, episode_id,
        participant_id, participant_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (
        (
            intent_name in ('participant_joined', 'participant_left')
            and participant_id is not null
            and participant_generation > 0
        )
        or (
            intent_name in ('episode_ended', 'admission_requested')
            and participant_id is null
            and participant_generation is null
        )
    ),
    check (
        (
            status = 'pending'
            and terminal_reason is null
            and applied_event_id is null
            and applied_revision is null
            and completed_at is null
        )
        or (
            status = 'applied'
            and terminal_reason is null
            and applied_event_id is not null
            and applied_revision > 0
            and completed_at is not null
        )
        or (
            status = 'superseded'
            and terminal_reason in (
                'superseded_by_episode_end',
                'participant_already_terminal',
                'participant_generation_replaced'
            )
            and applied_event_id is null
            and applied_revision is null
            and completed_at is not null
        )
    )
);
create unique index sync_lifecycle_intents_episode_end_key
    on sync_lifecycle_intents(tenant_id, episode_id)
    where intent_name = 'episode_ended';
create unique index sync_lifecycle_intents_participant_transition_key
    on sync_lifecycle_intents(
        tenant_id,
        episode_id,
        intent_name,
        participant_id,
        participant_generation
    )
    where intent_name in ('participant_joined', 'participant_left');
create index sync_lifecycle_intents_pending_attempt_idx
    on sync_lifecycle_intents(next_attempt_at, attempt_count, created_at, lifecycle_intent_id)
    where status = 'pending';
create index sync_lifecycle_intents_episode_pending_idx
    on sync_lifecycle_intents(tenant_id, episode_id)
    where status = 'pending';

create table episode_focus_intervals (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    id uuid not null default gen_random_uuid(),
    state text not null check (state in ('active', 'inactive', 'background')),
    windowed boolean not null,
    started_at timestamptz not null,
    ended_at timestamptz not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, id),
    unique (tenant_id, space_id, episode_id, id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id) on delete restrict,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete restrict,
    check (ended_at > started_at)
);
create index episode_focus_intervals_participant_idx
    on episode_focus_intervals(tenant_id, space_id, episode_id, participant_id, started_at);

create table episode_focus_step_aways (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    actor_participant_id uuid not null,
    id uuid not null default gen_random_uuid(),
    reason text not null check (reason in ('reading', 'notes', 'break')),
    started_at timestamptz not null default now(),
    ended_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, id),
    unique (tenant_id, space_id, episode_id, id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id) on delete restrict,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete restrict,
    foreign key (tenant_id, space_id, episode_id, actor_participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete restrict,
    check (ended_at is null or ended_at >= started_at)
);
create unique index episode_focus_step_aways_one_open_idx
    on episode_focus_step_aways(tenant_id, space_id, episode_id, participant_id)
    where ended_at is null;

create table episode_focus_allow_windows (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    actor_participant_id uuid not null,
    id uuid not null default gen_random_uuid(),
    started_at timestamptz not null default now(),
    ends_at timestamptz not null,
    ended_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, id),
    unique (tenant_id, space_id, episode_id, id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id) on delete restrict,
    foreign key (tenant_id, space_id, episode_id, actor_participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete restrict,
    check (ends_at > started_at),
    check (ended_at is null or ended_at >= started_at)
);
create index episode_focus_allow_windows_episode_idx
    on episode_focus_allow_windows(tenant_id, space_id, episode_id, started_at);

create table sync_control_events (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    event_id uuid not null unique,
    base_revision bigint not null,
    revision bigint not null,
    event_name text not null,
    payload jsonb not null,
    actor_participant_id uuid,
    actor_generation bigint,
    command_id text,
    lifecycle_intent_id uuid,
    external_operation_id uuid,
    event_schema_version integer not null check (event_schema_version > 0),
    resulting_state_digest bytea not null check (octet_length(resulting_state_digest) = 32),
    encoded_bytes integer not null check (encoded_bytes between 1 and 32768),
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, revision),
    unique (tenant_id, episode_id, lifecycle_intent_id, event_id, revision),
    unique (tenant_id, episode_id, external_operation_id, event_id, revision),
    unique (tenant_id, episode_id, event_id, revision),
    unique (
        tenant_id,
        episode_id,
        actor_participant_id,
        actor_generation,
        command_id,
        event_id,
        revision
    ),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (tenant_id, space_id, episode_id, actor_participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        actor_participant_id, actor_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (base_revision >= 0 and revision = base_revision + 1),
    check (
        num_nonnulls(command_id, lifecycle_intent_id, external_operation_id) = 1
        and (
            (
                command_id is not null
                and command_id ~ '^[A-Za-z0-9_-]{16,64}$'
                and actor_participant_id is not null
                and actor_generation > 0
            )
            or (
                lifecycle_intent_id is not null
                and actor_participant_id is null
                and actor_generation is null
            )
            or (
                external_operation_id is not null
                and (actor_participant_id is null) = (actor_generation is null)
                and (actor_generation is null or actor_generation > 0)
            )
        )
    )
);
create unique index sync_control_events_command_origin_key
    on sync_control_events(
        tenant_id,
        episode_id,
        actor_participant_id,
        command_id
    )
    where command_id is not null;
create unique index sync_control_events_lifecycle_origin_key
    on sync_control_events(tenant_id, episode_id, lifecycle_intent_id)
    where lifecycle_intent_id is not null;
create table sync_command_receipts (
    tenant_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    submitted_generation bigint not null check (submitted_generation > 0),
    command_id text not null check (command_id ~ '^[A-Za-z0-9_-]{16,64}$'),
    request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
    command_name text not null check (command_name in (
        'raise_hand',
        'lower_hand',
        'set_hand_raised',
        'set_display_name',
        'set_admission_policy',
        'set_participant_role',
        'assign_roles',
        'admit_participant',
        'deny_admission',
        'mute_participant',
        'stop_participant_camera',
        'stop_participant_screen_share',
        'remove_participant',
        'start_recording',
        'stop_recording',
        'participant_leave',
        'start_episode',
        'extend_episode',
        'end_episode',
        'set_focus_step_away',
        'clear_focus_step_away',
        'open_focus_allowance',
        'close_focus_allowance'
    )),
    outcome text not null,
    rejection_reason text,
    event_id uuid,
    resulting_revision bigint,
    resulting_state_digest bytea,
    external_operation_id uuid,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, participant_id, command_id),
    foreign key (tenant_id, episode_id)
        references sync_episode_control(tenant_id, episode_id)
        on delete restrict,
    constraint sync_command_receipts_sync_event_fkey foreign key (
        tenant_id, episode_id, event_id, resulting_revision
    )
    references sync_control_events(
        tenant_id, episode_id, event_id, revision
    )
    on delete restrict
    deferrable initially deferred,
    constraint sync_command_receipts_shape_check check (
        (
            command_name in ('raise_hand', 'lower_hand')
            and resulting_state_digest is null
            and external_operation_id is null
            and completed_at is null
            and (
                (
                    outcome = 'committed'
                    and rejection_reason is null
                    and event_id is not null
                    and resulting_revision > 0
                )
                or (
                    outcome = 'rejected'
                    and rejection_reason in (
                        'episode_ended',
                        'participant_inactive',
                        'stale_participant_generation',
                        'capability_denied',
                        'invalid_state',
                        'command_id_conflict'
                    )
                    and event_id is null
                    and resulting_revision is null
                )
            )
        )
        or (
            command_name in (
                'set_hand_raised',
                'set_display_name',
                'set_admission_policy',
                'set_participant_role',
                'assign_roles',
                'admit_participant',
                'deny_admission',
                'mute_participant',
                'stop_participant_camera',
                'stop_participant_screen_share',
                'remove_participant',
                'start_recording',
                'stop_recording',
                'participant_leave',
                'start_episode',
                'extend_episode',
                'end_episode',
                'set_focus_step_away',
                'clear_focus_step_away',
                'open_focus_allowance',
                'close_focus_allowance'
            )
            and (
                (
                    outcome = 'committed'
                    and command_name <> 'start_episode'
                    and rejection_reason is null
                    and event_id is not null
                    and resulting_revision > 0
                    and octet_length(resulting_state_digest) = 32
                    and completed_at is not null
                )
                or (
                    outcome = 'satisfied'
                    and rejection_reason is null
                    and event_id is null
                    and resulting_revision >= 0
                    and octet_length(resulting_state_digest) = 32
                    and external_operation_id is null
                    and completed_at is not null
                )
                or (
                    outcome = 'pending'
                    and command_name <> 'start_episode'
                    and rejection_reason is null
                    and external_operation_id is not null
                    and completed_at is null
                    and (
                        (
                            command_name in ('set_participant_role', 'assign_roles')
                            and event_id is not null
                            and resulting_revision > 0
                            and octet_length(resulting_state_digest) = 32
                        )
                        or (
                            command_name not in ('set_participant_role', 'assign_roles')
                            and event_id is null
                            and resulting_revision is null
                            and resulting_state_digest is null
                        )
                    )
                )
                or (
                    outcome = 'rejected'
                    and command_name <> 'start_episode'
                    and rejection_reason in (
                        'episode_ended',
                        'participant_inactive',
                        'stale_participant_generation',
                        'capability_denied',
                        'invalid_state',
                        'invalid_target',
                        'role_not_eligible',
                        'role_assignment_required',
                        'screen_share_in_use',
                        'recording_in_progress',
                        'recording_policy_disabled',
                        'external_operation_failed'
                    )
                    and (
                        rejection_reason <> 'recording_policy_disabled'
                        or command_name = 'start_recording'
                    )
                    and completed_at is not null
                    and (
                        (
                            command_name in ('set_participant_role', 'assign_roles')
                            and external_operation_id is not null
                            and event_id is not null
                            and resulting_revision > 0
                            and octet_length(resulting_state_digest) = 32
                        )
                        or (
                            command_name not in ('set_participant_role', 'assign_roles')
                            and event_id is null
                            and resulting_revision is null
                            and resulting_state_digest is null
                        )
                    )
                )
            )
        )
    )
);

alter table sync_lifecycle_intents
    add foreign key (
        tenant_id,
        episode_id,
        lifecycle_intent_id,
        applied_event_id,
        applied_revision
    )
    references sync_control_events(
        tenant_id,
        episode_id,
        lifecycle_intent_id,
        event_id,
        revision
    )
    on delete restrict;

create table sync_external_operations (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    external_operation_id uuid primary key,
    parent_external_operation_id uuid,
    request_key text not null,
    request_fingerprint bytea not null,
    operation_name text not null,
    actor_participant_id uuid,
    actor_generation bigint,
    target_participant_id uuid,
    target_participant_generation bigint,
    source text,
    recording_id uuid,
    deadline_generation bigint,
    journey_id uuid,
    parent_journey_event_id uuid,
    producing_trace_id text,
    producing_span_id text,
    payload jsonb not null,
    status text not null default 'pending',
    fence_active boolean not null default false,
    attempt_count integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    last_error_code text,
    applied_event_id uuid,
    applied_revision bigint,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    producing_traceparent text,
    producing_tracestate text,
    unique (tenant_id, space_id, episode_id, external_operation_id),
    unique (tenant_id, episode_id, external_operation_id),
    unique (tenant_id, episode_id, operation_name, request_key),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        actor_participant_id, actor_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        target_participant_id, target_participant_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32),
    check (octet_length(payload::text) <= 16384),
    check (operation_name in (
        'admit_participant', 'deny_admission', 'admission_request_expired', 'mute_participant',
        'stop_participant_camera', 'stop_participant_screen_share',
        'remove_participant', 'start_recording', 'stop_recording',
        'recording_capture_ready', 'recording_capture_stopped', 'recording_capture_failed',
        'participant_leave', 'end_episode', 'extend_episode', 'tenant_assign_roles', 'tenant_set_deadline',
        'tenant_end_episode', 'maximum_episode_duration_expired',
        'role_transition_cleanup', 'role_transition_source_stop'
    )),
    check (source is null or source in ('microphone', 'camera', 'screen')),
    check ((actor_participant_id is null) = (actor_generation is null)),
    check (actor_generation is null or actor_generation > 0),
    check ((target_participant_id is null) = (target_participant_generation is null)),
    check (target_participant_generation is null or target_participant_generation > 0),
    check (deadline_generation is null or deadline_generation > 0),
    constraint sync_external_operations_deadline_operation_check check (
        (operation_name in ('tenant_set_deadline', 'extend_episode', 'maximum_episode_duration_expired'))
        = (deadline_generation is not null)
    ),
    check ((journey_id is null) = (parent_journey_event_id is null)),
    check (producing_trace_id is null or producing_trace_id ~ '^[0-9a-f]{32}$'),
    check (producing_span_id is null or producing_span_id ~ '^[0-9a-f]{16}$'),
    check ((producing_trace_id is null) = (producing_span_id is null)),
    check (
        producing_traceparent is null
        or producing_traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
    ),
    check (
        producing_tracestate is null
        or octet_length(producing_tracestate) between 1 and 512
    ),
    check (producing_traceparent is not null or producing_tracestate is null),
    check (attempt_count between 0 and 100),
    check (
        (operation_name = 'role_transition_cleanup' and parent_external_operation_id is null and source is null)
        or (operation_name = 'role_transition_source_stop' and parent_external_operation_id is not null and source is not null)
        or (operation_name not in ('role_transition_cleanup', 'role_transition_source_stop') and parent_external_operation_id is null)
    ),
    check (
        (
            status = 'pending'
            and completed_at is null
            and applied_event_id is null
            and applied_revision is null
        )
        or (
            status = 'applied'
            and completed_at is not null
            and last_error_code is null
            and ((applied_event_id is null and applied_revision is null) or (applied_event_id is not null and applied_revision > 0))
            and fence_active = false
        )
        or (
            status = 'failed'
            and completed_at is not null
            and last_error_code is not null
            and applied_event_id is null
            and applied_revision is null
        )
    )
);
alter table sync_external_operations
    add foreign key (tenant_id, episode_id, parent_external_operation_id)
    references sync_external_operations(tenant_id, episode_id, external_operation_id)
    on delete restrict;
create unique index sync_external_operations_parent_source_key
    on sync_external_operations(tenant_id, episode_id, parent_external_operation_id, source)
    where parent_external_operation_id is not null;
create index sync_external_operations_pending_idx
    on sync_external_operations(next_attempt_at, external_operation_id)
    where status = 'pending';

alter table sync_control_events
    add foreign key (tenant_id, episode_id, external_operation_id)
    references sync_external_operations(tenant_id, episode_id, external_operation_id)
    on delete restrict;

alter table sync_external_operations
    add foreign key (
        tenant_id,
        episode_id,
        external_operation_id,
        applied_event_id,
        applied_revision
    )
    references sync_control_events(
        tenant_id,
        episode_id,
        external_operation_id,
        event_id,
        revision
    )
    on delete restrict;

alter table sync_command_receipts
    add foreign key (tenant_id, episode_id, external_operation_id)
    references sync_external_operations(tenant_id, episode_id, external_operation_id)
    on delete restrict;

create table sync_admission_requests (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    admission_request_id uuid primary key,
    request_key text not null,
    request_fingerprint bytea not null,
    participant_id uuid not null,
    display_name text not null,
    role text not null,
    status text not null default 'pending',
    decision_external_operation_id uuid,
    requested_at timestamptz not null default now(),
    expires_at timestamptz not null,
    completed_at timestamptz,
    unique (tenant_id, space_id, episode_id, admission_request_id),
    unique (tenant_id, episode_id, request_key),
    unique (tenant_id, episode_id, participant_id),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (tenant_id, episode_id, decision_external_operation_id)
        references sync_external_operations(tenant_id, episode_id, external_operation_id)
        on delete restrict,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32),
    check (octet_length(display_name) between 1 and 256 and display_name = btrim(display_name)),
    check (expires_at > requested_at),
    check (
        (status = 'pending' and completed_at is null)
        or (status in ('admitted', 'denied', 'expired') and decision_external_operation_id is not null and completed_at is not null)
    )
);
create index sync_admission_requests_pending_idx
    on sync_admission_requests(expires_at, admission_request_id)
    where status = 'pending';

create index sync_admission_requests_admitted_participant_idx
    on sync_admission_requests(tenant_id, episode_id, participant_id)
    where status = 'admitted';

create table sync_screen_share_leases (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    lease_id uuid not null unique,
    owner_participant_id uuid not null,
    owner_generation bigint not null,
    lease_generation bigint not null,
    status text not null,
    acquired_at timestamptz not null,
    renewed_until timestamptz not null,
    hard_expires_at timestamptz not null,
    primary key (tenant_id, episode_id),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        owner_participant_id, owner_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (owner_generation > 0 and lease_generation > 0),
    check (status = 'active'),
    check (acquired_at < renewed_until and renewed_until <= hard_expires_at)
);
create index sync_screen_share_leases_expiry_idx
    on sync_screen_share_leases(hard_expires_at, lease_id);

create table sync_media_pauses (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    publication_id text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, participant_id, source),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, participant_id, participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete cascade,
    check (participant_generation > 0),
    check (source in ('microphone', 'camera', 'screen')),
    check (octet_length(publication_id) between 1 and 256)
);

-- A host stop (mute, camera stop, screen stop) kept until a newer host stop for the same participant and source replaces it.
-- Sync projects it as the off reason "host" so a client that missed the stop event can still see it.
create table sync_media_stops (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    revision bigint not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, participant_id, source),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, participant_id, participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete cascade,
    check (participant_generation > 0),
    check (source in ('microphone', 'camera', 'screen')),
    check (revision > 0)
);

create table sync_publication_fences (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    external_operation_id uuid not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, participant_id, source),
    foreign key (
        tenant_id, space_id, episode_id,
        participant_id, participant_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    foreign key (tenant_id, episode_id, external_operation_id)
        references sync_external_operations(tenant_id, episode_id, external_operation_id)
        on delete restrict,
    check (source in ('microphone', 'camera', 'screen')),
    check (participant_generation > 0),
    check (expires_at > created_at)
);
create index sync_publication_fences_expiry_idx
    on sync_publication_fences(expires_at, external_operation_id);

create table sync_publication_grant_reservations (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    reservation_id uuid primary key,
    operation_id text not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    status text not null default 'pending',
    failure_code text,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, episode_id, operation_id),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        participant_id, participant_generation
    ) references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (operation_id ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (participant_generation > 0),
    check (source in ('microphone', 'camera', 'screen')),
    check (status in ('pending', 'confirmed', 'failed', 'ambiguous')),
    check (expires_at > created_at),
    check (
        (status in ('pending', 'ambiguous') and completed_at is null)
        or (status = 'confirmed' and failure_code is null and completed_at is not null)
        or (status = 'failed' and failure_code is not null and completed_at is not null)
    )
);
create unique index sync_publication_grant_reservations_active_source_key
    on sync_publication_grant_reservations(tenant_id, episode_id, participant_id, source)
    where status in ('pending', 'ambiguous');
create index sync_publication_grant_reservations_expiry_idx
    on sync_publication_grant_reservations(expires_at, reservation_id);
-- The revision at which Sync decided a grant or stop, unique and rising in commit order within
-- an Episode because every decision holds the Episode row lock. Null rows are never renewed.
create sequence sync_source_control_revisions as bigint;
alter table sync_publication_grant_reservations
    add column control_revision bigint check (control_revision > 0);
alter table sync_external_operations
    add column control_revision bigint check (control_revision > 0);
create index sync_publication_grant_reservations_confirmed_source_idx
    on sync_publication_grant_reservations(tenant_id, episode_id, participant_id, source, control_revision desc)
    where status = 'confirmed' and control_revision is not null;

create table sync_recordings (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid primary key,
    status text not null,
    generation bigint not null,
    adapter_metadata jsonb not null default '{}'::jsonb,
    started_by_participant_id uuid,
    started_by_generation bigint,
    start_external_operation_id uuid not null,
    stop_external_operation_id uuid,
    failure_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, space_id, episode_id, recording_id),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        started_by_participant_id, started_by_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    foreign key (tenant_id, episode_id, start_external_operation_id)
        references sync_external_operations(tenant_id, episode_id, external_operation_id)
        on delete restrict,
    foreign key (tenant_id, episode_id, stop_external_operation_id)
        references sync_external_operations(tenant_id, episode_id, external_operation_id)
        on delete restrict,
    check (status in ('starting', 'recording', 'stopping', 'stopped', 'failed')),
    check (generation > 0),
    check ((started_by_participant_id is null) = (started_by_generation is null)),
    check (started_by_generation is null or started_by_generation > 0),
    check (
        (status in ('starting', 'recording', 'stopping') and completed_at is null and failure_code is null)
        or (status = 'stopped' and completed_at is not null and failure_code is null)
        or (status = 'failed' and completed_at is not null and failure_code is not null)
    )
);
create unique index sync_recordings_one_active_per_episode_idx
    on sync_recordings(tenant_id, episode_id)
    where status in ('starting', 'recording', 'stopping');

create function sync_validate_receipt_event_origin()
returns trigger
language plpgsql
as $$
declare
    event_row sync_control_events%rowtype;
begin
    if new.outcome <> 'committed' then
        return new;
    end if;

    select *
    into event_row
    from sync_control_events
    where tenant_id = new.tenant_id
      and episode_id = new.episode_id
      and event_id = new.event_id
      and revision = new.resulting_revision;

    if not found then
        raise exception 'committed sync receipt references a missing event';
    end if;

    if event_row.command_id = new.command_id
        and event_row.actor_participant_id = new.participant_id
        and event_row.actor_generation = new.submitted_generation then
        return new;
    end if;

    if new.external_operation_id is not null
        and event_row.external_operation_id = new.external_operation_id then
        return new;
    end if;

    if new.command_name = 'admit_participant'
        and new.external_operation_id is not null
        and event_row.event_name = 'participant_joined'
        and event_row.lifecycle_intent_id is not null
        and exists (
            select 1
            from sync_admission_requests admission
            where admission.tenant_id = new.tenant_id
              and admission.episode_id = new.episode_id
              and admission.decision_external_operation_id = new.external_operation_id
              and admission.status = 'admitted'
              and admission.participant_id::text =
                  event_row.payload ->> 'participant_id'
        ) then
        return new;
    end if;

    raise exception 'committed sync receipt event origin does not match its durable request';
end;
$$;

create constraint trigger sync_command_receipts_event_origin
after insert or update on sync_command_receipts
deferrable initially deferred
for each row execute function sync_validate_receipt_event_origin();

create table recordings (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    space_id uuid not null references spaces(id),
    episode_id uuid not null references episodes(id),
    -- pending (should be rare ideally), processing, completed, failed
    status text not null,
    -- s3, cf, do
    storage_provider text not null,
    storage_key text,
    storage_content_type text,
    storage_size bigint check (storage_size is null or storage_size >= 0),
    storage_checksum bytea check (storage_checksum is null or octet_length(storage_checksum) between 16 and 128),
    duration_millis bigint check (duration_millis is null or duration_millis >= 0),
    completed_at timestamptz,
    metadata jsonb,
    failure_code text check (failure_code is null or octet_length(failure_code) between 1 and 128),
    failed_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint recordings_failure_state_check check ((status = 'failed') = (failure_code is not null) and (failure_code is null) = (failed_at is null))
);
create index recordings_tenant_created_at_id_idx on recordings(tenant_id, created_at desc, id desc);
create index recordings_tenant_episode_created_at_id_idx on recordings(tenant_id, episode_id, created_at desc, id desc);
create index recordings_tenant_space_created_at_id_idx on recordings(tenant_id, space_id, created_at desc, id desc);

create table transcriptions (
    transcript_language text not null default 'auto' check (transcript_language in ('auto','af','am','ar','as','az','ba','be','bg','bn','bo','br','bs','ca','cs','cy','da','de','el','en','es','et','eu','fa','fi','fo','fr','gl','gu','ha','haw','he','hi','hr','ht','hu','hy','id','is','it','ja','jw','ka','kk','km','kn','ko','la','lb','ln','lo','lt','lv','mg','mi','mk','ml','mn','mr','ms','mt','my','ne','nl','nn','no','oc','pa','pl','ps','pt','ro','ru','sa','sd','si','sk','sl','sn','so','sq','sr','su','sv','sw','ta','te','tg','th','tk','tl','tr','tt','uk','ur','uz','vi','yi','yo','yue','zh')),
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    recording_id uuid not null references recordings(id),
    space_id uuid not null references spaces(id),
    episode_id uuid not null references episodes(id),
    -- not_requested, preparing, transcribing, verifying, complete,
    -- retryable_failure, terminal_failure, deleted
    status text not null,
    provider text,
    model text,
    languages text[] not null,
    metadata jsonb,
    artifact_key text,
    artifact_sha256 bytea,
    artifact_size bigint,
    artifact_content_type text,
    source_manifest_key text,
    source_manifest_sha256 bytea,
    source_manifest_size bigint,
    source_manifest_content_type text,
    generation bigint not null default 1,
    completed_at timestamptz,
    deleted_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint transcriptions_status_check check (status in ('not_requested', 'preparing', 'transcribing', 'verifying', 'complete', 'retryable_failure', 'terminal_failure', 'deleted')),
    constraint transcriptions_generation_check check (generation > 0),
    constraint transcriptions_artifact_sha256_check check (artifact_sha256 is null or octet_length(artifact_sha256) = 32),
    constraint transcriptions_source_manifest_sha256_check check (source_manifest_sha256 is null or octet_length(source_manifest_sha256) = 32),
    constraint transcriptions_artifact_size_check check (artifact_size is null or artifact_size >= 0),
    constraint transcriptions_source_manifest_size_check check (source_manifest_size is null or source_manifest_size >= 0),
    constraint transcriptions_artifact_key_check check (artifact_key is null or (length(artifact_key) between 1 and 1024 and artifact_key !~ '(^/|//|(^|/)\.\.?(/|$))'))
);
create index transcriptions_tenant_created_at_id_idx on transcriptions(tenant_id, created_at desc, id desc);
create index transcriptions_tenant_recording_created_at_id_idx on transcriptions(tenant_id, recording_id, created_at desc, id desc);
create unique index transcriptions_recording_id_uidx on transcriptions(recording_id);

create table recording_transcription_sources (
    recording_id uuid primary key references recordings(id) on delete restrict,
    tenant_id uuid not null references tenants(id),
    manifest_key text not null,
    manifest_sha256 bytea not null,
    manifest_size bigint not null,
    manifest_content_type text not null,
    schema_version integer not null,
    committed_at timestamptz not null,
    constraint recording_transcription_sources_sha256_check check (octet_length(manifest_sha256) = 32),
    constraint recording_transcription_sources_size_check check (manifest_size between 1 and 524288000),
    constraint recording_transcription_sources_key_check check (length(manifest_key) between 1 and 1024),
    constraint recording_transcription_sources_content_type_check check (manifest_content_type = 'application/json')
);
create table recording_transcription_source_chunks (
    id uuid primary key,
    recording_id uuid not null references recording_transcription_sources(recording_id) on delete restrict,
    tenant_id uuid not null references tenants(id),
    chunk_index integer not null,
    generation bigint not null default 1,
    start_ms bigint not null,
    end_ms bigint not null,
    participant_ref text,
    track_epoch text,
    identity_kind text not null default 'unknown',
    track_class text not null default 'unknown',
    storage_key text not null,
    checksum bytea not null,
    size bigint not null,
    content_type text not null,
    unique (recording_id, generation, chunk_index),
    constraint recording_transcription_source_chunks_index_check check (chunk_index >= 0),
    constraint recording_transcription_source_chunks_time_check check (start_ms >= 0 and end_ms > start_ms),
    constraint recording_transcription_source_chunks_identity_kind_check check (identity_kind in ('participant', 'shared', 'unknown')),
    constraint recording_transcription_source_chunks_track_class_check check (track_class in ('microphone', 'screen-share', 'system-audio', 'unknown')),
    constraint recording_transcription_source_chunks_identity_fields_check check (
        (identity_kind = 'participant' and participant_ref is not null and track_epoch is not null)
        or (identity_kind in ('shared', 'unknown') and participant_ref is null and track_epoch is null)
    ),
    constraint recording_transcription_source_chunks_system_audio_identity_check check (not (track_class = 'system-audio' and identity_kind = 'participant')),
    constraint recording_transcription_source_chunks_checksum_check check (octet_length(checksum) = 32),
    constraint recording_transcription_source_chunks_size_check check (size between 1 and 524288000)
);

create table artifact_jobs (
    transcript_language text not null default 'auto' check (transcript_language in ('auto','af','am','ar','as','az','ba','be','bg','bn','bo','br','bs','ca','cs','cy','da','de','el','en','es','et','eu','fa','fi','fo','fr','gl','gu','ha','haw','he','hi','hr','ht','hu','hy','id','is','it','ja','jw','ka','kk','km','kn','ko','la','lb','ln','lo','lt','lv','mg','mi','mk','ml','mn','mr','ms','mt','my','ne','nl','nn','no','oc','pa','pl','ps','pt','ro','ru','sa','sd','si','sk','sl','sn','so','sq','sr','su','sv','sw','ta','te','tg','th','tk','tl','tr','tt','uk','ur','uz','vi','yi','yo','yue','zh')),
    id uuid primary key,
    idempotency_key text not null,
    tenant_id uuid not null references tenants(id),
    episode_id uuid references episodes(id),
    recording_id uuid references recordings(id),
    transcript_id uuid references transcriptions(id),
    chunk_id uuid,
    artifact_kind text not null,
    payload_schema_version integer not null,
    state text not null,
    priority integer not null default 0,
    available_at timestamptz not null default now(),
    attempt_count integer not null default 0,
    attempt_limit integer not null default 4,
    lease_token_hash bytea,
    lease_owner text,
    lease_expires_at timestamptz,
    error_code text,
    error_detail text,
    journey_id uuid,
    traceparent text,
    tracestate text,
    terminal_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, idempotency_key),
    constraint artifact_jobs_key_check check (idempotency_key ~ '^[A-Za-z0-9._-]{1,128}$'),
    constraint artifact_jobs_kind_check check (artifact_kind in ('recording', 'transcription', 'transcription_chunk', 'transcription_finalize')),
    constraint artifact_jobs_state_check check (state in ('pending', 'leased', 'retryable', 'completed', 'dead_letter', 'cancelled')),
    constraint artifact_jobs_schema_version_check check (payload_schema_version between 1 and 99),
    constraint artifact_jobs_priority_check check (priority between -100 and 100),
    constraint artifact_jobs_attempt_count_check check (attempt_count >= 0 and attempt_count <= attempt_limit),
    constraint artifact_jobs_attempt_limit_check check (attempt_limit between 1 and 32),
    constraint artifact_jobs_lease_hash_check check (lease_token_hash is null or octet_length(lease_token_hash) = 32),
    constraint artifact_jobs_owner_check check (lease_owner is null or length(lease_owner) between 1 and 128),
    constraint artifact_jobs_error_code_check check (error_code is null or length(error_code) between 1 and 128),
    constraint artifact_jobs_error_detail_check check (error_detail is null or octet_length(error_detail) <= 2048),
    constraint artifact_jobs_traceparent_check check (traceparent is null or length(traceparent) <= 256),
    constraint artifact_jobs_tracestate_check check (tracestate is null or length(tracestate) <= 512),
    constraint artifact_jobs_lease_fields_check check ((lease_token_hash is null and lease_owner is null and lease_expires_at is null) or (lease_token_hash is not null and lease_owner is not null and lease_expires_at is not null)),
    constraint artifact_jobs_terminal_fields_check check ((state in ('completed', 'dead_letter', 'cancelled')) = (terminal_at is not null))
);
create index artifact_jobs_claim_idx on artifact_jobs(priority desc, available_at asc, created_at asc, id asc) where state in ('pending', 'retryable');
create index artifact_jobs_lease_expiry_idx on artifact_jobs(lease_expires_at) where state = 'leased';
create index artifact_jobs_tenant_created_idx on artifact_jobs(tenant_id, created_at desc, id desc);

create table transcript_chunks (
    id uuid primary key,
    transcript_id uuid not null references transcriptions(id) on delete restrict,
    tenant_id uuid not null references tenants(id),
    chunk_index integer not null,
    generation bigint not null default 1,
    start_ms bigint not null,
    end_ms bigint not null,
    participant_ref text,
    track_epoch text,
    identity_kind text not null default 'unknown',
    track_class text not null default 'unknown',
    storage_key text not null,
    result_key text not null,
    checksum bytea not null,
    size bigint not null,
    content_type text not null,
    created_at timestamptz not null default now(),
    unique (transcript_id, generation, chunk_index),
    constraint transcript_chunks_index_check check (chunk_index >= 0),
    constraint transcript_chunks_generation_check check (generation > 0),
    constraint transcript_chunks_time_check check (start_ms >= 0 and end_ms > start_ms),
    constraint transcript_chunks_identity_kind_check check (identity_kind in ('participant', 'shared', 'unknown')),
    constraint transcript_chunks_track_class_check check (track_class in ('microphone', 'screen-share', 'system-audio', 'unknown')),
    constraint transcript_chunks_identity_fields_check check (
        (identity_kind = 'participant' and participant_ref is not null and track_epoch is not null)
        or (identity_kind in ('shared', 'unknown') and participant_ref is null and track_epoch is null)
    ),
    constraint transcript_chunks_system_audio_identity_check check (not (track_class = 'system-audio' and identity_kind = 'participant')),
    constraint transcript_chunks_ref_check check (participant_ref is null or length(participant_ref) between 1 and 128),
    constraint transcript_chunks_epoch_check check (track_epoch is null or length(track_epoch) between 1 and 128),
    constraint transcript_chunks_checksum_check check (octet_length(checksum) = 32),
    constraint transcript_chunks_size_check check (size between 1 and 524288000),
    constraint transcript_chunks_key_check check (length(storage_key) between 1 and 1024 and storage_key !~ '(^/|//|(^|/)\.\.?(/|$))'),
    constraint transcript_chunks_result_key_check check (length(result_key) between 1 and 1024 and result_key !~ '(^/|//|(^|/)\.\.?(/|$))')
);
alter table artifact_jobs add constraint artifact_jobs_chunk_fkey foreign key (chunk_id) references transcript_chunks(id) on delete restrict;

create table transcription_attempts (
    id uuid primary key,
    transcript_id uuid not null references transcriptions(id) on delete restrict,
    chunk_id uuid not null references transcript_chunks(id) on delete restrict,
    generation bigint not null,
    attempt integer not null,
    provider text not null,
    model text not null,
    provider_version text not null,
    execution_identity text,
    provider_request_id text,
    measured_audio_ms bigint,
    provider_observed_duration_ms bigint,
    state text not null,
    billed_audio_seconds integer,
    error_code text,
    error_detail text,
    journey_id uuid,
    traceparent text,
    tracestate text,
    quality jsonb not null default '{}'::jsonb,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    created_at timestamptz not null default now(),
    unique (chunk_id, generation, attempt),
    constraint transcription_attempts_generation_check check (generation > 0),
    constraint transcription_attempts_attempt_check check (attempt > 0 and attempt <= 32),
    constraint transcription_attempts_state_check check (state in ('started', 'retryable_failure', 'accepted', 'rejected', 'cancelled')),
    constraint transcription_attempts_provider_check check (length(provider) between 1 and 128),
    constraint transcription_attempts_model_check check (length(model) between 1 and 256),
    constraint transcription_attempts_version_check check (length(provider_version) between 1 and 256),
    constraint transcription_attempts_request_id_check check (provider_request_id is null or length(provider_request_id) between 1 and 256),
    constraint transcription_attempts_execution_identity_check check (execution_identity is null or length(execution_identity) between 1 and 256),
    constraint transcription_attempts_measured_audio_check check (measured_audio_ms is null or measured_audio_ms between 0 and 86400000),
    constraint transcription_attempts_observed_duration_check check (provider_observed_duration_ms is null or provider_observed_duration_ms between 0 and 86400000),
    constraint transcription_attempts_quality_check check (jsonb_typeof(quality) = 'object'),
    constraint transcription_attempts_billed_check check (billed_audio_seconds is null or billed_audio_seconds between 0 and 86400),
    constraint transcription_attempts_error_detail_check check (error_detail is null or octet_length(error_detail) <= 2048),
    constraint transcription_attempts_traceparent_check check (traceparent is null or length(traceparent) <= 256),
    constraint transcription_attempts_tracestate_check check (tracestate is null or length(tracestate) <= 512)
);

create table transcription_chunk_results (
    id uuid primary key,
    chunk_id uuid not null references transcript_chunks(id) on delete restrict,
    generation bigint not null,
    attempt_id uuid not null references transcription_attempts(id) on delete restrict,
    provider text not null,
    model text not null,
    provider_version text not null,
    result_key text not null,
    result_sha256 bytea not null,
    result_size bigint not null,
    result_content_type text not null,
    language text,
    billed_audio_seconds integer,
    quality jsonb not null default '{}'::jsonb,
    accepted_at timestamptz not null default now(),
    unique (chunk_id, generation),
    unique (attempt_id),
    constraint transcription_chunk_results_generation_check check (generation > 0),
    constraint transcription_chunk_results_sha256_check check (octet_length(result_sha256) = 32),
    constraint transcription_chunk_results_size_check check (result_size between 1 and 524288000),
    constraint transcription_chunk_results_key_check check (length(result_key) between 1 and 1024 and result_key !~ '(^/|//|(^|/)\.\.?(/|$))'),
    constraint transcription_chunk_results_quality_check check (jsonb_typeof(quality) = 'object'),
    constraint transcription_chunk_results_billed_check check (billed_audio_seconds is null or billed_audio_seconds between 0 and 86400)
);
create table transcription_cleanup_jobs (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    transcript_id uuid not null references transcriptions(id) on delete restrict,
    object_key text not null,
    object_kind text not null,
    due_at timestamptz not null,
    state text not null default 'pending',
    attempt_count integer not null default 0,
    attempt_limit integer not null default 8,
    lease_token_hash bytea,
    lease_owner text,
    lease_expires_at timestamptz,
    error_code text,
    error_detail text,
    verified_at timestamptz,
    provider_copy_status text not null default 'not_applicable',
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (transcript_id, object_key),
    constraint transcription_cleanup_jobs_key_check check (length(object_key) between 1 and 1024 and object_key !~ '(^/|//|(^|/)\.\.?(/|$))'),
    constraint transcription_cleanup_jobs_kind_check check (object_kind in ('final_artifact', 'temp_chunk', 'temp_result')),
    constraint transcription_cleanup_jobs_state_check check (state in ('pending', 'leased', 'retryable', 'completed', 'dead_letter')),
    constraint transcription_cleanup_jobs_attempt_check check (attempt_count >= 0 and attempt_count <= attempt_limit),
    constraint transcription_cleanup_jobs_attempt_limit_check check (attempt_limit between 1 and 32),
    constraint transcription_cleanup_jobs_lease_hash_check check (lease_token_hash is null or octet_length(lease_token_hash) = 32),
    constraint transcription_cleanup_jobs_lease_fields_check check ((lease_token_hash is null and lease_owner is null and lease_expires_at is null) or (lease_token_hash is not null and lease_owner is not null and lease_expires_at is not null)),
    constraint transcription_cleanup_jobs_verified_check check ((state = 'completed') = (verified_at is not null)),
    constraint transcription_cleanup_jobs_provider_copy_check check (provider_copy_status in ('not_applicable', 'pending', 'completed', 'failed'))
);
create index transcription_cleanup_jobs_claim_idx on transcription_cleanup_jobs(due_at, created_at, id) where state in ('pending', 'retryable');
create index transcription_cleanup_jobs_lease_idx on transcription_cleanup_jobs(lease_expires_at) where state = 'leased';

create table recording_capacity (
    id smallint primary key check (id = 1),
    reserved_episodes integer not null default 0 check (reserved_episodes between 0 and 20),
    reserved_participants integer not null default 0 constraint recording_capacity_reserved_participants_check1 check (reserved_participants between 0 and 200),
    reserved_input_bitrate_bps bigint not null default 0 check (reserved_input_bitrate_bps >= 0),
    updated_at timestamptz not null default now()
);

create table recording_pool_health (
    role text primary key check (role in ('capture', 'render')),
    admission_open boolean not null,
    ready_capacity integer not null check (ready_capacity >= 0),
    reason text not null check (octet_length(reason) <= 256),
    observed_at timestamptz not null,
    updated_at timestamptz not null default now()
);

create table recording_reservations (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    space_id uuid not null references spaces(id),
    episode_id uuid not null references episodes(id),
    recording_id uuid not null references recordings(id),
    idempotency_key text not null,
    request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
    policy_snapshot_version text not null check (policy_snapshot_version = 'episode_config.v2'),
    participant_count integer not null check (participant_count between 1 and 10),
    max_duration_seconds integer not null constraint recording_reservations_max_duration_seconds_check1 check (max_duration_seconds between 1 and 14400),
    input_bitrate_bps bigint not null check (input_bitrate_bps between 1 and 4000000),
    state text not null check (state in ('reserved', 'released', 'expired')),
    starts_at timestamptz,
    ends_at timestamptz not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, idempotency_key)
);
create unique index recording_reservations_recording_id_idx
    on recording_reservations(recording_id);
create index recording_reservations_active_idx
    on recording_reservations(state, starts_at, ends_at)
    where state = 'reserved';
create index recording_reservations_tenant_created_idx
    on recording_reservations(tenant_id, created_at desc, id desc);

create table recording_pipelines (
    recording_id uuid primary key references recordings(id),
    tenant_id uuid not null references tenants(id),
    reservation_id uuid not null unique references recording_reservations(id),
    capture_epoch bigint not null default 0 check (capture_epoch >= 0),
    state text not null check (state in (
        'requested', 'reserved', 'capture_leased', 'capturing_segmented',
        'capture_complete', 'render_queued', 'rendering', 'verifying',
        'committed', 'retryable_failure', 'terminal_failure', 'deleted'
    )),
    stop_operation_id uuid,
    stop_requested_at timestamptz,
    capture_completed_at timestamptz,
    committed_at timestamptz,
    capture_media_bundle_count integer check (capture_media_bundle_count is null or capture_media_bundle_count >= 0),
    capture_gap_bundle_count integer check (capture_gap_bundle_count is null or capture_gap_bundle_count >= 0),
    capture_track_count integer check (capture_track_count is null or capture_track_count >= 0),
    capture_packet_count bigint check (capture_packet_count is null or capture_packet_count >= 0),
    capture_completeness text check (capture_completeness is null or capture_completeness in ('complete', 'partial')),
    failure_webhook_enqueued boolean not null default false,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint recording_pipelines_stop_pair_check check ((stop_operation_id is null) = (stop_requested_at is null))
);
create index recording_pipelines_tenant_state_idx
    on recording_pipelines(tenant_id, state, updated_at desc);
create unique index recording_pipelines_stop_operation_id_idx
    on recording_pipelines(stop_operation_id)
    where stop_operation_id is not null;

create function recording_sync_failed_status() returns trigger language plpgsql as $$
declare
    failed_code text;
begin
    if new.state = 'terminal_failure' then
        update recordings
        set status = 'failed', failed_at = now(), updated_at = now(),
            failure_code = coalesce(
                (select jobs.error_code from recording_jobs jobs
                 where jobs.recording_id = new.recording_id and jobs.state = 'terminal_failure'
                   and jobs.kind <> 'transcription' and jobs.error_code is not null
                 order by jobs.terminal_at desc nulls last, jobs.updated_at desc limit 1),
                case when old.state in ('requested', 'reserved') then 'capture_reservation_expired' end,
                'recording_failed')
        where id = new.recording_id and status in ('pending', 'processing')
        returning failure_code into failed_code;
        if failed_code is not null then
            -- The Episode's own timeline shows the failure next to the claim that started the work.
            insert into observability_journey_events (
                event_id, journey_id, sequence, occurred_at, name, phase, state,
                origin_kind, first_observed_layer, upstream_visibility, parent_event_id, trace_id, span_id, attributes
            )
            select gen_random_uuid(), journey.journey_id,
                coalesce((select max(events.sequence) + 1 from observability_journey_events events
                          where events.journey_id = journey.journey_id), 0),
                now(), 'recording.failed', 'recording_failure', 'failed', 'server', 'api', 'visible',
                journey.parent_event_id, journey.trace_id, journey.span_id,
                jsonb_build_object('recording_id', new.recording_id, 'failure_code', failed_code)
            from (
                select coalesce(start_operation.journey_id, new.recording_id) as journey_id,
                    start_operation.parent_journey_event_id as parent_event_id,
                    start_operation.producing_trace_id as trace_id, start_operation.producing_span_id as span_id
                from recordings
                left join sync_recordings recording on recording.recording_id = recordings.id
                left join sync_external_operations start_operation
                    on start_operation.external_operation_id = recording.start_external_operation_id
                    and start_operation.recording_id = recordings.id and start_operation.operation_name = 'start_recording'
                where recordings.id = new.recording_id
            ) journey;
        end if;
    elsif old.state = 'terminal_failure' then
        -- A retry reopened the pipeline: the Recording is in flight again, not failed.
        update recordings
        set status = 'pending', failed_at = null, failure_code = null, updated_at = now()
        where id = new.recording_id and status = 'failed';
    end if;
    return null;
end;
$$;

create trigger recording_pipelines_sync_failed_status
    after update of state on recording_pipelines
    for each row when (old.state is distinct from new.state)
    execute function recording_sync_failed_status();

create table recording_jobs (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    episode_id uuid not null references episodes(id),
    recording_id uuid not null references recordings(id),
    kind text not null check (kind in ('capture', 'transcription', 'render')),
    idempotency_key text not null unique,
    payload_schema_version integer not null check (payload_schema_version > 0),
    state text not null check (state in ('pending', 'leased', 'succeeded', 'retryable_failure', 'terminal_failure', 'cancelled')),
    priority integer not null default 0,
    available_at timestamptz not null,
    attempt_count integer not null default 0 check (attempt_count >= 0),
    attempt_limit integer not null check (attempt_limit between 1 and 20),
    lease_token text,
    lease_owner text,
    lease_expires_at timestamptz,
    fencing_generation bigint not null default 0 check (fencing_generation >= 0),
    error_code text,
    error_detail text,
    terminal_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    result_metadata jsonb not null default '{}'::jsonb,
    check (error_code is null or octet_length(error_code) <= 128),
    check (error_detail is null or octet_length(error_detail) <= 2048),
    check ((state = 'leased') = (lease_token is not null and lease_owner is not null and lease_expires_at is not null))
);
create index recording_jobs_claim_idx
    on recording_jobs(kind, state, available_at, priority desc, id)
    where state = 'pending';
create index recording_jobs_lease_recovery_idx
    on recording_jobs(lease_expires_at, id)
    where state = 'leased';
create index recording_jobs_active_lease_owner_idx
    on recording_jobs(lease_owner) where state = 'leased';
create index recording_jobs_dead_letter_idx
    on recording_jobs(tenant_id, terminal_at desc, id)
    where state = 'terminal_failure';
create unique index recording_jobs_recording_kind_idx
    on recording_jobs(recording_id, kind);

create table recording_job_failure_history (
    job_id uuid not null references recording_jobs(id) on delete restrict,
    manual_retry_count integer not null check (manual_retry_count between 1 and 5),
    attempt_count integer not null check (attempt_count >= 0),
    fencing_generation bigint not null check (fencing_generation >= 0),
    error_code text,
    error_detail text,
    failed_at timestamptz not null,
    retried_at timestamptz not null default now(),
    primary key (job_id, manual_retry_count)
);

create table recording_job_attempt_failures (
    job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    kind text not null check (kind in ('capture', 'transcription', 'render')),
    error_code text not null check (octet_length(error_code) <= 128),
    error_detail text not null check (octet_length(error_detail) <= 2048),
    lease_owner text not null check (octet_length(lease_owner) between 1 and 256),
    failed_at timestamptz not null default now(),
    primary key (job_id, attempt_count, fencing_generation)
);

create table recording_job_attempt_authorities (
    job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    claim_request_id uuid not null unique,
    kind text not null check (kind in ('capture', 'transcription', 'render')),
    lease_owner text not null check (octet_length(lease_owner) between 1 and 256),
    lease_token text not null check (octet_length(lease_token) between 1 and 256),
    lease_expires_at timestamptz not null,
    envelope_bytes bytea not null check (octet_length(envelope_bytes) between 1 and 65536),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    issued_at timestamptz not null default now(),
    primary key (job_id, attempt_count, fencing_generation)
);
create index recording_job_attempt_authorities_job_idx
    on recording_job_attempt_authorities(job_id, issued_at desc);

create function reject_recording_job_attempt_authority_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording job attempt authorities are append-only';
end;
$$;

create trigger recording_job_attempt_authorities_immutable
before update or delete on recording_job_attempt_authorities
for each row execute function reject_recording_job_attempt_authority_mutation();

create trigger recording_job_attempt_authorities_no_truncate
before truncate on recording_job_attempt_authorities
for each statement execute function reject_recording_job_attempt_authority_mutation();

create table recording_capture_plans (
    plan_handle uuid not null,
    revision bigint not null check (revision > 0),
    job_id uuid not null,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    tenant_id uuid not null references tenants(id) on delete restrict,
    space_id uuid not null references spaces(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    episode_control_revision bigint not null check (episode_control_revision >= 0),
    provider_incarnation bigint not null check (provider_incarnation >= 0),
    provider_sequence bigint not null check (provider_sequence >= 0),
    plan_schema_version text not null check (plan_schema_version = 'capture_plan.v1'),
    plan_bytes bytea not null check (octet_length(plan_bytes) between 1 and 262144),
    plan_fingerprint bytea not null check (octet_length(plan_fingerprint) = 32),
    effective_deadline_at timestamptz not null,
    created_at timestamptz not null default now(),
    primary key (plan_handle, revision),
    unique (plan_handle, plan_fingerprint),
    foreign key (job_id, attempt_count, fencing_generation)
        references recording_job_attempt_authorities(job_id, attempt_count, fencing_generation)
        on delete restrict
);
create index recording_capture_plans_attempt_idx
    on recording_capture_plans(job_id, attempt_count, fencing_generation, revision desc);

create table recording_capture_retired_publications (
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    publication_id text not null check (octet_length(publication_id) between 1 and 512),
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, publication_id)
);

create function reject_recording_capture_plan_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording capture plans are append-only';
end;
$$;

create trigger recording_capture_plans_immutable
before update or delete on recording_capture_plans
for each row execute function reject_recording_capture_plan_mutation();

create trigger recording_capture_plans_no_truncate
before truncate on recording_capture_plans
for each statement execute function reject_recording_capture_plan_mutation();

alter table recording_job_attempt_authorities
    add constraint recording_job_attempt_authorities_capture_epoch_key
        unique (job_id, attempt_count, fencing_generation, capture_epoch);

create table recording_capture_connections (
    signaling_handle uuid not null,
    capture_epoch bigint not null check (capture_epoch > 0),
    tenant_id uuid not null references tenants(id) on delete restrict,
    space_id uuid not null references spaces(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    job_id uuid not null,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    provider_connection_reference text check (
        provider_connection_reference is null
        or octet_length(provider_connection_reference) between 1 and 512
    ),
    state text not null default 'pending'
        check (state in ('pending', 'connecting', 'connected', 'disconnected', 'closed')),
    latest_plan_revision bigint not null default 0 check (latest_plan_revision >= 0),
    negotiation_id text check (
        negotiation_id is null or octet_length(negotiation_id) between 1 and 512
    ),
    negotiation_requirement text not null default 'not_required'
        check (negotiation_requirement in ('not_required', 'answer_needed', 'offer_needed')),
    negotiation_plan_revision bigint check (
        negotiation_plan_revision is null or negotiation_plan_revision > 0
    ),
    next_sequence bigint not null default 1 check (next_sequence > 0),
    active_command_id bigint,
    active_execution_token uuid,
    active_execution_expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (signaling_handle, capture_epoch),
    foreign key (job_id, attempt_count, fencing_generation, capture_epoch)
        references recording_job_attempt_authorities (
            job_id, attempt_count, fencing_generation, capture_epoch
        ) on delete restrict,
    constraint recording_capture_connections_negotiation_check check (
        (
            negotiation_requirement = 'not_required'
            and negotiation_id is null
            and negotiation_plan_revision is null
        ) or (
            negotiation_requirement in ('answer_needed', 'offer_needed')
            and negotiation_id is not null
            and negotiation_plan_revision is not null
        )
    ),
    constraint recording_capture_connections_active_execution_check check (
        (
            active_command_id is null
            and active_execution_token is null
            and active_execution_expires_at is null
        ) or (
            active_command_id is not null
            and active_execution_token is not null
            and active_execution_expires_at is not null
        )
    )
);
create unique index recording_capture_connections_recording_epoch_idx
    on recording_capture_connections(recording_id, capture_epoch);

create table recording_capture_commands (
    id bigint generated always as identity primary key,
    signaling_handle uuid not null,
    capture_epoch bigint not null check (capture_epoch > 0),
    sequence bigint not null check (sequence > 0),
    recording_id uuid not null references recordings(id) on delete restrict,
    plan_revision bigint not null check (plan_revision > 0),
    operation_kind text not null check (operation_kind in (
        'create_capture_connection',
        'pull_capture_tracks',
        'renegotiate_capture_connection',
        'inspect_capture_connection',
        'close_capture_tracks',
        'close_capture_connection'
    )),
    idempotency_key text not null check (octet_length(idempotency_key) between 1 and 128),
    request_bytes bytea not null check (octet_length(request_bytes) between 1 and 2097152),
    request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
    state text not null default 'queued'
        check (state in ('queued', 'leased', 'completed', 'retryable', 'terminal', 'ambiguous')),
    execution_attempt integer not null default 0 check (execution_attempt >= 0),
    execution_token uuid,
    execution_expires_at timestamptz,
    not_before timestamptz not null default now(),
    result_bytes bytea check (result_bytes is null or octet_length(result_bytes) between 1 and 2097152),
    result_fingerprint bytea check (result_fingerprint is null or octet_length(result_fingerprint) = 32),
    provider_failure_class text check (
        provider_failure_class is null or provider_failure_class in (
            'unavailable', 'rate_limited', 'unauthorized', 'not_found', 'protocol'
        )
    ),
    provider_failure_code text check (
        provider_failure_code is null or octet_length(provider_failure_code) between 1 and 128
    ),
    provider_failure_retryable boolean,
    created_at timestamptz not null default now(),
    leased_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz not null default now(),
    foreign key (signaling_handle, capture_epoch)
        references recording_capture_connections(signaling_handle, capture_epoch) on delete restrict,
    constraint recording_capture_commands_sequence_key
        unique (signaling_handle, capture_epoch, sequence),
    constraint recording_capture_commands_idempotency_key
        unique (
            signaling_handle, capture_epoch, plan_revision,
            operation_kind, idempotency_key
        ),
    constraint recording_capture_commands_execution_check check (
        (
            state = 'leased'
            and execution_token is not null
            and execution_expires_at is not null
        ) or (
            state <> 'leased'
            and execution_token is null
            and execution_expires_at is null
        )
    ),
    constraint recording_capture_commands_result_check check (
        (
            state = 'completed'
            and result_bytes is not null
            and result_fingerprint is not null
        ) or (
            state <> 'completed'
            and result_bytes is null
            and result_fingerprint is null
        )
    ),
    constraint recording_capture_commands_failure_check check (
        (
            state in ('retryable', 'terminal')
            and provider_failure_class is not null
            and provider_failure_retryable is not null
        ) or (
            state not in ('retryable', 'terminal')
            and provider_failure_class is null
            and provider_failure_code is null
            and provider_failure_retryable is null
        )
    )
);
create index recording_capture_commands_ready_idx
    on recording_capture_commands(signaling_handle, capture_epoch, sequence, not_before)
    where state in ('queued', 'retryable', 'leased');

alter table recording_capture_connections
    add constraint recording_capture_connections_active_command_fkey
        foreign key (active_command_id) references recording_capture_commands(id) on delete restrict;

create table recording_capture_provider_rate_budget (
    id smallint primary key check (id = 1),
    next_call_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
insert into recording_capture_provider_rate_budget (id) values (1);

create function protect_recording_capture_connection_authority() returns trigger
language plpgsql as $$
begin
    if old.signaling_handle is distinct from new.signaling_handle
        or old.capture_epoch is distinct from new.capture_epoch
        or old.tenant_id is distinct from new.tenant_id
        or old.space_id is distinct from new.space_id
        or old.episode_id is distinct from new.episode_id
        or old.recording_id is distinct from new.recording_id
        or old.job_id is distinct from new.job_id
        or old.attempt_count is distinct from new.attempt_count
        or old.fencing_generation is distinct from new.fencing_generation
        or old.envelope_digest is distinct from new.envelope_digest then
        raise exception 'recording capture connection authority is immutable';
    end if;
    new.updated_at = now();
    return new;
end;
$$;

create function protect_recording_capture_command() returns trigger
language plpgsql as $$
begin
    if old.signaling_handle is distinct from new.signaling_handle
        or old.capture_epoch is distinct from new.capture_epoch
        or old.sequence is distinct from new.sequence
        or old.recording_id is distinct from new.recording_id
        or old.plan_revision is distinct from new.plan_revision
        or old.operation_kind is distinct from new.operation_kind
        or old.idempotency_key is distinct from new.idempotency_key
        or old.request_bytes is distinct from new.request_bytes
        or old.request_fingerprint is distinct from new.request_fingerprint
        or old.created_at is distinct from new.created_at then
        raise exception 'recording capture command authority is immutable';
    end if;
    if old.state in ('completed', 'terminal', 'ambiguous') then
        raise exception 'terminal recording capture command is immutable';
    end if;
    if not (
        (old.state = 'queued' and new.state = 'leased')
        or (old.state = 'retryable' and new.state = 'leased')
        or (old.state = 'leased' and new.state = 'queued')
        or (old.state = 'leased' and new.state in ('completed', 'retryable', 'terminal', 'ambiguous'))
    ) then
        raise exception 'invalid recording capture command transition from % to %', old.state, new.state;
    end if;
    new.updated_at = now();
    return new;
end;
$$;

create function reject_recording_capture_queue_delete() returns trigger
language plpgsql as $$
begin
    raise exception 'recording capture signaling authority cannot be deleted or truncated';
end;
$$;

create trigger recording_capture_connections_authority_immutable
before update on recording_capture_connections
for each row execute function protect_recording_capture_connection_authority();

create trigger recording_capture_connections_no_delete
before delete on recording_capture_connections
for each row execute function reject_recording_capture_queue_delete();

create trigger recording_capture_connections_no_truncate
before truncate on recording_capture_connections
for each statement execute function reject_recording_capture_queue_delete();

create trigger recording_capture_commands_authority_immutable
before update on recording_capture_commands
for each row execute function protect_recording_capture_command();

create trigger recording_capture_commands_no_delete
before delete on recording_capture_commands
for each row execute function reject_recording_capture_queue_delete();

create trigger recording_capture_commands_no_truncate
before truncate on recording_capture_commands
for each statement execute function reject_recording_capture_queue_delete();

create table recording_bundles (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    recording_id uuid not null references recordings(id),
    capture_job_id uuid not null references recording_jobs(id),
    sequence_number bigint not null check (sequence_number >= 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    object_key text not null,
    content_type text not null,
    codec text not null,
    layer text,
    byte_size bigint not null check (byte_size >= 0),
    checksum bytea not null check (octet_length(checksum) between 16 and 128),
    monotonic_start_millis bigint not null check (monotonic_start_millis >= 0),
    monotonic_end_millis bigint not null check (monotonic_end_millis >= monotonic_start_millis),
    media_start_millis bigint not null check (media_start_millis >= 0),
    media_end_millis bigint not null check (media_end_millis >= media_start_millis),
    created_at timestamptz not null default now(),
    unique (recording_id, sequence_number)
);

create table recording_artifacts (
    recording_id uuid primary key references recordings(id),
    tenant_id uuid not null references tenants(id),
    render_job_id uuid not null references recording_jobs(id),
    object_key text not null,
    content_type text not null,
    byte_size bigint not null check (byte_size >= 0),
    checksum bytea not null check (octet_length(checksum) between 16 and 128),
    duration_millis bigint not null check (duration_millis >= 0),
    committed_at timestamptz not null,
    expires_at timestamptz,
    constraint recording_artifacts_expiry_check check (expires_at is null or expires_at > committed_at),
    created_at timestamptz not null default now()
);

create function reject_recording_object_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording object facts are immutable';
end;
$$;

create trigger recording_bundles_immutable
before update on recording_bundles
for each row execute function reject_recording_object_mutation();

create trigger recording_artifacts_immutable
before update on recording_artifacts
for each row execute function reject_recording_object_mutation();

create table observability_journey_events (
    event_id uuid primary key,
    journey_id uuid not null,
    sequence bigint not null check (sequence >= 0),
    occurred_at timestamptz not null,
    received_at timestamptz not null default now(),
    name text not null,
    phase text not null,
    state text not null,
    origin_kind text not null,
    first_observed_layer text not null,
    upstream_visibility text not null,
    parent_event_id uuid,
    trace_id text,
    span_id text,
    attributes jsonb not null default '{}'::jsonb,
    check (jsonb_typeof(attributes) = 'object')
);
create index observability_journey_events_journey_order_idx
    on observability_journey_events(journey_id, sequence asc, occurred_at asc, event_id asc);
create index observability_journey_events_terminal_idx
    on observability_journey_events(journey_id, sequence desc, occurred_at desc, event_id desc)
    where phase = 'terminal'
        and state in ('completed', 'succeeded', 'failed', 'cancelled', 'canceled', 'exhausted', 'erased');

alter table sync_lifecycle_intents
    add column journey_id uuid,
    add column parent_journey_event_id uuid,
    add column producing_trace_id text,
    add column producing_span_id text,
    add constraint sync_lifecycle_intents_trace_id_check
        check (producing_trace_id is null or producing_trace_id ~ '^[0-9a-f]{32}$'),
    add constraint sync_lifecycle_intents_span_id_check
        check (producing_span_id is null or producing_span_id ~ '^[0-9a-f]{16}$');

create table webhook_tenant_state (
    tenant_id uuid primary key references tenants(id) on delete cascade,
    updated_at timestamptz not null default now()
);

create table webhook_endpoints (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    name text not null,
    enabled boolean not null,
    revision integer not null,
    current_target_revision integer not null,
    current_secret_ciphertext bytea,
    previous_secret_ciphertext bytea,
    previous_secret_expires_at timestamptz,
    created_by_user_id uuid references users(id) on delete set null,
    deleted_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint webhook_endpoints_tenant_id_id_key unique (tenant_id, id),
    constraint webhook_endpoints_name_check
        check (char_length(btrim(name)) between 1 and 100 and name = btrim(name)),
    constraint webhook_endpoints_revision_check
        check (revision > 0 and current_target_revision > 0),
    constraint webhook_endpoints_previous_secret_check check (
        (previous_secret_ciphertext is null and previous_secret_expires_at is null)
        or
        (previous_secret_ciphertext is not null and previous_secret_expires_at is not null)
    ),
    constraint webhook_endpoints_deleted_secret_check check (
        (deleted_at is null and current_secret_ciphertext is not null)
        or
        (
            deleted_at is not null
            and not enabled
            and current_secret_ciphertext is null
            and previous_secret_ciphertext is null
            and previous_secret_expires_at is null
        )
    )
);

create index webhook_endpoints_tenant_created_at_id_idx
    on webhook_endpoints(tenant_id, created_at desc, id desc)
    where deleted_at is null;

create table webhook_endpoint_revisions (
    id uuid primary key,
    tenant_id uuid not null,
    endpoint_id uuid not null,
    revision integer not null,
    url_ciphertext bytea,
    url_redacted text not null,
    url_destroyed_at timestamptz,
    api_version integer not null,
    event_types text[] not null,
    created_at timestamptz not null default now(),
    constraint webhook_endpoint_revisions_tenant_id_id_key
        unique (tenant_id, id),
    constraint webhook_endpoint_revisions_identity_key
        unique (tenant_id, endpoint_id, revision),
    constraint webhook_endpoint_revisions_delivery_key
        unique (tenant_id, id, endpoint_id, revision),
    constraint webhook_endpoint_revisions_endpoint_fkey
        foreign key (tenant_id, endpoint_id)
        references webhook_endpoints(tenant_id, id)
        on delete cascade,
    constraint webhook_endpoint_revisions_revision_check check (revision > 0),
    constraint webhook_endpoint_revisions_url_check
        check (octet_length(url_redacted) between 1 and 2048),
    constraint webhook_endpoint_revisions_url_ciphertext_check check (
        (url_ciphertext is not null and url_destroyed_at is null)
        or (url_ciphertext is null and url_destroyed_at is not null)
    ),
    constraint webhook_endpoint_revisions_api_version_check check (api_version = 1),
    constraint webhook_endpoint_revisions_event_types_check check (
        cardinality(event_types) between 1 and 16
        and event_types <@ array[
            'space.created',
            'space.updated',
            'space.archived',
            'space.restored',
            'episode.started',
            'episode.ended',
            'participant.joined',
            'participant.left',
            'participant.focus_changed',
            'focus.completed',
            'recording.started',
            'recording.completed',
            'recording.failed',
            'transcript.started',
            'transcript.completed',
            'transcript.failed'
        ]::text[]
    )
);

alter table webhook_endpoints
    add constraint webhook_endpoints_current_revision_fkey
    foreign key (tenant_id, id, current_target_revision)
    references webhook_endpoint_revisions(tenant_id, endpoint_id, revision)
    on delete restrict
    deferrable initially deferred;

create table webhook_events (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    event_name text not null,
    api_version integer not null,
    occurred_at timestamptz not null,
    body bytea,
    body_sha256 bytea not null,
    semantic_transition_key text not null,
    resource_type text not null,
    resource_id uuid not null,
    linked_user_id uuid references users(id) on delete restrict,
    journey_id uuid not null,
    parent_journey_event_id uuid,
    producing_trace_id text,
    producing_span_id text,
    erased_at timestamptz,
    created_at timestamptz not null default now(),
    constraint webhook_events_tenant_id_id_key unique (tenant_id, id),
    constraint webhook_events_semantic_transition_key
        unique (tenant_id, semantic_transition_key, api_version),
    constraint webhook_events_name_check check (event_name in (
        'space.created',
        'space.updated',
        'space.archived',
        'space.restored',
        'episode.started',
        'episode.ended',
        'participant.joined',
        'participant.left',
        'participant.focus_changed',
        'focus.completed',
        'recording.started',
        'recording.completed',
        'recording.failed',
        'transcript.started',
        'transcript.completed',
        'transcript.failed',
        'endpoint.test'
    )),
    constraint webhook_events_api_version_check check (api_version = 1),
    constraint webhook_events_body_hash_check check (octet_length(body_sha256) = 32),
    constraint webhook_events_body_check check (
        (
            body is not null
            and octet_length(body) between 1 and 262144
            and erased_at is null
        )
        or (body is null and erased_at is not null)
    ),
    constraint webhook_events_semantic_key_check
        check (octet_length(semantic_transition_key) between 1 and 200),
    constraint webhook_events_resource_type_check check (resource_type in (
        'space', 'episode', 'participant', 'recording', 'transcript', 'webhook_endpoint'
    )),
    constraint webhook_events_trace_id_check
        check (producing_trace_id is null or producing_trace_id ~ '^[0-9a-f]{32}$'),
    constraint webhook_events_span_id_check
        check (producing_span_id is null or producing_span_id ~ '^[0-9a-f]{16}$')
);

create index webhook_events_tenant_occurred_at_id_idx
    on webhook_events(tenant_id, occurred_at desc, id desc);
create index webhook_events_linked_user_id_idx
    on webhook_events(linked_user_id, occurred_at, id)
    where linked_user_id is not null and erased_at is null;
create index webhook_events_retention_idx
    on webhook_events(occurred_at, tenant_id, id);

create function enqueue_recording_failure_webhook_once() returns trigger language plpgsql as $$
begin
    -- The capture can outlive webhook retention. Keep the enqueue fact with
    -- the Recording, not the event that the webhook worker will prune.
    update recording_pipelines
    set failure_webhook_enqueued = true
    where recording_id = new.resource_id and tenant_id = new.tenant_id
        and not failure_webhook_enqueued;
    if found then
        return new;
    end if;
    return null;
end;
$$;

create trigger webhook_events_recording_failure_once
    before insert on webhook_events
    for each row when (new.event_name = 'recording.failed')
    execute function enqueue_recording_failure_webhook_once();

create table webhook_deliveries (
    id uuid primary key,
    tenant_id uuid not null,
    event_id uuid not null,
    endpoint_id uuid not null,
    endpoint_revision_id uuid not null,
    endpoint_revision integer not null,
    state text not null,
    next_attempt_at timestamptz,
    attempt_count integer not null default 0,
    lease_token uuid,
    lease_owner text,
    lease_expires_at timestamptz,
    terminal_at timestamptz,
    queued_journey_event_id uuid not null,
    terminal_journey_event_id uuid,
    parent_delivery_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint webhook_deliveries_tenant_id_id_key unique (tenant_id, id),
    constraint webhook_deliveries_event_fkey
        foreign key (tenant_id, event_id)
        references webhook_events(tenant_id, id)
        on delete cascade,
    constraint webhook_deliveries_revision_fkey
        foreign key (tenant_id, endpoint_revision_id, endpoint_id, endpoint_revision)
        references webhook_endpoint_revisions(tenant_id, id, endpoint_id, revision)
        on delete cascade,
    constraint webhook_deliveries_parent_fkey
        foreign key (tenant_id, parent_delivery_id)
        references webhook_deliveries(tenant_id, id)
        on delete cascade,
    constraint webhook_deliveries_state_check check (state in (
        'pending', 'delivering', 'retry_wait', 'succeeded', 'exhausted', 'canceled', 'erased'
    )),
    constraint webhook_deliveries_attempt_count_check
        check (attempt_count between 0 and 11),
    constraint webhook_deliveries_lease_check check (
        (
            state = 'delivering'
            and lease_token is not null
            and lease_owner is not null
            and lease_expires_at is not null
        )
        or
        (
            state <> 'delivering'
            and lease_token is null
            and lease_owner is null
            and lease_expires_at is null
        )
    ),
    constraint webhook_deliveries_schedule_check check (
        (state in ('pending', 'retry_wait') and next_attempt_at is not null and terminal_at is null)
        or (state = 'delivering' and next_attempt_at is null and terminal_at is null)
        or (state in ('succeeded', 'exhausted', 'canceled', 'erased') and next_attempt_at is null and terminal_at is not null)
    )
);

create unique index webhook_deliveries_automatic_fanout_key
    on webhook_deliveries(tenant_id, event_id, endpoint_revision_id)
    where parent_delivery_id is null;
create index webhook_deliveries_claim_idx
    on webhook_deliveries(next_attempt_at, created_at, id)
    where state in ('pending', 'retry_wait');
create index webhook_deliveries_lease_expiry_idx
    on webhook_deliveries(lease_expires_at, tenant_id, id)
    where state = 'delivering';
create index webhook_deliveries_endpoint_state_idx
    on webhook_deliveries(tenant_id, endpoint_id, state, created_at desc, id desc);
create index webhook_deliveries_tenant_created_at_id_idx
    on webhook_deliveries(tenant_id, created_at desc, id desc);

create table webhook_delivery_attempts (
    id uuid primary key,
    tenant_id uuid not null,
    delivery_id uuid not null,
    attempt_number integer not null,
    started_at timestamptz not null,
    finished_at timestamptz,
    latency_milliseconds integer,
    outcome text not null,
    http_status integer,
    error_code text,
    trace_id text,
    span_id text,
    created_at timestamptz not null default now(),
    constraint webhook_delivery_attempts_tenant_id_id_key unique (tenant_id, id),
    constraint webhook_delivery_attempts_delivery_fkey
        foreign key (tenant_id, delivery_id)
        references webhook_deliveries(tenant_id, id)
        on delete cascade,
    constraint webhook_delivery_attempts_number_key
        unique (tenant_id, delivery_id, attempt_number),
    constraint webhook_delivery_attempts_number_check
        check (attempt_number between 1 and 11),
    constraint webhook_delivery_attempts_outcome_check check (outcome in (
        'started', 'succeeded', 'retryable_failure', 'terminal_failure', 'lease_expired'
    )),
    constraint webhook_delivery_attempts_completion_check check (
        (
            outcome = 'started'
            and finished_at is null
            and latency_milliseconds is null
            and http_status is null
            and error_code is null
        )
        or
        (
            outcome <> 'started'
            and finished_at is not null
            and latency_milliseconds >= 0
        )
    ),
    constraint webhook_delivery_attempts_http_status_check
        check (http_status is null or http_status between 100 and 599),
    constraint webhook_delivery_attempts_error_code_check
        check (error_code is null or octet_length(error_code) between 1 and 96),
    constraint webhook_delivery_attempts_trace_id_check
        check (trace_id is null or trace_id ~ '^[0-9a-f]{32}$'),
    constraint webhook_delivery_attempts_span_id_check
        check (span_id is null or span_id ~ '^[0-9a-f]{16}$')
);


create table webhook_idempotency_records (
    tenant_id uuid not null references tenants(id) on delete cascade,
    operation text not null,
    idempotency_key text not null,
    request_sha256 bytea not null,
    response_status integer not null,
    response_ciphertext bytea,
    resource_id uuid,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, operation, idempotency_key),
    constraint webhook_idempotency_records_operation_check check (operation in (
        'endpoint.create',
        'endpoint.patch',
        'endpoint.delete',
        'endpoint.rotate_secret',
        'endpoint.test',
        'delivery.redeliver'
    )),
    constraint webhook_idempotency_records_key_check
        check (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    constraint webhook_idempotency_records_hash_check
        check (octet_length(request_sha256) = 32),
    constraint webhook_idempotency_records_status_check
        check (response_status between 200 and 299),
    constraint webhook_idempotency_records_expiry_check
        check (expires_at > created_at)
);

create index webhook_idempotency_records_expiry_idx
    on webhook_idempotency_records(expires_at, tenant_id);

create table provider_operation_receipts (
    operation_id text not null,
    effect text not null,
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    participant_id uuid,
    participant_generation bigint,
    publication_source text,
    recording_id uuid,
    request_fingerprint bytea not null,
    request_payload jsonb not null,
    state text not null default 'prepared',
    outcome text,
    reason text,
    last_error_code text,
    created_at timestamptz not null default now(),
    dispatching_at timestamptz,
    completed_at timestamptz,
    primary key (operation_id, effect),
    constraint provider_operation_receipts_operation_id_check check (
        operation_id ~ '^[A-Za-z0-9_-]{16,128}$'
    ),
    constraint provider_operation_receipts_effect_check check (effect in (
        'media.grant_publication', 'media.revoke_publication',
        'media.remove_participant', 'media.end_episode',
        'recording.start', 'recording.stop'
    )),
    constraint provider_operation_receipts_fingerprint_check check (octet_length(request_fingerprint) = 32),
    constraint provider_operation_receipts_payload_check check (octet_length(request_payload::text) <= 16384),
    constraint provider_operation_receipts_state_check check (state in ('prepared', 'dispatching', 'completed')),
    constraint provider_operation_receipts_outcome_check check (outcome is null or outcome in (
        'confirmed', 'satisfied', 'retryable_failure', 'terminal_failure', 'ambiguous'
    )),
    constraint provider_operation_receipts_error_code_check check (last_error_code is null or octet_length(last_error_code) between 1 and 256),
    constraint provider_operation_receipts_reason_check check (reason is null or octet_length(reason) between 1 and 256),
    constraint provider_operation_receipts_participant_check check (
        (participant_id is not null or participant_generation is null)
        and (participant_generation is null or participant_generation > 0)
    ),
    constraint provider_operation_receipts_source_check check (
        publication_source is null or publication_source in ('microphone', 'camera', 'screen')
    ),
    constraint provider_operation_receipts_state_outcome_check check (
        (state in ('prepared', 'dispatching') and outcome is null and completed_at is null)
        or (state = 'completed' and outcome is not null and completed_at is not null)
    ),
    constraint provider_operation_receipts_dispatching_check check (
        (state = 'prepared' and dispatching_at is null)
        or (state in ('dispatching', 'completed') and dispatching_at is not null)
    ),
    constraint provider_operation_receipts_effect_fields_check check (
        (
            effect in ('media.grant_publication', 'media.revoke_publication')
            and participant_id is not null
            and publication_source is not null
            and recording_id is null
        )
        or (
            effect = 'media.remove_participant'
            and participant_id is not null
            and publication_source is null
            and recording_id is null
        )
        or (
            effect = 'media.end_episode'
            and participant_id is null
            and publication_source is null
            and recording_id is null
        )
        or (
            effect in ('recording.start', 'recording.stop')
            and participant_id is null
            and publication_source is null
            and recording_id is not null
        )
    )
);

create index provider_operation_receipts_episode_idx
    on provider_operation_receipts(tenant_id, episode_id, created_at desc, operation_id, effect);

create table provider_operation_observation_heads (
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    incarnation bigint not null default 0,
    sequence bigint not null default 0,
    observation_fingerprint bytea not null default decode(repeat('00', 32), 'hex'),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, episode_id),
    constraint provider_operation_observation_heads_cursor_check check (
        incarnation >= 0 and sequence >= 0
    ),
    constraint provider_operation_observation_heads_fingerprint_check check (octet_length(observation_fingerprint) = 32)
);

create table provider_operation_observations (
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    incarnation bigint not null,
    sequence bigint not null,
    publications jsonb not null,
    observation_fingerprint bytea not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, incarnation, sequence),
    constraint provider_operation_observations_cursor_check check (incarnation >= 0 and sequence >= 0),
    constraint provider_operation_observations_publications_check check (
        jsonb_typeof(publications) = 'array' and octet_length(publications::text) <= 16384
    ),
    constraint provider_operation_observations_fingerprint_check check (octet_length(observation_fingerprint) = 32)
);


create function notify_provider_publication_observation() returns trigger
language plpgsql as $$
declare
    episode_space_id uuid;
begin
    select space_id into episode_space_id
    from episodes
    where tenant_id = new.tenant_id and id = new.episode_id;

    if episode_space_id is not null then
        perform pg_notify(
            'chalk_media_publications',
            new.tenant_id::text || ':' || episode_space_id::text || ':' || new.episode_id::text
        );
    end if;
    return new;
end;
$$;

create trigger provider_publication_observation_notify
after insert on provider_operation_observations
for each row execute function notify_provider_publication_observation();

create table recording_data_keys (
    recording_id uuid not null references recordings(id) on delete restrict,
    capture_epoch bigint not null check (capture_epoch > 0),
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    key_handle uuid not null,
    environment text not null,
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    encryption_context_digest bytea not null check (octet_length(encryption_context_digest) = 32),
    ciphertext_blob bytea not null check (octet_length(ciphertext_blob) > 0),
    created_at timestamptz not null default now(),
    primary key (recording_id, capture_epoch),
    unique (key_handle)
);
create index recording_data_keys_authority_idx
    on recording_data_keys(tenant_id, recording_id, capture_epoch);

create table recording_bundle_allocations (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    job_id uuid not null references recording_jobs(id) on delete restrict,
    object_handle uuid not null,
    reservation_request_id uuid not null,
    allocation_version bigint not null check (allocation_version > 0),
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    sequence_number bigint not null check (sequence_number >= 0),
    codec text not null,
    layer text,
    monotonic_start_millis bigint not null check (monotonic_start_millis >= 0),
    monotonic_end_millis bigint not null check (monotonic_end_millis >= monotonic_start_millis),
    media_start_millis bigint not null check (media_start_millis >= 0),
    media_end_millis bigint not null check (media_end_millis >= media_start_millis),
    object_key text not null,
    upload_token_hash bytea not null check (octet_length(upload_token_hash) = 32),
    expected_byte_size bigint not null check (expected_byte_size >= 0),
    expected_checksum bytea not null check (octet_length(expected_checksum) = 32),
    content_type text not null,
    expires_at timestamptz not null,
    encryption_context_digest bytea not null check (octet_length(encryption_context_digest) = 32),
    state text not null default 'allocated' check (state in ('reserved', 'allocated', 'committed')),
    object_version text,
    object_etag text,
    object_checksum bytea,
    manifest_digest bytea,
    committed_at timestamptz,
    created_at timestamptz not null default now(),
    unique (upload_token_hash),
    unique (object_key),
    unique (job_id, attempt_count, reservation_request_id),
    unique (recording_id, sequence_number),
    constraint recording_bundle_allocations_commit_facts_check check (
        (state in ('reserved', 'allocated') and object_version is null and object_etag is null and object_checksum is null and manifest_digest is null and committed_at is null)
        or (state = 'committed' and object_version is not null and object_etag is not null and octet_length(object_checksum) = 32 and octet_length(manifest_digest) = 32 and committed_at is not null)
    )
);
create index recording_bundle_allocations_authority_idx
    on recording_bundle_allocations(tenant_id, recording_id, capture_epoch, sequence_number);

alter table recording_bundles
    add column allocation_id uuid unique references recording_bundle_allocations(id) on delete restrict,
    add column object_version text,
    add column object_etag text,
    add column capture_epoch bigint,
    add column envelope_digest bytea,
    add column encryption_context_digest bytea,
    add column manifest_digest bytea;

create function protect_recording_data_key_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording data keys are append-only';
end;
$$;

create trigger recording_data_keys_immutable
before update or delete on recording_data_keys
for each row execute function protect_recording_data_key_mutation();

create trigger recording_data_keys_no_truncate
before truncate on recording_data_keys
for each statement execute function protect_recording_data_key_mutation();

create function protect_recording_bundle_allocation_mutation() returns trigger
language plpgsql as $$
begin
    if old.id <> new.id
        or old.tenant_id <> new.tenant_id
        or old.episode_id <> new.episode_id
        or old.recording_id <> new.recording_id
        or old.job_id <> new.job_id
        or old.object_handle <> new.object_handle
        or old.reservation_request_id <> new.reservation_request_id
        or old.allocation_version <> new.allocation_version
        or old.attempt_count <> new.attempt_count
        or old.fencing_generation <> new.fencing_generation
        or old.capture_epoch <> new.capture_epoch
        or old.envelope_digest <> new.envelope_digest
        or old.sequence_number <> new.sequence_number
        or old.object_key <> new.object_key
        or old.encryption_context_digest <> new.encryption_context_digest
        or old.created_at <> new.created_at then
        raise exception 'recording bundle allocation authority is immutable';
    end if;

    if old.state = 'reserved' and new.state = 'allocated' then
        return new;
    end if;

    if old.state = 'allocated' and new.state = 'allocated' then
        if old.expected_byte_size is distinct from new.expected_byte_size
            or old.expected_checksum is distinct from new.expected_checksum
            or old.content_type is distinct from new.content_type
            or old.expires_at is distinct from new.expires_at
            or old.codec is distinct from new.codec
            or old.layer is distinct from new.layer
            or old.monotonic_start_millis is distinct from new.monotonic_start_millis
            or old.monotonic_end_millis is distinct from new.monotonic_end_millis
            or old.media_start_millis is distinct from new.media_start_millis
            or old.media_end_millis is distinct from new.media_end_millis
            or old.object_version is not null
            or old.object_etag is not null
            or old.object_checksum is not null
            or old.manifest_digest is not null
            or old.committed_at is not null then
            raise exception 'recording bundle allocation upload facts are immutable';
        end if;
        return new;
    end if;

    if old.state = 'allocated' and new.state = 'committed' then
        if old.upload_token_hash is distinct from new.upload_token_hash
            or old.expected_byte_size is distinct from new.expected_byte_size
            or old.expected_checksum is distinct from new.expected_checksum
            or old.content_type is distinct from new.content_type
            or old.expires_at is distinct from new.expires_at
            or old.codec is distinct from new.codec
            or old.layer is distinct from new.layer
            or old.monotonic_start_millis is distinct from new.monotonic_start_millis
            or old.monotonic_end_millis is distinct from new.monotonic_end_millis
            or old.media_start_millis is distinct from new.media_start_millis
            or old.media_end_millis is distinct from new.media_end_millis then
            raise exception 'recording bundle allocation upload facts are immutable';
        end if;
        return new;
    end if;

    raise exception 'recording bundle allocation state transition is invalid';
end;
$$;

create trigger recording_bundle_allocations_authority_immutable
before update on recording_bundle_allocations
for each row execute function protect_recording_bundle_allocation_mutation();

create function reject_recording_bundle_allocation_delete() returns trigger
language plpgsql as $$
begin
    raise exception 'recording bundle allocations are append-only';
end;
$$;

create trigger recording_bundle_allocations_no_delete
before delete on recording_bundle_allocations
for each row execute function reject_recording_bundle_allocation_delete();

create trigger recording_bundle_allocations_no_truncate
before truncate on recording_bundle_allocations
for each statement execute function reject_recording_bundle_allocation_delete();


alter table recording_pipelines
    add column capture_ready_at timestamptz;

comment on column recording_pipelines.capture_ready_at is
    'Immutable recording clock origin established by the first authoritative capture-ready callback.';



create table recording_presentation_baselines (
    presentation_handle uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    space_id uuid not null references spaces(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    schema_version text not null check (schema_version = 'recording_presentation.v1'),
    profile_version text not null check (octet_length(profile_version) between 1 and 128),
    profile jsonb not null check (
        jsonb_typeof(profile) = 'object'
        and profile ->> 'version' = profile_version
        and octet_length(profile::text) between 2 and 32768
    ),
    space_name text not null check (octet_length(space_name) between 1 and 256),
    episode_control_revision bigint not null check (episode_control_revision >= 0),
    episode_folded_state jsonb not null check (jsonb_typeof(episode_folded_state) = 'object'),
    participant_facts jsonb not null check (jsonb_typeof(participant_facts) = 'array'),
    chat_head_sequence bigint not null check (chat_head_sequence >= 0),
    chat_retained_floor_sequence bigint,
    whiteboard_scene_id uuid,
    whiteboard_revision bigint check (whiteboard_revision is null or whiteboard_revision >= 0),
    whiteboard_snapshot jsonb,
    baseline_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (recording_id),
    unique (tenant_id, space_id, episode_id, recording_id),
    check ((whiteboard_scene_id is null) = (whiteboard_revision is null)),
    check ((whiteboard_scene_id is null) = (whiteboard_snapshot is null)),
    check (whiteboard_snapshot is null or jsonb_typeof(whiteboard_snapshot) = 'object'),
    check (chat_retained_floor_sequence is null or chat_retained_floor_sequence between 1 and chat_head_sequence + 1)
);

create table recording_presentation_sources (
    presentation_handle uuid primary key references recording_presentation_baselines(presentation_handle) on delete restrict,
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid not null,
    capture_epoch bigint not null check (capture_epoch > 0),
    capture_ready_at timestamptz not null,
    episode_control_start_revision bigint not null check (episode_control_start_revision >= 0),
    episode_control_events jsonb not null check (jsonb_typeof(episode_control_events) = 'array'),
    episode_control_end_revision bigint not null check (episode_control_end_revision >= episode_control_start_revision),
    participant_facts jsonb not null check (jsonb_typeof(participant_facts) = 'array'),
    chat_start_sequence bigint not null check (chat_start_sequence >= 0),
    chat_retained_floor_sequence bigint,
    initial_chat_messages jsonb not null check (jsonb_typeof(initial_chat_messages) = 'array'),
    whiteboard_start_revision bigint not null check (whiteboard_start_revision >= 0),
    whiteboard_events jsonb not null check (jsonb_typeof(whiteboard_events) = 'array'),
    whiteboard_end_revision bigint not null check (whiteboard_end_revision >= whiteboard_start_revision),
    capture_plan_start_revision bigint not null check (capture_plan_start_revision >= 0),
    created_at timestamptz not null default now(),
    unique (recording_id, capture_epoch),
    unique (tenant_id, space_id, episode_id, recording_id, presentation_handle),
    foreign key (tenant_id, space_id, episode_id, recording_id)
        references recording_presentation_baselines(tenant_id, space_id, episode_id, recording_id)
        on delete restrict,
    check (chat_retained_floor_sequence is null or chat_retained_floor_sequence between 1 and chat_start_sequence + 1),
    check (jsonb_array_length(initial_chat_messages) <= 100)
);

create table recording_presentations (
    presentation_handle uuid primary key references recording_presentation_sources(presentation_handle) on delete restrict,
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid not null,
    capture_epoch bigint not null check (capture_epoch > 0),
    schema_version text not null check (schema_version = 'recording_presentation.v1'),
    profile_version text not null check (octet_length(profile_version) between 1 and 128),
    duration_millis bigint not null check (duration_millis >= 0),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    presentation_object_key text not null check (octet_length(presentation_object_key) between 1 and 1024),
    presentation_object_version text not null check (octet_length(presentation_object_version) <= 1024),
    presentation_object_etag text not null check (octet_length(presentation_object_etag) between 1 and 512),
    presentation_content_type text not null check (presentation_content_type = 'application/json'),
    presentation_byte_size bigint not null check (presentation_byte_size between 1 and 67108864),
    asset_manifest_object_key text not null check (octet_length(asset_manifest_object_key) between 1 and 1024),
    asset_manifest_object_version text not null check (octet_length(asset_manifest_object_version) <= 1024),
    asset_manifest_object_etag text not null check (octet_length(asset_manifest_object_etag) between 1 and 512),
    asset_manifest_content_type text not null check (asset_manifest_content_type = 'application/json'),
    asset_manifest_byte_size bigint not null check (asset_manifest_byte_size between 1 and 1048576),
    asset_manifest_sha256 bytea not null check (octet_length(asset_manifest_sha256) = 32),
    frozen_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (recording_id),
    unique (tenant_id, recording_id, presentation_handle),
    foreign key (tenant_id, space_id, episode_id, recording_id, presentation_handle)
        references recording_presentation_sources(tenant_id, space_id, episode_id, recording_id, presentation_handle)
        on delete restrict
);

create table recording_presentation_assets (
    presentation_handle uuid not null,
    tenant_id uuid not null,
    recording_id uuid not null,
    ordinal smallint not null check (ordinal between 0 and 255),
    asset_id text not null check (octet_length(asset_id) between 1 and 512),
    asset_kind text not null check (asset_kind in ('logo', 'avatar', 'chat_attachment', 'whiteboard_state', 'whiteboard_file', 'font', 'screen_annotation')),
    object_key text not null check (octet_length(object_key) between 1 and 1024),
    object_version text not null check (octet_length(object_version) <= 1024),
    object_etag text not null check (octet_length(object_etag) between 1 and 512),
    content_type text not null check (octet_length(content_type) between 1 and 255),
    byte_size bigint not null check (byte_size > 0),
    sha256 bytea not null check (octet_length(sha256) = 32),
    created_at timestamptz not null default now(),
    primary key (presentation_handle, ordinal),
    unique (presentation_handle, asset_id),
    foreign key (tenant_id, recording_id, presentation_handle)
        references recording_presentations(tenant_id, recording_id, presentation_handle)
        on delete restrict
);

create table recording_presentation_reactions (
    reaction_id uuid primary key,
    presentation_handle uuid not null,
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null check (participant_generation > 0),
    display_name text not null check (octet_length(display_name) between 1 and 256),
    reaction text not null check (reaction in ('👍', '❤️', '😂', '😮', '😢', '🎉')),
    occurred_at timestamptz not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    foreign key (tenant_id, space_id, episode_id, recording_id, presentation_handle)
        references recording_presentation_sources(tenant_id, space_id, episode_id, recording_id, presentation_handle)
        on delete restrict,
    foreign key (tenant_id, space_id, episode_id, participant_id, participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (expires_at > occurred_at)
);
create index recording_presentation_reactions_timeline_idx
    on recording_presentation_reactions(presentation_handle, occurred_at, reaction_id);

-- +goose StatementBegin
create function reject_recording_presentation_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording presentation authority is append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_presentation_baselines_immutable
before update or delete on recording_presentation_baselines
for each row execute function reject_recording_presentation_mutation();
create trigger recording_presentation_sources_immutable
before update or delete on recording_presentation_sources
for each row execute function reject_recording_presentation_mutation();
create trigger recording_presentations_immutable
before update or delete on recording_presentations
for each row execute function reject_recording_presentation_mutation();
create trigger recording_presentation_assets_immutable
before update or delete on recording_presentation_assets
for each row execute function reject_recording_presentation_mutation();
create trigger recording_presentation_reactions_immutable
before update or delete on recording_presentation_reactions
for each row execute function reject_recording_presentation_mutation();



create table recording_render_inputs (
    render_input_handle uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    space_id uuid not null references spaces(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    render_job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    key_handle uuid not null,
    object_handle uuid not null unique,
    presentation_handle uuid not null references recording_presentations(presentation_handle) on delete restrict,
    presentation_schema_version text not null check (presentation_schema_version = 'recording_presentation.v1'),
    presentation_profile_version text not null check (octet_length(presentation_profile_version) between 1 and 128),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    presentation_duration_millis bigint not null check (presentation_duration_millis > 0),
    capture_ready_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (render_job_id, attempt_count, fencing_generation),
    foreign key (render_job_id, attempt_count, fencing_generation)
        references recording_job_attempt_authorities(job_id, attempt_count, fencing_generation)
        on delete restrict
);
create index recording_render_inputs_recording_idx
    on recording_render_inputs(tenant_id, recording_id, capture_epoch);

create table recording_render_object_allocations (
    id uuid primary key,
    reservation_request_id uuid not null,
    allocation_version bigint not null check (allocation_version > 0),
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    render_job_id uuid not null references recording_jobs(id) on delete restrict,
    render_input_handle uuid not null references recording_render_inputs(render_input_handle) on delete restrict,
    object_handle uuid not null,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    purpose text not null check (purpose in ('recording_video', 'transcription_manifest', 'transcription_audio')),
    state text not null check (state in ('reserved', 'allocated', 'committed')),
    object_key text not null unique,
    expected_content_type text,
    expected_byte_size bigint,
    expected_sha256 bytea,
    expected_duration_millis bigint,
    upload_token_hash bytea,
    upload_expires_at timestamptz,
    object_version text,
    object_etag text,
    object_content_type text,
    object_byte_size bigint,
    object_sha256 bytea,
    committed_at timestamptz,
    created_at timestamptz not null default now(),
    unique (object_handle, reservation_request_id),
	unique (recording_id, allocation_version),
    constraint recording_render_allocations_expected_facts_check check (
        (state = 'reserved' and expected_content_type is null and expected_byte_size is null and expected_sha256 is null and expected_duration_millis is null and upload_token_hash is null and upload_expires_at is null)
        or (state in ('allocated', 'committed') and expected_content_type is not null and expected_byte_size > 0 and octet_length(expected_sha256) = 32 and octet_length(upload_token_hash) = 32 and upload_expires_at is not null)
    ),
    constraint recording_render_allocations_purpose_facts_check check (
		(purpose = 'recording_video' and (state = 'reserved' or (expected_content_type = 'video/mp4' and expected_byte_size <= 34359738368 and expected_duration_millis between 1 and 14400000)))
		or (purpose = 'transcription_manifest' and (state = 'reserved' or (expected_content_type = 'application/json' and expected_byte_size <= 1048576 and expected_duration_millis is null)))
		or (purpose = 'transcription_audio' and (state = 'reserved' or (expected_content_type = 'audio/flac' and expected_byte_size <= 524288000 and expected_duration_millis between 1 and 900000)))
    ),
    constraint recording_render_allocations_committed_facts_check check (
        (state <> 'committed' and object_version is null and object_etag is null and object_content_type is null and object_byte_size is null and object_sha256 is null and committed_at is null)
		or (state = 'committed' and length(object_version) between 0 and 256 and length(object_etag) between 1 and 256 and object_content_type = expected_content_type and object_byte_size = expected_byte_size and object_sha256 = expected_sha256 and committed_at is not null)
    )
);
create index recording_render_allocations_authority_idx
    on recording_render_object_allocations(render_job_id, attempt_count, fencing_generation, purpose, state);
create index recording_render_allocations_token_idx
    on recording_render_object_allocations(upload_token_hash)
    where upload_token_hash is not null;

create table recording_render_commits (
    render_job_id uuid primary key references recording_jobs(id) on delete restrict,
    tenant_id uuid not null references tenants(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    render_input_handle uuid not null references recording_render_inputs(render_input_handle) on delete restrict,
    commit_digest bytea not null check (octet_length(commit_digest) = 32),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    duration_millis bigint not null check (duration_millis > 0),
    video_allocation_id uuid not null references recording_render_object_allocations(id) on delete restrict,
    ffprobe_facts_digest bytea not null check (octet_length(ffprobe_facts_digest) = 32),
	transcription_source_id uuid references recording_transcription_sources(recording_id) on delete restrict,
    transcription_job_ids uuid[] not null default '{}',
    committed_at timestamptz not null default now(),
    unique (recording_id)
);

create table recording_transcription_preparation_commits (
    transcription_job_id uuid primary key references recording_jobs(id) on delete restrict,
    tenant_id uuid not null references tenants(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    render_input_handle uuid not null references recording_render_inputs(render_input_handle) on delete restrict,
    commit_digest bytea not null check (octet_length(commit_digest) = 32),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    duration_millis bigint not null check (duration_millis > 0),
    transcription_source_id uuid references recording_transcription_sources(recording_id) on delete restrict,
    committed_at timestamptz not null default now()
);

-- +goose StatementBegin
create function protect_recording_render_allocation_mutation() returns trigger
language plpgsql as $$
begin
    if old.id <> new.id
        or old.reservation_request_id <> new.reservation_request_id
        or old.allocation_version <> new.allocation_version
        or old.tenant_id <> new.tenant_id
        or old.episode_id <> new.episode_id
        or old.recording_id <> new.recording_id
        or old.render_job_id <> new.render_job_id
        or old.render_input_handle <> new.render_input_handle
        or old.object_handle <> new.object_handle
        or old.attempt_count <> new.attempt_count
        or old.fencing_generation <> new.fencing_generation
        or old.capture_epoch <> new.capture_epoch
        or old.envelope_digest <> new.envelope_digest
        or old.purpose <> new.purpose
        or old.object_key <> new.object_key
        or old.created_at <> new.created_at then
        raise exception 'recording render allocation authority is immutable';
    end if;
    if old.state = 'reserved' and new.state = 'allocated' then
        return new;
    end if;
    if old.state = 'allocated' and new.state = 'allocated'
        and old.expected_content_type = new.expected_content_type
        and old.expected_byte_size = new.expected_byte_size
        and old.expected_sha256 = new.expected_sha256
        and old.expected_duration_millis is not distinct from new.expected_duration_millis
        and old.object_version is null and new.object_version is null then
        return new;
    end if;
    if old.state = 'allocated' and new.state = 'committed'
        and old.expected_content_type = new.expected_content_type
        and old.expected_byte_size = new.expected_byte_size
        and old.expected_sha256 = new.expected_sha256
        and old.expected_duration_millis is not distinct from new.expected_duration_millis
        and old.upload_token_hash = new.upload_token_hash
        and old.upload_expires_at = new.upload_expires_at then
        return new;
    end if;
    raise exception 'recording render allocation state transition is invalid';
end;
$$;
-- +goose StatementEnd

create trigger recording_render_allocations_authority_immutable
before update on recording_render_object_allocations
for each row execute function protect_recording_render_allocation_mutation();

-- +goose StatementBegin
create function reject_recording_render_authority_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording render authority is append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_render_inputs_immutable
before update or delete on recording_render_inputs
for each row execute function reject_recording_render_authority_mutation();
create trigger recording_render_commits_immutable
before update or delete on recording_render_commits
for each row execute function reject_recording_render_authority_mutation();
create trigger recording_render_allocations_no_delete
before delete on recording_render_object_allocations
for each row execute function reject_recording_render_authority_mutation();
create trigger recording_render_inputs_no_truncate
before truncate on recording_render_inputs
for each statement execute function reject_recording_render_authority_mutation();
create trigger recording_render_commits_no_truncate
before truncate on recording_render_commits
for each statement execute function reject_recording_render_authority_mutation();
create trigger recording_render_allocations_no_truncate
before truncate on recording_render_object_allocations
for each statement execute function reject_recording_render_authority_mutation();



alter table recording_transcription_sources
    add column generation bigint not null default 1,
    add column commit_digest bytea,
    add column presentation_sha256 bytea,
    add column manifest_allocation_id uuid references recording_render_object_allocations(id) on delete restrict,
    add column manifest_object_version text,
    add column manifest_etag text,
    add column status text not null default 'ready',
    add column expires_at timestamptz,
    add column lease_transcript_id uuid references transcriptions(id) on delete restrict,
    add column lease_expires_at timestamptz,
    add column cleanup_due_at timestamptz,
    add column deleted_at timestamptz,
    add column updated_at timestamptz not null default now();

update recording_transcription_sources
set commit_digest = manifest_sha256,
    expires_at = committed_at + interval '24 hours'
where commit_digest is null or expires_at is null;

alter table recording_transcription_sources
    alter column commit_digest set not null,
    alter column expires_at set not null,
    add constraint recording_transcription_sources_generation_check check (generation > 0),
    add constraint recording_transcription_sources_commit_digest_check check (octet_length(commit_digest) = 32),
    add constraint recording_transcription_sources_presentation_sha256_check check (presentation_sha256 is null or octet_length(presentation_sha256) = 32),
    add constraint recording_transcription_sources_manifest_object_version_check check (manifest_object_version is null or length(manifest_object_version) between 1 and 256),
    add constraint recording_transcription_sources_manifest_etag_check check (manifest_etag is null or length(manifest_etag) between 1 and 256),
    add constraint recording_transcription_sources_status_check check (status in ('ready', 'leased', 'cleanup_pending', 'deleting', 'deleted')),
    add constraint recording_transcription_sources_expiry_check check (expires_at > committed_at and expires_at <= committed_at + interval '30 days'),
    add constraint recording_transcription_sources_lease_check check (
        (lease_transcript_id is null and lease_expires_at is null)
        or (
            lease_transcript_id is not null
            and lease_expires_at is not null
            and lease_expires_at <= expires_at + interval '2 hours'
        )
    ),
    add constraint recording_transcription_sources_status_lease_check check (
        (status = 'ready' and lease_transcript_id is null and lease_expires_at is null)
        or (status = 'leased' and lease_transcript_id is not null and lease_expires_at is not null)
        or (status in ('cleanup_pending', 'deleting', 'deleted') and lease_transcript_id is null and lease_expires_at is null)
    ),
    add constraint recording_transcription_sources_cleanup_check check (
        (status in ('ready', 'leased') and cleanup_due_at is null and deleted_at is null)
        or (status in ('cleanup_pending', 'deleting') and cleanup_due_at is not null and deleted_at is null)
        or (status = 'deleted' and cleanup_due_at is not null and deleted_at is not null)
    );

create unique index recording_transcription_sources_recording_generation_uidx
    on recording_transcription_sources(recording_id, generation);
create index recording_transcription_sources_expiry_idx
    on recording_transcription_sources(expires_at, recording_id)
    where status = 'ready';
create index recording_transcription_sources_lease_expiry_idx
    on recording_transcription_sources(lease_expires_at, recording_id)
    where status = 'leased';
create index recording_transcription_sources_cleanup_idx
    on recording_transcription_sources(cleanup_due_at, recording_id)
    where status in ('cleanup_pending', 'deleting');

alter table transcriptions add column source_expires_at timestamptz;

update transcriptions transcript
set source_expires_at = source.expires_at
from recording_transcription_sources source
where source.recording_id = transcript.recording_id
  and transcript.source_expires_at is null;

alter table recording_transcription_source_chunks
    add column track_id text,
    add column participant_generation bigint,
    add column display_name_snapshot text,
    add column overlap boolean not null default false,
    add column source_start_ms bigint,
    add column source_end_ms bigint,
    add column allocation_id uuid references recording_render_object_allocations(id) on delete restrict,
    add column object_version text,
    add column object_etag text;

update recording_transcription_source_chunks
set source_start_ms = 0,
    source_end_ms = end_ms - start_ms
where source_start_ms is null or source_end_ms is null;

alter table recording_transcription_source_chunks
    alter column source_start_ms set not null,
    alter column source_end_ms set not null,
    add constraint recording_transcription_source_chunks_track_id_check check (track_id is null or length(track_id) between 1 and 256),
    add constraint recording_transcription_source_chunks_participant_generation_check check (participant_generation is null or participant_generation > 0),
    add constraint recording_transcription_source_chunks_display_name_check check (display_name_snapshot is null or length(display_name_snapshot) between 1 and 256),
    add constraint recording_transcription_source_chunks_display_name_authority_check check (
        display_name_snapshot is null or (identity_kind = 'participant' and track_class = 'microphone')
    ),
    add constraint recording_transcription_source_chunks_source_time_check check (
        source_start_ms >= 0
        and source_end_ms > source_start_ms
        and source_end_ms - source_start_ms = end_ms - start_ms
    ),
    add constraint recording_transcription_source_chunks_object_version_check check (object_version is null or length(object_version) between 1 and 256),
    add constraint recording_transcription_source_chunks_object_etag_check check (object_etag is null or length(object_etag) between 1 and 256);

alter table transcription_cleanup_jobs
    add column recording_id uuid references recordings(id) on delete restrict;

update transcription_cleanup_jobs cleanup
set recording_id = transcriptions.recording_id
from transcriptions
where transcriptions.id = cleanup.transcript_id
  and cleanup.recording_id is null;

alter table transcription_cleanup_jobs
    alter column recording_id set not null,
    alter column transcript_id drop not null,
    drop constraint transcription_cleanup_jobs_transcript_id_object_key_key,
    drop constraint transcription_cleanup_jobs_kind_check,
    add constraint transcription_cleanup_jobs_kind_check check (
        object_kind in ('final_artifact', 'temp_result', 'source_manifest', 'source_chunk', 'recording_source')
    ),
    add constraint transcription_cleanup_jobs_owner_check check (
        (object_kind in ('final_artifact', 'temp_result') and transcript_id is not null)
        or (object_kind in ('source_manifest', 'source_chunk', 'recording_source'))
    );

create unique index transcription_cleanup_jobs_recording_object_uidx
    on transcription_cleanup_jobs(recording_id, object_key);



alter table recording_pool_health
    add column demand_revision text not null default 'legacy'
    check (octet_length(demand_revision) between 1 and 128);

create table recording_fleet_nodes (
    environment text not null check (environment ~ '^[a-z][a-z0-9-]{0,31}$'),
    role text not null check (role in ('capture', 'render')),
    provider_id text not null check (octet_length(provider_id) between 1 and 128),
    node_name text not null check (octet_length(node_name) between 1 and 255),
    region text not null check (region ~ '^[a-z][a-z0-9-]{0,31}$'),
    release_id text not null check (octet_length(release_id) between 1 and 128),
    image_digest text not null check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
    boot_generation bigint not null check (boot_generation > 0),
    inventory_digest text not null check (inventory_digest ~ '^[0-9a-f]{64}$'),
    worker_id uuid,
    state text not null check (state in ('requested', 'active', 'draining', 'revoked')),
    ready boolean not null default false,
    admission_open boolean not null default false,
    ready_capacity integer not null default 0 check (ready_capacity >= 0),
    observed_at timestamptz,
    resources_latest jsonb,
    peak_rss_bytes bigint not null default 0 check (peak_rss_bytes >= 0),
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (environment, role, provider_id),
    unique (worker_id),
    constraint recording_fleet_nodes_environment_provider_key unique (environment, provider_id),
    constraint recording_fleet_nodes_worker_state_check check (
        state = 'revoked'
        or (state = 'requested') = (worker_id is null)
    ),
    check (not admission_open or (state = 'active' and ready and ready_capacity > 0)),
    check ((state = 'revoked') = (revoked_at is not null)),
    check (state <> 'revoked' or (not ready and not admission_open and ready_capacity = 0))
);

create index recording_fleet_nodes_role_state_idx
    on recording_fleet_nodes(environment, role, state, provider_id);

create table recording_colocated_capture_workers (
    environment text not null check (octet_length(environment) between 1 and 100),
    sfu_node text not null check (octet_length(sfu_node) between 1 and 100),
    worker_id uuid not null unique,
    state text not null default 'active' check (state in ('active', 'revoked')),
    ready boolean not null default false,
    admission_open boolean not null default false,
    ready_capacity integer not null default 0 check (ready_capacity >= 0),
    resources_latest jsonb,
    peak_rss_bytes bigint not null default 0 check (peak_rss_bytes >= 0),
    observed_at timestamptz,
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (environment, sfu_node),
    check (not admission_open or (state = 'active' and ready and ready_capacity > 0)),
    check ((state = 'revoked') = (revoked_at is not null)),
    check (state <> 'revoked' or (not ready and not admission_open and ready_capacity = 0))
);

create table recording_preparations (
    tenant_id uuid not null,
    space_id uuid not null,
    starts_at timestamptz not null,
    state text not null check (state in ('scheduled', 'consumed', 'canceled', 'expired')),
    revision bigint not null check (revision > 0),
    request_revision bigint not null check (request_revision >= 0),
    request_kind text not null check (request_kind in ('prepare', 'cancel')),
    consumed_recording_id uuid references recordings(id),
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id),
    foreign key (tenant_id, space_id) references spaces(tenant_id, id) on delete cascade,
    check ((state = 'consumed') = (consumed_recording_id is not null))
);

create index recording_preparations_due_idx on recording_preparations(starts_at, tenant_id, space_id)
    where state = 'scheduled';

create function recording_enqueue_terminal_capture_source_cleanup(source_recording_id uuid, stopped_at timestamptz)
returns void
language sql
as $$
    insert into transcription_cleanup_jobs (
        id, tenant_id, recording_id, transcript_id, object_key, object_kind, due_at
    )
    select gen_random_uuid(), objects.tenant_id, source_recording_id, null,
        objects.object_key, 'recording_source', stopped_at +
            (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second')
    from (
        select allocations.tenant_id, allocations.object_key
        from recording_bundle_allocations allocations
        where allocations.recording_id = source_recording_id
          and allocations.state in ('allocated', 'committed')
        union
        select presentations.tenant_id, presentations.presentation_object_key
        from recording_presentations presentations
        where presentations.recording_id = source_recording_id
        union
        select presentations.tenant_id, presentations.asset_manifest_object_key
        from recording_presentations presentations
        where presentations.recording_id = source_recording_id
        union
        select assets.tenant_id, assets.object_key
        from recording_presentations presentations
        join recording_presentation_assets assets
          on assets.presentation_handle = presentations.presentation_handle
        where presentations.recording_id = source_recording_id
    ) objects
    join recordings on recordings.id = source_recording_id
    join episodes on episodes.id = recordings.episode_id
    on conflict (recording_id, object_key) do nothing;
$$;

create function recording_terminal_capture_source_cleanup_trigger()
returns trigger
language plpgsql
as $$
begin
    perform recording_enqueue_terminal_capture_source_cleanup(new.recording_id, coalesce(new.terminal_at, new.updated_at));
    return new;
end;
$$;

create trigger recording_terminal_capture_source_cleanup
after update of state on recording_jobs
for each row
when (new.kind = 'capture' and new.state = 'terminal_failure' and old.state is distinct from new.state)
execute function recording_terminal_capture_source_cleanup_trigger();

create function recording_backfill_terminal_capture_source_cleanup()
returns void
language plpgsql
as $$
declare
    terminal_capture record;
begin
    for terminal_capture in
        select jobs.recording_id, coalesce(jobs.terminal_at, jobs.updated_at) as terminal_at
        from recording_jobs jobs
        where jobs.kind = 'capture'
          and jobs.state = 'terminal_failure'
          and exists (
              select 1 from recording_bundle_allocations allocations
              where allocations.recording_id = jobs.recording_id
                and allocations.state in ('allocated', 'committed')
          )
    loop
        perform recording_enqueue_terminal_capture_source_cleanup(
            terminal_capture.recording_id, terminal_capture.terminal_at
        );
    end loop;
end;
$$;

create table recording_completion_recoveries (
    job_id uuid primary key references recording_jobs(id) on delete restrict,
    request_id uuid not null unique,
    database_user text not null default current_user,
    operator text not null check (octet_length(operator) between 1 and 256),
    reason text not null check (octet_length(reason) between 1 and 1024),
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    error_code text,
    error_detail text,
    failed_at timestamptz not null,
    source_expires_at timestamptz not null,
    requested_at timestamptz not null default now()
);

create function reject_recording_completion_recovery_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording completion recoveries are append-only';
end;
$$;

create trigger recording_completion_recoveries_immutable
before update or delete on recording_completion_recoveries
for each row execute function reject_recording_completion_recovery_mutation();
create trigger recording_completion_recoveries_no_truncate
before truncate on recording_completion_recoveries
for each statement execute function reject_recording_completion_recovery_mutation();

-- Participant attendance survives Episode journal retention.
alter table participants
    add column first_joined_at timestamptz,
    add column last_left_reason text check (last_left_reason in ('left', 'episode_ended'));
create index participants_episode_recent_join_idx
    on participants(tenant_id, space_id, episode_id, (coalesce(first_joined_at, joined_at)) desc, id)
    where coalesce(first_joined_at, joined_at) is not null;

ALTER TABLE tenants
    ADD COLUMN created_by_service_id text,
    ADD COLUMN external_id text,
    ADD CONSTRAINT tenants_service_id_check CHECK (
        created_by_service_id IS NULL OR (length(created_by_service_id) BETWEEN 1 AND 128 AND btrim(created_by_service_id) = created_by_service_id)
    ),
    ADD CONSTRAINT tenants_external_id_check CHECK (
        external_id IS NULL OR (created_by_service_id IS NOT NULL AND length(external_id) BETWEEN 1 AND 512 AND btrim(external_id) = external_id)
    ),
    ADD CONSTRAINT tenants_service_external_id_key UNIQUE (created_by_service_id, external_id);

CREATE INDEX tenants_service_created_at_id_idx ON tenants(created_by_service_id, created_at DESC, id DESC);

alter table sync_chat_messages add column reaction_revision bigint not null default 0;

create table sync_chat_message_reactions (
    tenant_id uuid not null,
    space_id uuid not null,
    message_id uuid not null,
    participant_id uuid not null,
    emoji text not null,
    primary key (tenant_id, space_id, message_id, participant_id, emoji),
    foreign key (tenant_id, space_id, message_id)
        references sync_chat_messages(tenant_id, space_id, message_id) on delete cascade,
    check (emoji in ('👍', '❤️', '😂', '😮', '🎉', '👏', '😀', '😅', '🙏', '🔥', '✅', '👀', '💯', '🤔', '😢', '🙌', '🚀', '👌', '😍', '🤝', '💡', '⭐', '😎', '🥳'))
);

create function sync_admission_expiry_due(request_expires_at timestamptz, arrival_state text, as_of timestamptz)
returns boolean
language sql immutable parallel safe
as $$
    select request_expires_at <= as_of
        or coalesce(arrival_state in ('unavailable', 'rejected', 'left'), false);
$$;

create function guard_canonical_public_admission_decision()
returns trigger
language plpgsql
as $$
declare
    canonical_state text;
begin
    select case when status = 'admitted' then 'approved' else status end
      into canonical_state
      from sync_admission_requests
      where tenant_id = new.tenant_id and space_id = new.space_id
        and admission_request_id = new.request_handle;
    if found and new.state <> canonical_state then
        raise exception 'canonical admission decisions are owned by Sync'
            using errcode = '23514';
    end if;
    return new;
end;
$$;

create trigger space_public_admission_requests_canonical_decision
before update of state on space_public_admission_requests
for each row when (old.state is distinct from new.state)
execute function guard_canonical_public_admission_decision();

CREATE FUNCTION recording_capture_stop_confirmed(target_recording_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM recording_pipelines pipeline
        JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
        JOIN sync_recordings recording ON recording.recording_id = pipeline.recording_id AND recording.tenant_id = pipeline.tenant_id
        JOIN sync_external_operations operation ON operation.tenant_id = job.tenant_id
            AND operation.episode_id = job.episode_id AND operation.recording_id = job.recording_id
        WHERE pipeline.recording_id = target_recording_id AND recording.status = 'stopped'
          AND operation.payload ->> 'stopOperationId' = recording.stop_external_operation_id::text
          AND operation.payload -> 'captureEpoch' = to_jsonb(pipeline.capture_epoch)
          AND operation.operation_name = 'recording_capture_stopped' AND operation.status = 'applied'
    );
$$;

CREATE FUNCTION recording_capture_salvage_deadline(target_recording_id uuid)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
    SELECT pipeline.stop_requested_at + recording_deferred_retention_seconds(episode.config_snapshot) * interval '1 second'
    FROM recording_pipelines pipeline
    JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
    JOIN episodes episode ON episode.id = job.episode_id
    WHERE pipeline.recording_id = target_recording_id
      AND NOT recording_capture_stop_confirmed(target_recording_id);
$$;

-- A colocated worker counts as able to take a capture only while it reports ready and open and
-- its last report is recent. Readiness is reported every 10 seconds.
CREATE FUNCTION recording_colocated_worker_healthy(target_node text)
returns boolean language sql stable as $$
    select exists (
        select 1 from recording_colocated_capture_workers worker
        where worker.sfu_node = target_node and worker.state = 'active'
          and worker.ready and worker.admission_open and worker.ready_capacity > 0
          and worker.observed_at > clock_timestamp() - interval '35 seconds'
          and worker.observed_at <= clock_timestamp()
    );
$$;

-- True when an earlier attempt of the capture job ran on a colocated worker. That attempt ended in
-- a failure or a lapsed lease, so the next one goes to the fleet instead of back to the same worker.
-- The placement of every attempt is already recorded in recording_job_attempt_authorities.
CREATE FUNCTION recording_capture_colocated_attempted(target_job_id uuid)
returns boolean language sql stable as $$
    select exists (
        select 1 from recording_job_attempt_authorities authority
        join recording_colocated_capture_workers worker on worker.worker_id::text = authority.lease_owner
        where authority.job_id = target_job_id and authority.kind = 'capture'
    );
$$;

-- True while the Recording's capture is the colocated worker's: leased by one, or waiting no
-- longer than the grace for the healthy one beside the Episode's own-SFU node, for an attempt no
-- colocated worker has failed yet. After the grace, when that worker is not healthy, or once it
-- has failed an attempt, the fleet may claim the job and its demand counts again.
CREATE FUNCTION recording_capture_colocated(target_recording_id uuid, grace_seconds integer)
returns boolean language sql stable as $$
    select grace_seconds > 0 and exists (
        select 1 from recording_jobs job
        join episodes on episodes.id = job.episode_id
        where job.recording_id = target_recording_id and job.kind = 'capture'
          and (
              (job.state = 'leased' and exists (
                  select 1 from recording_colocated_capture_workers worker where worker.worker_id::text = job.lease_owner))
              or (job.state in ('pending', 'retryable_failure')
                  and job.available_at + grace_seconds * interval '1 second' > clock_timestamp()
                  and episodes.config_snapshot->'media_plane_binding'->>'provider' = 'chalk_sfu'
                  and not recording_capture_colocated_attempted(job.id)
                  and recording_colocated_worker_healthy(episodes.config_snapshot->'media_plane_binding'->>'node'))
          )
    );
$$;

CREATE FUNCTION recording_capture_completion_available(target_recording_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM recording_pipelines pipeline
        JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
        JOIN sync_recordings recording ON recording.recording_id = pipeline.recording_id
            AND recording.tenant_id = pipeline.tenant_id
        WHERE pipeline.recording_id = target_recording_id
          AND pipeline.stop_requested_at IS NOT NULL
          AND pipeline.capture_ready_at IS NOT NULL
          AND (
              recording_capture_stop_confirmed(target_recording_id) OR (
                  recording_capture_salvage_deadline(target_recording_id) > clock_timestamp()
                  AND EXISTS (SELECT 1 FROM recording_bundles bundle WHERE bundle.recording_id = pipeline.recording_id)
                  AND EXISTS (SELECT 1 FROM recording_data_keys key WHERE key.recording_id = pipeline.recording_id
                              AND key.capture_epoch = pipeline.capture_epoch)
              )
          )
    );
$$;

-- Absence of a seat row means the legacy protocol. No historical rows change.
-- Rollout: migrate, upgrade every Sync consumer, then API and client SDKs.
-- Previous API/Sync binaries remain runnable; runtime rollback keeps this schema.
-- Absence of a seat row means the legacy protocol. No historical rows change.
-- The Wave 1 baseline recreated this FK without its July constraint name.
-- Resolve its columns and target without renaming a deployed constraint.
-- +goose StatementBegin
do $$
declare
    generation_constraint name;
begin
    select constraint_row.conname into strict generation_constraint
    from pg_constraint constraint_row
    where constraint_row.contype = 'f'
      and constraint_row.conrelid = 'sync_lifecycle_intents'::regclass
      and constraint_row.confrelid = 'participants'::regclass
      and (
          select array_agg(attribute.attname::text order by key.ordinality)
          from unnest(constraint_row.conkey) with ordinality as key(attnum, ordinality)
          join pg_attribute attribute
            on attribute.attrelid = constraint_row.conrelid and attribute.attnum = key.attnum
      ) = array['tenant_id', 'space_id', 'episode_id', 'participant_id', 'participant_generation'];

    execute format(
        'alter table sync_lifecycle_intents alter constraint %I deferrable initially deferred',
        generation_constraint
    );
end;
$$;
-- +goose StatementEnd

create table participant_join_seats (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid primary key,
    generation bigint not null check (generation > 0),
    state text not null check (state in ('pending', 'joined', 'left', 'cancelled', 'expired')),
    expires_at timestamptz not null,
    updated_at timestamptz not null default now(),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);

-- The existing lifecycle queue delivers pending-seat expiry at next_attempt_at.
-- One authority owns the state machine for API cancellation/retry and Sync hello:
-- pending -> joined (completed entry), cancelled (HTTP), expired (lease).
-- cancelled/expired -> pending (retry); joined -> left (normal departure trigger).
-- +goose StatementBegin
create function transition_participant_join_seat(
    seat_tenant uuid, seat_space uuid, seat_episode uuid, seat_participant uuid,
    seat_generation bigint, action text, expected_connection text default null
) returns text language plpgsql as $$
declare
    seat participant_join_seats%rowtype;
    intent sync_lifecycle_intents%rowtype;
    terminal_state text;
begin
    if action not in ('confirm', 'cancel', 'expire', 'retry') then
        raise exception 'invalid participant join transition';
    end if;
    perform 1 from sync_episode_control
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
    for update;
    perform 1 from episodes
    where tenant_id = seat_tenant and space_id = seat_space and id = seat_episode
    for update;
    perform 1 from participants
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
      and id = seat_participant for update;
    select * into seat from participant_join_seats
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
      and participant_id = seat_participant for update;
    if not found then return 'legacy'; end if;
    if seat.generation != seat_generation then return 'stale'; end if;
    if action='retry' and not exists (select 1 from episodes
        where tenant_id=seat_tenant and space_id=seat_space and id=seat_episode and status='active') then
        return 'episode_ended';
    end if;

    if action='retry' and seat.state='pending' and seat.expires_at > now()
       and exists (select 1 from participants where id=seat_participant
         and status='joining' and first_joined_at is null) then
        -- Each explicit attempt owns a new generation, even if cleanup was lost.
        update participants set generation=generation+1, media_connection_id=null,
            media_connection_generation=null, updated_at=now() where id=seat_participant;
        update participant_join_seats set generation=generation+1,
            expires_at=now()+interval '2 minutes', updated_at=now() where participant_id=seat_participant;
        update sync_lifecycle_intents set participant_generation=seat_generation+1,
            next_attempt_at=now()+interval '2 minutes'
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='pending';
        return 'pending';
    end if;

    if seat.state = 'pending' then
        if action = 'cancel' then
            -- A late failure from an older attempt cannot cancel a newer grant.
            if not exists (select 1 from participants where id = seat_participant
                and media_connection_id = expected_connection) then return 'stale'; end if;
            terminal_state := 'cancelled';
        elsif seat.expires_at <= now() then
            terminal_state := 'expired';
        elsif action = 'confirm' then
            update participant_join_seats set state='joined', updated_at=now()
            where participant_id=seat_participant;
            return 'joined';
        else
            return 'pending';
        end if;

        -- Previous Sync binaries may already have applied the legacy join.
        if not exists (select 1 from participants where id = seat_participant
            and generation = seat_generation and status = 'joining') then return 'joined'; end if;
        update sync_lifecycle_intents
        set status='superseded', terminal_reason='participant_already_terminal', completed_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='pending'
        returning * into intent;
        if not found then return seat.state; end if;
        if intent.journey_id is not null then
            insert into observability_journey_events (
                event_id, journey_id, sequence, occurred_at, name, phase, state,
                origin_kind, first_observed_layer, upstream_visibility, parent_event_id,
                trace_id, span_id, attributes
            ) values (
                gen_random_uuid(), intent.journey_id, 1, now(), 'participant.join_' || terminal_state,
                'terminal', 'cancelled', 'server', case when terminal_state='expired' then 'sync' else 'api' end,
                'visible', intent.parent_journey_event_id, intent.producing_trace_id, intent.producing_span_id,
                jsonb_build_object('participant_id', seat_participant, 'reason', terminal_state)
            );
        end if;
        update participant_join_seats set state=terminal_state, updated_at=now()
        where participant_id=seat_participant;
        update participants set status='left', left_at=now(), updated_at=now() where id=seat_participant;
        update sync_episode_control set
            snapshot_reserved_bytes=snapshot_reserved_bytes-2048,
            lifecycle_reserved_events=lifecycle_reserved_events-2,
            lifecycle_reserved_bytes=lifecycle_reserved_bytes-32768,
            lifecycle_reserved_intents=lifecycle_reserved_intents-1,
            lifecycle_reserved_intent_bytes=lifecycle_reserved_intent_bytes-16384,
            updated_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode;
        seat.state := terminal_state;
    end if;

    if action='retry' and seat.state in ('cancelled','expired') then
        update sync_episode_control set
            snapshot_reserved_bytes=snapshot_reserved_bytes+2048,
            lifecycle_reserved_events=lifecycle_reserved_events+2,
            lifecycle_reserved_bytes=lifecycle_reserved_bytes+32768,
            lifecycle_reserved_intents=lifecycle_reserved_intents+1,
            lifecycle_reserved_intent_bytes=lifecycle_reserved_intent_bytes+16384,
            updated_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and snapshot_bytes+snapshot_reserved_bytes+2048 <= 1048576
          and lifecycle_event_count+lifecycle_reserved_events+2 <= 2048
          and lifecycle_event_bytes+lifecycle_reserved_bytes+32768 <= 33554432
          and lifecycle_intent_count+lifecycle_reserved_intents+1 <= 2048
          and lifecycle_intent_bytes+lifecycle_reserved_intent_bytes+16384 <= 33554432
          and (select count(*) from participants where tenant_id=seat_tenant and space_id=seat_space
            and episode_id=seat_episode and status in ('joining','active','leaving')) < 500;
        if not found then return 'capacity_exceeded'; end if;
        update participants set status='joining', generation=generation+1, left_at=null, media_connection_id=null,
            media_connection_generation=null, updated_at=now() where id=seat_participant;
        update participant_join_seats set state='pending', generation=generation+1, expires_at=now()+interval '2 minutes', updated_at=now()
        where participant_id=seat_participant;
        update sync_lifecycle_intents set status='pending', participant_generation=seat_generation+1, terminal_reason=null, completed_at=null,
            attempt_count=0, last_error_code=null, next_attempt_at=now()+interval '2 minutes'
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='superseded'
          and terminal_reason='participant_already_terminal';
        return 'pending';
    end if;
    return seat.state;
end;
$$;
-- +goose StatementEnd

-- Normal leave and Episode end also close the seat, including older binaries.
-- +goose StatementBegin
create function complete_participant_join_seat() returns trigger language plpgsql as $$
begin
    if new.status='left' then
        update participant_join_seats
        set state=case when state='joined' or new.first_joined_at is not null then 'left' else 'cancelled' end, updated_at=now()
        where participant_id=new.id and generation=new.generation and state in ('pending','joined');
    end if;
    return new;
end;
$$;
create trigger participant_join_seat_departure after update of status on participants
    for each row execute function complete_participant_join_seat();
-- +goose StatementEnd

alter table participant_join_seats add column entry_token_id text
    check (octet_length(entry_token_id) between 1 and 128);

alter table participant_join_seats
    add column issued_entry_generation bigint not null default 0
        check (issued_entry_generation between 0 and 9007199254740991),
    add column confirmed_entry_generation bigint not null default 0
        check (confirmed_entry_generation between 0 and issued_entry_generation),
    add column issued_entry_expires_at timestamptz not null default now() + interval '120 seconds';

create table sync_entry_rollout (
    singleton boolean primary key default true check (singleton),
    enforced boolean not null default false,
    enforced_at timestamptz,
    release_id text,
    check (enforced = (enforced_at is not null and release_id is not null))
);
insert into sync_entry_rollout(singleton) values (true);

-- Every writer takes this row lock before entry/Leave mutations. Enforcement
-- waits for earlier transactions; subsequent old transactions fail closed.
-- +goose StatementBegin
create function require_sync_entry_writer() returns trigger language plpgsql as $$
declare enabled boolean;
begin
    select enforced into strict enabled from sync_entry_rollout where singleton for share;
    if enabled and current_setting('chalk.entry_writer', true) is distinct from '1' then
        -- A still-current compatibility socket may request Leave. Only the new
        -- consumer can claim/finalize it; old provider dispatch remains fenced.
        if tg_table_name='sync_external_operations' and tg_op='INSERT' then
            if not exists (select 1 from participant_join_seats
                           where participant_id=new.target_participant_id
                             and generation=new.target_participant_generation
                             and confirmed_entry_generation > 0) then
                return new;
            end if;
        end if;
        raise exception 'Sync entry writer upgrade required' using errcode='55000';
    end if;
    return new;
end;
$$;
-- +goose StatementEnd
create trigger sync_entry_participant_writer before update of status on participants
    for each row when (new.status is distinct from old.status and
      (new.status='active' or (new.status='left' and old.first_joined_at is not null)))
    execute function require_sync_entry_writer();
create trigger sync_entry_leave_writer before insert or update on sync_external_operations
    for each row when (new.operation_name='participant_leave') execute function require_sync_entry_writer();
create trigger sync_entry_event_writer before insert on sync_control_events
    for each row execute function require_sync_entry_writer();

-- +goose StatementBegin
create function enforce_sync_entry_ownership(target_release text) returns void language plpgsql as $$
begin
    perform 1 from sync_entry_rollout where singleton for update;
    if (select enforced from sync_entry_rollout where singleton) then return; end if;
    if target_release is null or length(target_release)=0 then
        raise exception 'entry enforcement requires a release identity';
    end if;
    -- A provider call outlives its claiming transaction. Drain it while all
    -- sockets still use compatibility semantics, before issuing owned entries.
    if exists (select 1 from sync_external_operations where operation_name='participant_leave'
               and status='pending' and attempt_count > 0) then
        raise exception 'entry enforcement requires claimed Leaves to finish' using errcode='55000';
    end if;
    update sync_entry_rollout set enforced=true,enforced_at=clock_timestamp(),release_id=target_release
      where singleton;
end;
$$;
-- +goose StatementEnd

create table automatic_transcript_tenant_policy_backup (
    tenant_id uuid primary key,
    transcription_ceiling text not null,
    transcription_default_mode text not null,
    provider_policy_version text not null,
    source_window_seconds bigint not null,
    updated_at timestamptz not null
);

create table automatic_transcript_space_policy_backup (
    space_id uuid primary key,
    tenant_id uuid not null,
    transcription_policy text not null,
    updated_at timestamptz not null
);

create table episode_presence_leases (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    expires_at timestamptz not null,
    primary key (tenant_id, space_id, episode_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id) on delete cascade
);

create table sync_presence_runtime (
    singleton boolean primary key default true check (singleton),
    recover_after timestamptz not null
);
insert into sync_presence_runtime(singleton, recover_after)
values (true, clock_timestamp() + interval '120 seconds');

create table participant_presence_leases (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    generation bigint not null,
    expires_at timestamptz not null,
    primary key (tenant_id, space_id, episode_id, participant_id),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);
create index participant_presence_leases_expiry_idx on participant_presence_leases(expires_at);

-- Publication runs after completion has locked the capture job. A volatile
-- function gets a fresh snapshot, including a worker callback that committed
-- while completion waited for that lock.
create table recording_capture_publication_failures (
    job_id uuid not null,
    attempt_count integer not null,
    fencing_generation bigint not null,
    primary key (job_id, attempt_count, fencing_generation),
    foreign key (job_id, attempt_count, fencing_generation)
        references recording_job_attempt_authorities(job_id, attempt_count, fencing_generation)
);

create function recording_capture_completion_attempts(target_job_id uuid)
returns integer language sql stable as $$
    select count(*)::integer from recording_job_attempt_authorities authority
    where authority.job_id = target_job_id
      and (convert_from(authority.envelope_bytes, 'UTF8')::jsonb ->> 'completion_only')::boolean is true
      and not exists (
          select 1 from recording_capture_publication_failures failure
          where failure.job_id = authority.job_id and failure.attempt_count = authority.attempt_count
            and failure.fencing_generation = authority.fencing_generation
      );
$$;

create function recording_publish_completed_capture_stop(source_recording_id uuid, trace_id text, span_id text)
returns boolean
language plpgsql
volatile
as $$
begin
    insert into sync_external_operations (
        tenant_id, space_id, episode_id, external_operation_id, request_key,
        request_fingerprint, operation_name, recording_id, payload, fence_active,
        journey_id, parent_journey_event_id, producing_trace_id, producing_span_id
    )
    select recording.tenant_id, recording.space_id, recording.episode_id, gen_random_uuid(),
        'capture_complete_recovery_' || recording.recording_id::text || '_' || pipelines.capture_epoch::text,
        sha256(convert_to(payload.value::text, 'UTF8')), 'recording_capture_stopped', recording.recording_id,
        payload.value, false, source.journey_id, source.parent_journey_event_id, trace_id, span_id
    from recording_pipelines pipelines
    join sync_recordings recording on recording.tenant_id = pipelines.tenant_id
        and recording.recording_id = pipelines.recording_id
    join sync_external_operations source on source.tenant_id = recording.tenant_id
        and source.space_id = recording.space_id and source.episode_id = recording.episode_id
        and source.recording_id = recording.recording_id
        and source.external_operation_id = pipelines.stop_operation_id
        and source.operation_name = 'stop_recording' and source.status = 'applied'
    cross join lateral (
        select jsonb_build_object('recordingId', recording.recording_id::text,
            'stopOperationId', pipelines.stop_operation_id::text,
            'captureEpoch', pipelines.capture_epoch) as value
    ) payload
    where pipelines.recording_id = source_recording_id
      and pipelines.capture_completed_at is not null
      and recording.status = 'stopping'
      and recording.stop_external_operation_id = pipelines.stop_operation_id
      and not exists (
          select 1 from sync_external_operations operation
          where operation.tenant_id = recording.tenant_id
            and operation.episode_id = recording.episode_id
            and operation.operation_name = 'recording_capture_stopped'
            and operation.recording_id = recording.recording_id
            and operation.status in ('pending', 'applied')
            and operation.payload ->> 'stopOperationId' = pipelines.stop_operation_id::text
            and operation.payload ->> 'captureEpoch' = pipelines.capture_epoch::text
      )
    -- Maintenance uses this same key, including when it races publication.
    on conflict (tenant_id, episode_id, operation_name, request_key) do nothing;
    return true;
exception when query_canceled or others then
    -- Keep the failure stage across the API boundary without exposing SQL details.
    raise exception using errcode = 'PC001', message = 'capture stopped publication failed';
end;
$$;

create table recording_capture_stop_publications (
    recording_id uuid primary key references recording_pipelines(recording_id) on delete cascade,
    stop_operation_id uuid not null,
    capture_epoch bigint not null check (capture_epoch > 0),
    producing_trace_id text,
    producing_span_id text,
    created_at timestamptz not null default clock_timestamp(),
    next_attempt_at timestamptz not null default clock_timestamp(),
    attempt_count bigint not null default 0 check (attempt_count >= 0),
    last_error_code text,
    resolved_at timestamptz
);

create index recording_capture_stop_publications_due
    on recording_capture_stop_publications(next_attempt_at, recording_id) where resolved_at is null;

create function recording_try_publish_capture_stop(target_recording_id uuid, observed_at timestamptz)
returns void language plpgsql volatile as $$
declare
    obligation recording_capture_stop_publications%rowtype;
begin
    select * into obligation from recording_capture_stop_publications
    where recording_id = target_recording_id and resolved_at is null for update;
    if not found then return; end if;

    -- Completed media, not a live recorder lease, authorizes this retry. A
    -- replaced stop/epoch or an already queued callback retires the obligation.
    if not exists (
        select 1 from recording_pipelines pipeline
        join sync_recordings recording on recording.tenant_id = pipeline.tenant_id
            and recording.recording_id = pipeline.recording_id
        join sync_external_operations source on source.tenant_id = recording.tenant_id
            and source.space_id = recording.space_id and source.episode_id = recording.episode_id
            and source.recording_id = recording.recording_id
            and source.external_operation_id = obligation.stop_operation_id
            and source.operation_name = 'stop_recording' and source.status in ('pending', 'applied')
        where pipeline.recording_id = obligation.recording_id and pipeline.capture_completed_at is not null
            and pipeline.stop_operation_id = obligation.stop_operation_id and pipeline.capture_epoch = obligation.capture_epoch
            and recording.status = 'stopping' and recording.stop_external_operation_id = obligation.stop_operation_id
            and not exists (
                select 1 from sync_external_operations operation
                where operation.tenant_id = recording.tenant_id and operation.episode_id = recording.episode_id
                    and operation.operation_name = 'recording_capture_stopped' and operation.recording_id = recording.recording_id
                    and operation.status in ('pending', 'applied')
                    and operation.payload ->> 'stopOperationId' = obligation.stop_operation_id::text
                    and operation.payload ->> 'captureEpoch' = obligation.capture_epoch::text
            )
    ) then
        update recording_capture_stop_publications set resolved_at = observed_at, last_error_code = null
        where recording_id = target_recording_id;
        return;
    end if;

    -- Sync records the intent before dispatching the stop to the API. Media
    -- can finish before Sync commits that source operation's applied result.
    if exists (
        select 1 from sync_external_operations source
        join recording_pipelines pipeline on pipeline.tenant_id = source.tenant_id
            and pipeline.recording_id = source.recording_id
        where pipeline.recording_id = target_recording_id
            and source.external_operation_id = obligation.stop_operation_id and source.status = 'pending'
    ) then
        update recording_capture_stop_publications
        set attempt_count = least(attempt_count, 9223372036854775806) + 1, last_error_code = 'source_pending',
            next_attempt_at = observed_at + least(300, 5 * power(2, least(attempt_count, 6))::integer) * interval '1 second'
        where recording_id = target_recording_id;
        return;
    end if;

    -- Retry counters saturate at bigint max; publication has no attempt budget.
    -- Only the outbox insert is a subtransaction. Its failure cannot undo the
    -- completed capture, released reservation, or durable retry obligation.
    begin
        insert into sync_external_operations (
            tenant_id, space_id, episode_id, external_operation_id, request_key,
            request_fingerprint, operation_name, recording_id, payload, fence_active,
            journey_id, parent_journey_event_id, producing_trace_id, producing_span_id
        )
        select recording.tenant_id, recording.space_id, recording.episode_id, gen_random_uuid(),
            'capture_complete_recovery_' || recording.recording_id::text || '_' || obligation.capture_epoch::text,
            sha256(convert_to(payload.value::text, 'UTF8')), 'recording_capture_stopped', recording.recording_id,
            payload.value, false, source.journey_id, source.parent_journey_event_id,
            obligation.producing_trace_id, obligation.producing_span_id
        from sync_recordings recording
        join sync_external_operations source on source.tenant_id = recording.tenant_id
            and source.space_id = recording.space_id and source.episode_id = recording.episode_id
            and source.recording_id = recording.recording_id and source.external_operation_id = obligation.stop_operation_id
            and source.operation_name = 'stop_recording' and source.status = 'applied'
        cross join lateral (
            select jsonb_build_object('recordingId', recording.recording_id::text,
                'stopOperationId', obligation.stop_operation_id::text, 'captureEpoch', obligation.capture_epoch) as value
        ) payload
        where recording.recording_id = obligation.recording_id and recording.status = 'stopping'
            and recording.stop_external_operation_id = obligation.stop_operation_id
        on conflict (tenant_id, episode_id, operation_name, request_key) do nothing;
    exception when query_canceled or others then
        update recording_capture_stop_publications
        set attempt_count = least(attempt_count, 9223372036854775806) + 1, last_error_code = SQLSTATE,
            next_attempt_at = observed_at + least(300, 5 * power(2, least(attempt_count, 6))::integer) * interval '1 second'
        where recording_id = target_recording_id;
        return;
    end;
    update recording_capture_stop_publications
    set attempt_count = least(attempt_count, 9223372036854775806) + 1, resolved_at = observed_at, last_error_code = null
    where recording_id = target_recording_id;
end;
$$;

create or replace function recording_publish_completed_capture_stop(source_recording_id uuid, trace_id text, span_id text)
returns boolean language plpgsql volatile as $$
begin
    insert into recording_capture_stop_publications(recording_id, stop_operation_id, capture_epoch, producing_trace_id, producing_span_id)
    select pipeline.recording_id, pipeline.stop_operation_id, pipeline.capture_epoch, trace_id, span_id
    from recording_pipelines pipeline
    join sync_external_operations source on source.tenant_id = pipeline.tenant_id
        and source.recording_id = pipeline.recording_id and source.external_operation_id = pipeline.stop_operation_id
        and source.operation_name = 'stop_recording' and source.status in ('pending', 'applied')
    where pipeline.recording_id = source_recording_id and pipeline.capture_completed_at is not null
        and pipeline.capture_epoch > 0
    on conflict (recording_id) do nothing;
    perform recording_try_publish_capture_stop(source_recording_id, clock_timestamp());
    return true;
end;
$$;

create function recording_drain_capture_stop_publications(observed_at timestamptz, batch_size integer)
returns integer language plpgsql volatile as $$
declare
    obligation record;
    attempted integer := 0;
begin
    for obligation in
        select recording_id from recording_capture_stop_publications
        where resolved_at is null and next_attempt_at <= observed_at
        order by next_attempt_at, recording_id
        for update skip locked limit greatest(0, least(batch_size, 100))
    loop
        perform recording_try_publish_capture_stop(obligation.recording_id, observed_at);
        attempted := attempted + 1;
    end loop;
    return attempted;
end;
$$;

create table participant_device_hints (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid primary key,
    generation bigint not null check (generation > 0),
    device_type text check (device_type in ('phone', 'tablet', 'computer')),
    device_kind text check (device_kind in ('iphone', 'ipad', 'android_phone', 'android_tablet', 'android_foldable', 'mac', 'windows', 'linux', 'chromeos')),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);

create table media_plane_kill_switch (
    singleton boolean primary key default true check (singleton),
    paused boolean not null default false,
    updated_at timestamptz not null default now()
);

create table media_plane_kill_switch_changes (
    id bigint generated always as identity primary key,
    changed_at timestamptz not null default now(),
    paused_before boolean not null,
    paused_after boolean not null,
    operator text not null check (btrim(operator) <> ''),
    reason text not null check (btrim(reason) <> '')
);

create table media_plane_changes (
    id bigint generated always as identity primary key,
    changed_at timestamptz not null default now(),
    scope text not null check (scope in ('space', 'tenant', 'kill_switch')),
    tenant_id uuid,
    space_id uuid,
    old_plane text not null check (btrim(old_plane) <> ''),
    new_plane text not null check (btrim(new_plane) <> ''),
    actor text not null check (btrim(actor) <> '' and char_length(actor) <= 200),
    reason text not null check (btrim(reason) <> '' and char_length(reason) <= 500),
    trace_id text check (trace_id ~ '^[0-9a-f]{32}$'),
    emitted_at timestamptz,
    constraint media_plane_changes_scope_keys check (
        (scope = 'space' and tenant_id is not null and space_id is not null)
        or (scope = 'tenant' and tenant_id is not null and space_id is null)
        or (scope = 'kill_switch' and tenant_id is null and space_id is null)
    )
);

create index media_plane_changes_unemitted_idx on media_plane_changes (id) where emitted_at is null;
create index media_plane_changes_scope_idx on media_plane_changes (tenant_id, space_id, id desc);

-- How each Participant session ended on the media node, saved when the Episode ends. The node's trail says the
-- same for 30 days; this row stays with the Participant.
create table participant_media_sessions (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    generation bigint not null check (generation > 0),
    connection_id text not null check (connection_id <> ''),
    cause text not null,
    outcome text not null,
    connected boolean not null,
    ended_at timestamptz not null,
    lifetime_ms bigint not null check (lifetime_ms >= 0),
    connect_ms bigint check (connect_ms >= 0),
    disconnects integer not null check (disconnects >= 0),
    outage_ms bigint not null check (outage_ms >= 0),
    primary key (tenant_id, episode_id, connection_id),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);
create index participant_media_sessions_participant_idx
    on participant_media_sessions(tenant_id, episode_id, participant_id, generation);

-- The telemetry ledger: which seqs of each SDK source the server has stored, rejected or been told
-- were dropped, one row per source, owned by the participant and Episode of its first batch.
create table telemetry_sources (
    tenant_id uuid not null,
    source_id uuid not null,
    participant_id uuid not null,
    episode_id uuid not null,
    -- {"stored": [{"from": 0, "to": 5}], "rejected": [...], "dropped": {"queue_full": [...]}}
    ranges jsonb not null default '{"stored": [], "rejected": [], "dropped": {}}',
    reported_next_seq bigint not null default 0 check (reported_next_seq >= 0),
    end_state text check (end_state in ('closed', 'abandoned')),
    end_next_seq bigint check (end_next_seq >= 0),
    first_received_at timestamptz not null,
    last_received_at timestamptz not null,
    primary key (tenant_id, source_id),
    check ((end_state is null) = (end_next_seq is null))
);
create index telemetry_sources_episode_idx on telemetry_sources (tenant_id, episode_id);
create index telemetry_sources_participant_idx on telemetry_sources (tenant_id, participant_id);
create table telemetry_outbox (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    payload jsonb not null check (jsonb_typeof(payload) = 'array' and jsonb_array_length(payload) > 0),
    available_at timestamptz not null default now(),
    retry boolean not null default false,
    witness boolean not null default false
);
create index telemetry_outbox_ready_idx on telemetry_outbox (available_at, id);
create index telemetry_outbox_tenant_idx on telemetry_outbox (tenant_id);

-- Abort an enqueue at capacity rather than evict acknowledged evidence. The
-- counter is per Tenant, so it follows the Tenant on purge and one Tenant
-- cannot use the whole queue. A witness row (the Episode end Sync commits with the end itself)
-- is neither counted nor refused: it is one small row per Episode, and it must not make an end
-- wait for space or for the usage row a Participant's upload holds.
create table telemetry_outbox_usage (
    tenant_id uuid primary key references tenants(id) on delete cascade,
    max_bytes bigint not null default 16777216,
    queued_bytes bigint not null default 0 check (queued_bytes between 0 and max_bytes)
);

create function account_telemetry_outbox() returns trigger language plpgsql as $$
begin
    if TG_OP = 'INSERT' then
        if new.witness then return null; end if;
        insert into telemetry_outbox_usage (tenant_id, queued_bytes)
        values (new.tenant_id, octet_length(new.payload::text) + 256)
        on conflict (tenant_id) do update set queued_bytes = telemetry_outbox_usage.queued_bytes + excluded.queued_bytes;
    elsif TG_OP = 'DELETE' then
        if old.witness then return null; end if;
        update telemetry_outbox_usage set queued_bytes = queued_bytes - octet_length(old.payload::text) - 256
        where tenant_id = old.tenant_id;
    else
        update telemetry_outbox_usage set queued_bytes = 0;
    end if;
    return null;
end;
$$;
create trigger account_telemetry_outbox_rows after insert or delete on telemetry_outbox
    for each row execute function account_telemetry_outbox();
create trigger account_telemetry_outbox_truncate after truncate on telemetry_outbox
    for each statement execute function account_telemetry_outbox();
create table recording_screen_annotation_layers (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid not null references recordings(id) on delete cascade,
    capture_epoch bigint not null,
    layer_id uuid not null,
    publication_id text not null,
    sharer_generation bigint not null,
    layer jsonb not null,
    initial_at_ms bigint not null,
    initial_revision bigint not null,
    initial_paused boolean not null,
    initial_marks jsonb not null,
    closed_at_ms bigint,
    primary key (tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id),
    check (octet_length(initial_marks::text) <= 1048576)
);
create index recording_annotation_active_layer_idx
    on recording_screen_annotation_layers (tenant_id, space_id, episode_id, layer_id)
    where closed_at_ms is null;

create table recording_screen_annotation_changes (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid not null,
    capture_epoch bigint not null,
    layer_id uuid not null,
    revision bigint not null,
    at_ms bigint not null,
    change jsonb not null check (octet_length(change::text) <= 32768),
    primary key (tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id, revision),
    foreign key (tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id)
        references recording_screen_annotation_layers(tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id)
        on delete cascade
);

create function can_reserve_whiteboard_file(
    scope_tenant uuid, scope_space uuid, scope_scene uuid, caller uuid, requested_file_id text
) returns boolean language plpgsql volatile as $$
declare
    allowed boolean;
begin
    -- Reservation requests serialize before taking a fresh count. Cleanup and
    -- attaching images can only reduce that count and never take this lock.
    perform pg_advisory_xact_lock(hashtextextended('whiteboard-file-admission', 0));
    if exists (
        select 1 from sync_whiteboard_files
        where (tenant_id, space_id, scene_id, file_id) = (scope_tenant, scope_space, scope_scene, requested_file_id)
    ) then
        return true;
    end if;

    -- Count pending, expired, claimed and ready orphans alike. At 20 MiB per
    -- object this caps orphan exposure at 160 MiB per drawer, 640 MiB per
    -- tenant and 3.125 GiB overall (160 rows vs. 200 per cleanup pass).
    select count(*) < 160
        and count(*) filter (where tenant_id = scope_tenant) < 32
        and count(*) filter (where tenant_id = scope_tenant and participant_id = caller) < 8
    into allowed
    from sync_whiteboard_files where referenced_at is null;

    return allowed;
end;
$$;

create function reference_committed_whiteboard_image() returns trigger language plpgsql as $$
declare
    file sync_whiteboard_files%rowtype;
begin
    -- Take the file lock even if our snapshot still shows a pending upload.
    -- Once finalize or cleanup commits, the locked row (or its absence)
    -- decides whether this reference can commit, including on older Sync.
    select uploads.* into file
    from sync_whiteboard_files uploads
    where (uploads.tenant_id, uploads.space_id, uploads.episode_id, uploads.scene_id, uploads.file_id) =
        (new.tenant_id, new.space_id, new.episode_id, new.scene_id, new.payload->>'fileId')
    for no key update;

    if not found or file.status <> 'ready' or file.cleanup_claim_token is not null then
        raise check_violation using message = 'whiteboard image requires a ready, unclaimed file';
    end if;

    if file.referenced_at is null then
        update sync_whiteboard_files set referenced_at = now() where upload_id = file.upload_id;
    end if;
    return null;
end;
$$;

-- Current Sync validates files itself after writing elements. Do not replace
-- its invalid-payload result with a database error from the element write.
create constraint trigger reference_committed_whiteboard_image
    after insert or update of payload, is_deleted on sync_whiteboard_elements
    deferrable initially deferred
    for each row when (new.element_type = 'image' and not new.is_deleted
        and new.payload->>'status' = 'saved' and new.payload->>'fileId' is not null)
    execute function reference_committed_whiteboard_image();

-- Sync writes elements before referencing files. Install the trigger before
-- taking a files-table lock for the index or the reference backfill.
create index sync_whiteboard_files_unreferenced_idx
    on sync_whiteboard_files (tenant_id, participant_id)
    where referenced_at is null;

create table recording_screen_annotation_budgets (
    recording_id uuid primary key references recordings(id) on delete cascade,
    retained_bytes bigint not null,
    layer_count bigint not null,
    exhausted boolean not null default false
);

create function bound_recording_annotation() returns trigger language plpgsql as $$
declare
    layer_delta bigint;
    byte_delta bigint;
    cut_ms bigint;
    is_exhausted boolean;
    -- Leave room below the completion limit and bound changes even at their
    -- minimum size (80 bytes of envelope per change).
    byte_budget constant bigint := 16777216;
    layer_budget constant bigint := 4096;
begin
    if tg_table_name = 'recording_screen_annotation_layers' then
        -- Multiple plans in one capture epoch can seed the same layer.
        if exists (
            select 1 from recording_screen_annotation_layers
            where (tenant_id, space_id, episode_id, recording_id, capture_epoch, layer_id) =
                (new.tenant_id, new.space_id, new.episode_id, new.recording_id, new.capture_epoch, new.layer_id)
        ) then
            return null;
        end if;
        layer_delta := 1;
        byte_delta := octet_length(new.layer::text) + octet_length(new.initial_marks::text) + 256;
        cut_ms := new.initial_at_ms;
    else
        layer_delta := 0;
        byte_delta := octet_length(new.change::text) + 80;
        cut_ms := new.at_ms;
    end if;

    insert into recording_screen_annotation_budgets as budget (recording_id, retained_bytes, layer_count)
    values (new.recording_id, byte_delta, layer_delta)
    on conflict (recording_id) do update
    set exhausted = budget.retained_bytes + byte_delta > byte_budget
                 or budget.layer_count + layer_delta > layer_budget,
        retained_bytes = case
            when budget.retained_bytes + byte_delta <= byte_budget and budget.layer_count + layer_delta <= layer_budget
                then budget.retained_bytes + byte_delta else budget.retained_bytes end,
        layer_count = case
            when budget.retained_bytes + byte_delta <= byte_budget and budget.layer_count + layer_delta <= layer_budget
                then budget.layer_count + layer_delta else budget.layer_count end
    where not budget.exhausted
    returning exhausted into is_exhausted;

    if not found then
        return null;
    end if;
    if is_exhausted then
        -- Keep a coherent prefix across all epochs. Do not allow a later small
        -- change through after an earlier change has been dropped.
        update recording_screen_annotation_layers
        set closed_at_ms = greatest(initial_at_ms, cut_ms)
        where (tenant_id, space_id, episode_id, recording_id) =
            (new.tenant_id, new.space_id, new.episode_id, new.recording_id)
          and closed_at_ms is null;
        return null;
    end if;
    return new;
end;
$$;

create trigger bound_recording_annotation_layers
    before insert on recording_screen_annotation_layers
    for each row execute function bound_recording_annotation();

create trigger bound_recording_annotation_changes
    before insert on recording_screen_annotation_changes
    for each row execute function bound_recording_annotation();

create table helper_devices (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    name text not null,
    public_key text not null,
    credential_hash bytea not null unique,
    registered_at timestamptz not null default now(),
    revoked_at timestamptz,
    loopback boolean not null default false
);
create index helper_devices_tenant_idx on helper_devices (tenant_id, registered_at desc);
create unique index helper_loopback_devices_key_idx on helper_devices (tenant_id, public_key) where loopback;

create table helper_device_requests (
    id uuid primary key,
    code_hash bytea not null unique,
    poll_hash bytea not null unique,
    name text not null,
    public_key text not null,
    credential_hash bytea not null,
    device_id uuid references helper_devices(id) on delete cascade,
    expires_at timestamptz not null,
    next_poll_at timestamptz not null default now(),
    approved_share jsonb,
    approval_expires_at timestamptz,
    intended_tenant_id uuid,
    check ((approved_share is null) = (approval_expires_at is null))
);
create index helper_device_requests_expiry_idx on helper_device_requests (expires_at);

create table screen_annotation_settings (
    singleton boolean primary key default true check (singleton),
    enabled boolean not null
);

-- A Scheduled Episode is an expectation recorded in a Space: when a bounded run of activity is planned
-- and who is expected. It is distinct from an Episode and never starts, ends or admits anything.
-- The id is assigned by the caller and is immutable. A cancelled row is a tombstone that stays so a
-- late write cannot bring the booking back; a tombstone created for an id that was never written holds
-- no expectation (starts_at and the other expectation columns are null).
create table scheduled_episodes (
    tenant_id uuid not null,
    space_id uuid not null,
    id uuid not null,
    starts_at timestamptz,
    expected_ends_at timestamptz,
    expected_participants jsonb,
    metadata jsonb,
    cancelled_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, id),
    foreign key (tenant_id, space_id) references spaces(tenant_id, id) on delete restrict,
    check (
        (
            starts_at is null and expected_ends_at is null and expected_participants is null and metadata is null
            and cancelled_at is not null
        ) or (
            starts_at is not null and expected_ends_at is not null and expected_participants is not null
            and expected_ends_at > starts_at and expected_ends_at - starts_at <= interval '7 days'
            and jsonb_typeof(expected_participants) = 'array'
            and (metadata is null or jsonb_typeof(metadata) = 'object')
        )
    )
);
-- One Space's upcoming plans, in start order.
create index scheduled_episodes_space_upcoming_idx
    on scheduled_episodes (tenant_id, space_id, starts_at)
    where cancelled_at is null;
-- The lookahead across all Tenants: what starts inside a window.
create index scheduled_episodes_upcoming_idx
    on scheduled_episodes (starts_at, tenant_id, space_id, id)
    where cancelled_at is null;

create table sfu_window_nodes (
    id text primary key check (id ~ '^window-sfu-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    application_id text not null,
    provider_firewall_id uuid not null,
    provider_id bigint unique check (provider_id > 0),
    control_address inet check (family(control_address) = 4 and masklen(control_address) = 32),
    phase text not null default 'starting' check (phase in ('starting', 'serving', 'draining', 'deleting', 'deleted')),
    empty_since timestamptz,
    empty_incarnation text,
    created_at timestamptz not null default clock_timestamp(),
    deleted_at timestamptz,
    check (phase = 'starting' or provider_id is not null),
    check (phase not in ('serving', 'draining') or control_address is not null),
    check ((phase = 'deleted') = (deleted_at is not null)),
    check ((empty_since is null) = (empty_incarnation is null)),
    check (empty_since is null or phase = 'draining')
);

create index sfu_window_nodes_live_idx on sfu_window_nodes(application_id, created_at) where deleted_at is null;

create function fence_sfu_window_binding() returns trigger
language plpgsql as $$
declare
    binding jsonb := new.config_snapshot -> 'media_plane_binding';
    target text := binding ->> 'node';
begin
    if new.status = 'ended' or target is null or target not like 'window-sfu-%' then
        return new;
    end if;

    if tg_op = 'UPDATE' and old.status in ('active', 'ending')
        and target = old.config_snapshot -> 'media_plane_binding' ->> 'node' then
        return new;
    end if;

    -- The row lock survives until the Episode commits. A concurrent drain
    -- either follows that commit or fences it out before it can bind.
    perform 1 from sfu_window_nodes where id = target and phase = 'serving' for share;
    if not found then
        raise check_violation using constraint = 'sfu_window_node_accepting',
            message = 'SFU window node is no longer accepting Episode bindings';
    end if;
    return new;
end;
$$;
create trigger episodes_sfu_window_binding
before insert or update of config_snapshot, status on episodes
for each row execute function fence_sfu_window_binding();


create table presenting_settings (
    singleton boolean primary key default true check (singleton),
    enabled boolean not null
);

create table presenting_api_capability (
    singleton boolean primary key default true check (singleton),
    servable boolean not null,
    updated_at timestamptz not null default now()
);

create table presenting_documents (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    document_id uuid not null,
    attachment_id uuid not null,
    created_by_participant_id uuid not null,
    created_by_participant_generation bigint not null,
    file_name text not null,
    mime_type text not null,
    byte_length bigint not null,
    source_object_key text not null,
    source_sha256 bytea not null,
    status text not null,
    failure_code text,
    failure_message text,
    page_count integer,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, document_id),
    unique (tenant_id, space_id, attachment_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    foreign key (tenant_id, space_id, episode_id, created_by_participant_id, created_by_participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (status in ('preparing', 'ready', 'failed')),
    check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    check (byte_length between 1 and 26214400),
    check (octet_length(source_sha256) = 32),
    check (octet_length(source_object_key) between 1 and 1024),
    check (octet_length(file_name) between 1 and 255),
    check (failure_code is null or octet_length(failure_code) between 1 and 128),
    check (failure_message is null or octet_length(failure_message) <= 512),
    check ((status = 'failed') = (failure_code is not null)),
    check (page_count is null or page_count between 1 and 300)
);
create index presenting_documents_episode_idx
    on presenting_documents(tenant_id, space_id, episode_id, created_at, document_id);

create table presenting_document_pages (
    tenant_id uuid not null,
    space_id uuid not null,
    document_id uuid not null,
    page integer not null,
    width integer not null,
    height integer not null,
    status text not null,
    zoom_ready_at timestamptz,
    image_key text,
    thumbnail_key text,
    zoom_key text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, document_id, page),
    foreign key (tenant_id, space_id, document_id)
        references presenting_documents(tenant_id, space_id, document_id)
        on delete cascade,
    check (page between 1 and 300),
    check (width between 1 and 3200 and height between 1 and 3200),
    check (status in ('pending', 'ready')),
    check (image_key is null or octet_length(image_key) between 1 and 1024),
    check (thumbnail_key is null or octet_length(thumbnail_key) between 1 and 1024),
    check (zoom_key is null or octet_length(zoom_key) between 1 and 1024),
    check (status <> 'ready' or (image_key is not null and thumbnail_key is not null)),
    check ((zoom_ready_at is null) = (zoom_key is null))
);
create index presenting_document_pages_zoom_idx
    on presenting_document_pages(tenant_id, space_id, document_id, page)
    where zoom_ready_at is not null;

create table presenting_render_jobs (
    tenant_id uuid not null,
    space_id uuid not null,
    document_id uuid not null,
    job_id uuid not null,
    kind text not null,
    page_start integer not null,
    page_end integer not null,
    status text not null,
    attempt_count integer not null default 0,
    attempt_limit integer not null default 4,
    lease_token uuid,
    lease_owner text,
    lease_expires_at timestamptz,
    available_at timestamptz not null default now(),
    error_code text,
    error_message text,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, document_id, job_id),
    foreign key (tenant_id, space_id, document_id)
        references presenting_documents(tenant_id, space_id, document_id)
        on delete cascade,
    check (kind in ('inventory', 'pages', 'zoom')),
    check (page_start between 1 and 300 and page_end between page_start and 300),
    check (kind <> 'zoom' or page_start = page_end),
    check (status in ('queued', 'leased', 'succeeded', 'failed')),
    check (attempt_count >= 0 and attempt_count <= attempt_limit),
    check (attempt_limit between 1 and 8),
    check ((lease_token is null) = (lease_owner is null)),
    check ((lease_token is null) = (lease_expires_at is null)),
    check (lease_owner is null or octet_length(lease_owner) between 1 and 128),
    check (error_code is null or octet_length(error_code) between 1 and 128),
    check (error_message is null or octet_length(error_message) <= 512),
    check ((status in ('succeeded', 'failed')) = (completed_at is not null))
);
create unique index presenting_render_jobs_one_active_idx
    on presenting_render_jobs(tenant_id, space_id, document_id, kind, page_start, page_end)
    where status in ('queued', 'leased');
create index presenting_render_jobs_claim_idx
    on presenting_render_jobs(available_at, created_at, job_id)
    where status in ('queued', 'leased');

create table presenting_render_uploads (
    tenant_id uuid not null,
    space_id uuid not null,
    document_id uuid not null,
    job_id uuid not null,
    page integer not null,
    rendition text not null,
    attempt integer not null,
    object_key text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id, document_id, job_id, page, rendition, attempt),
    foreign key (tenant_id, space_id, document_id, job_id)
        references presenting_render_jobs(tenant_id, space_id, document_id, job_id)
        on delete cascade,
    unique (object_key),
    check (page between 1 and 300),
    check (rendition in ('image', 'thumbnail', 'zoom')),
    check (attempt between 1 and 8),
    check (octet_length(object_key) between 1 and 1024)
);
create index presenting_render_uploads_document_idx
    on presenting_render_uploads(tenant_id, space_id, document_id, created_at);

create table sync_presenting_states (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    revision bigint not null default 0 check (revision >= 0),
    primary key (tenant_id, space_id, episode_id)
);

create table sync_presenting_documents (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    document_id uuid not null,
    presenter_id uuid not null,
    presenter_generation bigint not null check (presenter_generation > 0),
    position bigint not null check (position > 0),
    page integer not null check (page between 1 and 10000),
    zoom integer not null check (zoom between 25 and 400),
    started_at_ms bigint not null check (started_at_ms >= 0),
    primary key (tenant_id, space_id, episode_id, document_id),
    unique (tenant_id, space_id, episode_id, position),
    foreign key (tenant_id, space_id, episode_id)
        references sync_presenting_states(tenant_id, space_id, episode_id) on delete cascade
);

create table sync_presenting_receipts (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    actor_id uuid not null,
    actor_generation bigint not null check (actor_generation > 0),
    operation_id bytea not null,
    fingerprint bytea not null,
    revision bigint not null check (revision >= 0),
    expires_at_ms bigint not null,
    primary key (tenant_id, space_id, episode_id, actor_id, actor_generation, operation_id)
);

create index sync_presenting_receipts_expiry
    on sync_presenting_receipts(expires_at_ms);

-- +goose StatementBegin
create function sync_presenting_changed() returns trigger language plpgsql as $$
declare
    scope record;
begin
    if tg_op = 'DELETE' then scope := old; else scope := new; end if;
    perform pg_notify('chalk_presenting', concat_ws(':', scope.tenant_id, scope.space_id, scope.episode_id));
    return null;
end;
$$;
-- +goose StatementEnd

create trigger sync_presenting_state_changed
    after insert or update or delete on sync_presenting_states
    for each row execute function sync_presenting_changed();

create trigger sync_presenting_document_changed
    after insert or update or delete on sync_presenting_documents
    for each row execute function sync_presenting_changed();

-- +goose StatementBegin
create function sync_presenting_episode_ended() returns trigger language plpgsql as $$
begin
    if new.status = 'ended' and old.status is distinct from 'ended' then
        delete from sync_presenting_states state
        where state.tenant_id = new.tenant_id
          and state.space_id = new.space_id
          and state.episode_id = new.id;
    end if;
    return null;
end;
$$;
-- +goose StatementEnd

create trigger sync_presenting_episode_ended
    after update of status on episodes
    for each row execute function sync_presenting_episode_ended();

-- +goose StatementBegin
create function sync_presenting_participant_left() returns trigger language plpgsql as $$
begin
    if new.status = 'left' and old.status is distinct from 'left' then
        delete from sync_presenting_documents document
        where document.tenant_id = new.tenant_id
          and document.space_id = new.space_id
          and document.episode_id = new.episode_id
          and document.presenter_id = new.id
          and document.presenter_generation = new.generation;
    end if;
    return null;
end;
$$;
-- +goose StatementEnd

create trigger sync_presenting_participant_left
    after update of status on participants
    for each row execute function sync_presenting_participant_left();
create table recording_transcription_source_renewals (
    recording_id uuid not null references recordings(id) on delete restrict,
    job_id uuid not null references recording_jobs(id) on delete restrict,
    fencing_generation bigint not null check (fencing_generation > 0),
    database_user text not null default current_user,
    operator text not null check (octet_length(operator) between 1 and 256),
    reason text not null check (octet_length(reason) between 1 and 1024),
    source_expires_at timestamptz not null,
    requested_at timestamptz not null default now(),
    primary key (job_id, fencing_generation),
    unique (recording_id, job_id, fencing_generation),
    check (source_expires_at > requested_at)
);
create index recording_transcription_source_renewals_recording_idx
    on recording_transcription_source_renewals(recording_id, source_expires_at);

-- The immutable Episode snapshot sets the first source window. An operator
-- renewal is a later durable fact for the same recording, so every claim,
-- authorization, admission and expiry path reads this one authority.
create function recording_transcription_source_expires_at(
    p_recording_id uuid,
    p_capture_completed_at timestamptz,
    p_config_snapshot jsonb
)
returns timestamptz
language sql
stable
strict
as $$
    select greatest(
        p_capture_completed_at +
            (recording_transcription_source_window_seconds(p_config_snapshot) * interval '1 second'),
        coalesce((
            select max(renewals.source_expires_at)
            from recording_transcription_source_renewals renewals
            join recording_jobs jobs on jobs.id = renewals.job_id
            where renewals.recording_id = p_recording_id
              and jobs.recording_id = p_recording_id
              and jobs.kind = 'transcription'
        ), p_capture_completed_at +
            (recording_transcription_source_window_seconds(p_config_snapshot) * interval '1 second'))
    );
$$;

create function reject_recording_transcription_source_renewal_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording transcription source renewals are append-only';
end;
$$;

create trigger recording_transcription_source_renewals_immutable
before update or delete on recording_transcription_source_renewals
for each row execute function reject_recording_transcription_source_renewal_mutation();
create trigger recording_transcription_source_renewals_no_truncate
before truncate on recording_transcription_source_renewals
for each statement execute function reject_recording_transcription_source_renewal_mutation();
