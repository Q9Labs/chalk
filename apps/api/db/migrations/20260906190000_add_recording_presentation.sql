-- +goose Up
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
    asset_kind text not null check (asset_kind in ('logo', 'avatar', 'chat_attachment', 'whiteboard_state', 'whiteboard_file', 'font')),
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

-- +goose Down
drop trigger if exists recording_presentation_reactions_immutable on recording_presentation_reactions;
drop trigger if exists recording_presentation_assets_immutable on recording_presentation_assets;
drop trigger if exists recording_presentations_immutable on recording_presentations;
drop trigger if exists recording_presentation_sources_immutable on recording_presentation_sources;
drop trigger if exists recording_presentation_baselines_immutable on recording_presentation_baselines;
drop function if exists reject_recording_presentation_mutation();
drop table if exists recording_presentation_reactions;
drop table if exists recording_presentation_assets;
drop table if exists recording_presentations;
drop table if exists recording_presentation_sources;
drop table if exists recording_presentation_baselines;
