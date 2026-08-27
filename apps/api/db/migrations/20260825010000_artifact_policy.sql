-- +goose Up
create table tenant_artifact_policies (
    tenant_id uuid primary key references tenants(id) on delete cascade,
    transcription_ceiling text not null default 'disabled',
    transcription_default_mode text not null default 'disabled',
    provider_policy_version text not null default '',
    recording_retention_seconds bigint not null default 0,
    transcript_retention_seconds bigint not null default 0,
    source_window_seconds bigint not null default 0,
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
        check (recording_retention_seconds >= 0),
    constraint tenant_artifact_policies_transcript_retention_check
        check (transcript_retention_seconds >= 0),
    constraint tenant_artifact_policies_source_window_check
        check (
            (transcription_ceiling = 'disabled' and source_window_seconds = 0)
            or (transcription_ceiling in ('on_demand', 'automatic') and source_window_seconds between 1 and 86400)
        ),
    constraint tenant_artifact_policies_provider_policy_check
        check (transcription_ceiling = 'disabled' or btrim(provider_policy_version) <> '')
);

insert into tenant_artifact_policies (tenant_id)
select id
from tenants;

alter table spaces
    add column recording_policy text not null default 'disabled',
    add column transcription_policy text not null default 'disabled',
    add constraint spaces_recording_policy_check
        check (recording_policy in ('disabled', 'manual', 'automatic')),
    add constraint spaces_transcription_policy_check
        check (transcription_policy in ('disabled', 'on_demand', 'automatic'));

create or replace function validate_episode_config_snapshot(value jsonb)
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
                and (value -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint >= 0
                and jsonb_typeof(value -> 'artifact_policy' -> 'transcription') = 'object'
                and value -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('disabled', 'on_demand', 'automatic')
                and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'retention_seconds') = 'number'
                and (value -> 'artifact_policy' -> 'transcription' ->> 'retention_seconds')::bigint >= 0
                and (
                    (
                        value -> 'artifact_policy' -> 'transcription' ->> 'mode' = 'disabled'
                        and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'source_window_seconds') = 'number'
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint = 0
                    )
                    or (
                        value -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('on_demand', 'automatic')
                        and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'source_window_seconds') = 'number'
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint between 1 and 86400
                        and value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version' is not null
                        and btrim(value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version') <> ''
                    )
                )
            )
        )
$$;

-- +goose Down
create or replace function validate_episode_config_snapshot(value jsonb)
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
$$;

alter table spaces
    drop constraint spaces_transcription_policy_check,
    drop constraint spaces_recording_policy_check,
    drop column transcription_policy,
    drop column recording_policy;

drop table tenant_artifact_policies;
