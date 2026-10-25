-- +goose Up
-- Save original values once, including disabled policies that need a source
-- window. Do not change frozen Episode snapshots or queue past Recordings.
create table if not exists automatic_transcript_space_policy_backup (
    space_id uuid primary key,
    tenant_id uuid not null,
    transcription_policy text not null,
    updated_at timestamptz not null
);

create table if not exists automatic_transcript_tenant_policy_backup (
    tenant_id uuid primary key,
    transcription_ceiling text not null,
    transcription_default_mode text not null,
    provider_policy_version text not null,
    source_window_seconds bigint not null,
    updated_at timestamptz not null
);

-- Match tenant purge's alphabetical table-lock order, including the backups.
lock table automatic_transcript_space_policy_backup, automatic_transcript_tenant_policy_backup, spaces, tenant_artifact_policies in share row exclusive mode;

insert into automatic_transcript_tenant_policy_backup
select tenant_id, transcription_ceiling, transcription_default_mode,
       provider_policy_version, source_window_seconds, updated_at
from tenant_artifact_policies
on conflict (tenant_id) do nothing;

insert into automatic_transcript_space_policy_backup
select id, tenant_id, transcription_policy, updated_at from spaces
on conflict (space_id) do nothing;

alter table tenant_artifact_policies
    alter column transcription_ceiling set default 'automatic',
    alter column transcription_default_mode set default 'automatic',
    alter column provider_policy_version set default 'chalk-automatic-v1';

alter table spaces alter column transcription_policy set default 'automatic';

update tenant_artifact_policies
set transcription_ceiling = 'automatic',
    transcription_default_mode = 'automatic',
    provider_policy_version = 'chalk-automatic-v1',
    source_window_seconds = case when source_window_seconds = 0 then 86400 else source_window_seconds end;

update spaces set transcription_policy = 'automatic';

-- +goose Down
lock table automatic_transcript_space_policy_backup, automatic_transcript_tenant_policy_backup, spaces, tenant_artifact_policies in share row exclusive mode;

update tenant_artifact_policies as policy
set transcription_ceiling = backup.transcription_ceiling,
    transcription_default_mode = backup.transcription_default_mode,
    provider_policy_version = backup.provider_policy_version,
    source_window_seconds = backup.source_window_seconds,
    updated_at = backup.updated_at
from automatic_transcript_tenant_policy_backup as backup
where policy.tenant_id = backup.tenant_id;

update spaces as space
set transcription_policy = backup.transcription_policy,
    updated_at = backup.updated_at
from automatic_transcript_space_policy_backup as backup
where space.id = backup.space_id;

alter table tenant_artifact_policies
    alter column transcription_ceiling set default 'on_demand',
    alter column transcription_default_mode set default 'on_demand',
    alter column provider_policy_version set default 'chalk-on-demand-v1';

alter table spaces alter column transcription_policy set default 'on_demand';

drop table automatic_transcript_space_policy_backup;
drop table automatic_transcript_tenant_policy_backup;
