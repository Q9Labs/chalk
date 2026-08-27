-- +goose Up
alter table tenant_artifact_policies
    drop constraint tenant_artifact_policies_recording_retention_check,
    drop constraint tenant_artifact_policies_transcript_retention_check,
    add constraint tenant_artifact_policies_recording_retention_check
        check (recording_retention_seconds between 0 and 9223372036),
    add constraint tenant_artifact_policies_transcript_retention_check
        check (transcript_retention_seconds between 0 and 9223372036);

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
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint between 1 and 86400
                        and value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version' is not null
                        and btrim(value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version') <> ''
                    )
                )
            )
        )
$$;

-- +goose Down
alter table tenant_artifact_policies
    drop constraint tenant_artifact_policies_recording_retention_check,
    drop constraint tenant_artifact_policies_transcript_retention_check,
    add constraint tenant_artifact_policies_recording_retention_check
        check (recording_retention_seconds >= 0),
    add constraint tenant_artifact_policies_transcript_retention_check
        check (transcript_retention_seconds >= 0);

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
