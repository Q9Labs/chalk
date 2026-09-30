-- +goose Up
alter table provider_operation_receipts
    add column last_error_code text,
    add constraint provider_operation_receipts_error_code_check check (
        last_error_code is null or octet_length(last_error_code) between 1 and 256
    );

-- Re-arm exhausted cleanup; the old finalizer reopened failed ends as active.
-- Only recover abandoned Episodes: durable Participant activity after failure blocks recovery.
-- Pending operations have no failure timestamp, so use their original request time.
-- A renewed screen-share lease is conservatively treated as activity through its expiry.
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
    and not exists (
        select 1 from (
            select greatest(created_at, joined_at, updated_at) as activity_at from participants where tenant_id = operation.tenant_id and space_id = operation.space_id and episode_id = operation.episode_id
            union all
            select created_at as activity_at from sync_control_events where tenant_id = operation.tenant_id and space_id = operation.space_id and episode_id = operation.episode_id
            union all
            select greatest(created_at, completed_at) as activity_at from sync_command_receipts where tenant_id = operation.tenant_id and episode_id = operation.episode_id
            union all
            select created_at as activity_at from sync_chat_messages where tenant_id = operation.tenant_id and space_id = operation.space_id and episode_id = operation.episode_id
            union all
            select greatest(created_at, updated_at) as activity_at from sync_chat_attachments where tenant_id = operation.tenant_id and space_id = operation.space_id and episode_id = operation.episode_id
            union all
            select updated_at as activity_at from sync_chat_read_receipts where tenant_id = operation.tenant_id and space_id = operation.space_id and episode_id = operation.episode_id
            union all
            select completed_at as activity_at from sync_whiteboard_operation_receipts where tenant_id = operation.tenant_id and space_id = operation.space_id and episode_id = operation.episode_id
            union all
            select greatest(created_at, updated_at) as activity_at from sync_whiteboard_files where tenant_id = operation.tenant_id and space_id = operation.space_id and episode_id = operation.episode_id
            union all
            select greatest(created_at, completed_at) as activity_at from sync_publication_grant_reservations where tenant_id = operation.tenant_id and space_id = operation.space_id and episode_id = operation.episode_id
            union all
            select requested_at as activity_at from sync_admission_requests where tenant_id = operation.tenant_id and space_id = operation.space_id and episode_id = operation.episode_id
            union all
            select renewed_until as activity_at from sync_screen_share_leases where tenant_id = operation.tenant_id and space_id = operation.space_id and episode_id = operation.episode_id
        ) participant_activity
        where participant_activity.activity_at > coalesce(operation.completed_at, operation.created_at)
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
