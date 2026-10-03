-- +goose Up
-- Defaults affect only new rows. Existing Tenant and Space policies, and
-- frozen Episode snapshots, remain unchanged.
alter table tenant_artifact_policies
    alter column transcription_ceiling set default 'on_demand',
    alter column transcription_default_mode set default 'on_demand',
    alter column provider_policy_version set default 'chalk-on-demand-v1',
    alter column source_window_seconds set default 86400;

alter table spaces
    alter column transcription_policy set default 'on_demand',
    alter column recording_policy set default 'automatic';

-- +goose Down
alter table spaces
    alter column transcription_policy set default 'disabled',
    alter column recording_policy set default 'disabled';

alter table tenant_artifact_policies
    alter column transcription_ceiling set default 'disabled',
    alter column transcription_default_mode set default 'disabled',
    alter column provider_policy_version set default '',
    alter column source_window_seconds set default 0;
