-- +goose Up
alter table provider_operation_receipts
    add column last_error_code text,
    add constraint provider_operation_receipts_error_code_check check (
        last_error_code is null or octet_length(last_error_code) between 1 and 256
    );

-- Re-arm exhausted cleanup; the old finalizer reopened failed ends as active.
-- Keep the identity and fingerprint: the existing receipt is reconciled, not replaced.
with rearmed as (
update sync_external_operations operation
set status = 'pending', attempt_count = 0, next_attempt_at = now(),
    completed_at = null, last_error_code = null, fence_active = true
from episodes episode
where operation.episode_id = episode.id
    and operation.tenant_id = episode.tenant_id
    and episode.status in ('active', 'ending')
    and episode.ended_at is null
    and operation.operation_name in ('end_episode', 'tenant_end_episode', 'maximum_episode_duration_expired')
    and not exists (
        select 1 from sync_external_operations newer
        where newer.tenant_id = operation.tenant_id
            and newer.episode_id = operation.episode_id
            and newer.operation_name in ('end_episode', 'tenant_end_episode', 'maximum_episode_duration_expired')
            and (newer.created_at, newer.external_operation_id) > (operation.created_at, operation.external_operation_id)
    )
    and (
        (operation.status = 'failed' and operation.last_error_code = 'retry_exhausted')
        or (operation.status = 'pending' and operation.attempt_count >= 100)
    )
returning operation.external_operation_id, operation.episode_id, operation.tenant_id
), restored as (
update episodes episode
set status = 'ending', updated_at = now()
from rearmed
where episode.id = rearmed.episode_id and episode.tenant_id = rearmed.tenant_id
    and episode.status in ('active', 'ending') and episode.ended_at is null
returning episode.id
)
update sync_command_receipts receipt
set outcome = 'pending', rejection_reason = null, completed_at = null
from rearmed
where receipt.external_operation_id = rearmed.external_operation_id
    and receipt.outcome = 'rejected'
    and receipt.rejection_reason = 'external_operation_failed';

-- +goose Down
-- +goose StatementBegin
do $$
begin
    raise exception 'provider teardown recovery is irreversible';
end
$$;
-- +goose StatementEnd
