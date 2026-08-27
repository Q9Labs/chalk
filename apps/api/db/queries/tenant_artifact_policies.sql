-- name: LockTenantArtifactPolicyForUpdate :one
select
    tenants.id::uuid as tenant_id,
    tenant_artifact_policies.transcription_ceiling,
    tenant_artifact_policies.transcription_default_mode,
    tenant_artifact_policies.provider_policy_version,
    tenant_artifact_policies.recording_retention_seconds,
    tenant_artifact_policies.transcript_retention_seconds,
    tenant_artifact_policies.source_window_seconds
from tenants
join tenant_artifact_policies on tenant_artifact_policies.tenant_id = tenants.id
where tenants.id = sqlc.arg(tenant_id)
for update of tenants, tenant_artifact_policies;
