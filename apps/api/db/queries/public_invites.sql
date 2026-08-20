-- name: GetSpacePublicInvite :one
select tenant_id, space_id, handle, generation, state_epoch, enabled, public_role,
       admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
       last_rotation_request_key
from space_public_invites
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id);

-- name: LockSpacePublicInvite :one
select tenant_id, space_id, handle, generation, state_epoch, enabled, public_role,
       admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
       last_rotation_request_key
from space_public_invites
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
for update;

-- name: GetSpacePublicInviteByHandle :one
select tenant_id, space_id, handle, generation, state_epoch, enabled, public_role,
       admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
       last_rotation_request_key
from space_public_invites
where handle = sqlc.arg(handle);

-- name: LockSpacePublicInviteByHandle :one
select tenant_id, space_id, handle, generation, state_epoch, enabled, public_role,
       admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
       last_rotation_request_key
from space_public_invites
where handle = sqlc.arg(handle)
for update;

-- name: CreateSpacePublicInvite :one
insert into space_public_invites (
    tenant_id, space_id, handle, generation, state_epoch, enabled, public_role,
    admission_mode, last_actor_id
)
values (
    sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(handle),
    sqlc.arg(generation), sqlc.arg(state_epoch), true, 'collaborator',
    sqlc.arg(admission_mode), sqlc.narg(last_actor_id)
)
on conflict (tenant_id, space_id) do nothing
returning tenant_id, space_id, handle, generation, state_epoch, enabled, public_role,
          admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
          last_rotation_request_key;

-- name: UpdateSpacePublicInviteEnabled :one
update space_public_invites
set enabled = sqlc.arg(enabled),
    state_epoch = case when enabled is distinct from sqlc.arg(enabled)::boolean then state_epoch + 1 else state_epoch end,
    disabled_at = case
        when enabled is not distinct from sqlc.arg(enabled)::boolean then disabled_at
        when sqlc.arg(enabled)::boolean then null
        else now()
    end,
    updated_at = case when enabled is not distinct from sqlc.arg(enabled)::boolean then updated_at else now() end,
    last_actor_id = case when enabled is not distinct from sqlc.arg(enabled)::boolean then last_actor_id else sqlc.narg(last_actor_id) end
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
returning tenant_id, space_id, handle, generation, state_epoch, enabled, public_role,
          admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
          last_rotation_request_key;

-- name: RotateSpacePublicInvite :one
update space_public_invites
set handle = sqlc.arg(handle),
    generation = generation + 1,
    state_epoch = state_epoch + 1,
    enabled = true,
    rotated_at = now(),
    disabled_at = null,
    updated_at = now(),
    last_actor_id = sqlc.narg(last_actor_id),
    last_rotation_request_key = sqlc.narg(last_rotation_request_key)
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
returning tenant_id, space_id, handle, generation, state_epoch, enabled, public_role,
          admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
          last_rotation_request_key;

-- name: CreateSpacePublicArrival :one
insert into space_public_arrivals (
    arrival_handle, tenant_id, space_id, invite_handle, invite_generation,
    invite_state_epoch, identity_mode, display_name, guest_credential_hash, account_id,
    credential_family, provider, provider_subject, idempotency_key, idempotency_fingerprint, state, expires_at
)
values (
    sqlc.arg(arrival_handle), sqlc.arg(tenant_id), sqlc.arg(space_id),
    sqlc.arg(invite_handle), sqlc.arg(invite_generation), sqlc.arg(invite_state_epoch),
    sqlc.arg(identity_mode), sqlc.arg(display_name), sqlc.narg(guest_credential_hash), sqlc.narg(account_id),
    sqlc.narg(credential_family), sqlc.narg(provider), sqlc.narg(provider_subject),
    sqlc.arg(idempotency_key), sqlc.arg(idempotency_fingerprint),
    sqlc.arg(state), sqlc.arg(expires_at)
)
on conflict (tenant_id, space_id, idempotency_key) do nothing
returning arrival_handle, tenant_id, space_id, invite_handle, invite_generation,
       invite_state_epoch, identity_mode, display_name, guest_credential_hash, account_id,
       credential_family, idempotency_key, idempotency_fingerprint, state,
       episode_id, participant_id, participant_generation, provider, provider_subject, expires_at,
       terminal_reason, created_at, updated_at, terminal_at;

-- name: GetSpacePublicArrival :one
select arrival_handle, tenant_id, space_id, invite_handle, invite_generation,
       invite_state_epoch, identity_mode, display_name, guest_credential_hash, account_id,
       credential_family, idempotency_key, idempotency_fingerprint, state,
       episode_id, participant_id, participant_generation, provider, provider_subject, expires_at,
       terminal_reason, created_at, updated_at, terminal_at
from space_public_arrivals
where arrival_handle = sqlc.arg(arrival_handle);

-- name: LockSpacePublicArrival :one
select arrival_handle, tenant_id, space_id, invite_handle, invite_generation,
       invite_state_epoch, identity_mode, display_name, guest_credential_hash, account_id,
       credential_family, idempotency_key, idempotency_fingerprint, state,
       episode_id, participant_id, participant_generation, provider, provider_subject, expires_at,
       terminal_reason, created_at, updated_at, terminal_at
from space_public_arrivals
where arrival_handle = sqlc.arg(arrival_handle)
for update;

-- name: GetSpacePublicArrivalByIdempotency :one
select arrival_handle, tenant_id, space_id, invite_handle, invite_generation,
       invite_state_epoch, identity_mode, display_name, guest_credential_hash, account_id,
       credential_family, idempotency_key, idempotency_fingerprint, state,
       episode_id, participant_id, participant_generation, provider, provider_subject, expires_at,
       terminal_reason, created_at, updated_at, terminal_at
from space_public_arrivals
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and idempotency_key = sqlc.arg(idempotency_key);

-- name: LockSpacePublicArrivalByIdempotency :one
select arrival_handle, tenant_id, space_id, invite_handle, invite_generation,
       invite_state_epoch, identity_mode, display_name, guest_credential_hash, account_id,
       credential_family, idempotency_key, idempotency_fingerprint, state,
       episode_id, participant_id, participant_generation, provider, provider_subject, expires_at,
       terminal_reason, created_at, updated_at, terminal_at
from space_public_arrivals
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and idempotency_key = sqlc.arg(idempotency_key)
for update;

-- name: GetSpacePublicArrivalForCredential :one
select arrival_handle, tenant_id, space_id, invite_handle, invite_generation,
       invite_state_epoch, identity_mode, display_name, guest_credential_hash, account_id,
       credential_family, idempotency_key, idempotency_fingerprint, state,
       episode_id, participant_id, participant_generation, provider, provider_subject, expires_at,
       terminal_reason, created_at, updated_at, terminal_at
from space_public_arrivals
where arrival_handle = sqlc.arg(arrival_handle)
  and guest_credential_hash = sqlc.arg(guest_credential_hash);

-- name: UpdateSpacePublicArrivalState :one
update space_public_arrivals
set state = sqlc.arg(state),
    terminal_reason = sqlc.narg(terminal_reason),
    episode_id = sqlc.narg(episode_id),
    participant_id = sqlc.narg(participant_id),
    participant_generation = sqlc.narg(participant_generation),
    provider = sqlc.narg(provider),
    provider_subject = sqlc.narg(provider_subject),
    terminal_at = case when sqlc.arg(state)::text in ('rejected', 'left', 'unavailable') then now() else terminal_at end,
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and arrival_handle = sqlc.arg(arrival_handle)
returning arrival_handle, tenant_id, space_id, invite_handle, invite_generation,
       invite_state_epoch, identity_mode, display_name, guest_credential_hash, account_id,
       credential_family, idempotency_key, idempotency_fingerprint, state,
       episode_id, participant_id, participant_generation, provider, provider_subject, expires_at,
       terminal_reason, created_at, updated_at, terminal_at;

-- name: ListPendingSpacePublicAdmissionRequests :many
select request_handle, arrival_handle, tenant_id, space_id, display_name, state,
       requested_at, expires_at, decided_at, decided_by, decision_request_key
from space_public_admission_requests
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and (not sqlc.arg(state_set)::boolean or state = sqlc.arg(state)::text)
order by requested_at, request_handle
limit sqlc.arg(page_size)::integer;

-- name: GetSpacePublicAdmissionRequest :one
select request_handle, arrival_handle, tenant_id, space_id, display_name, state,
       requested_at, expires_at, decided_at, decided_by, decision_request_key
from space_public_admission_requests
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and request_handle = sqlc.arg(request_handle);

-- name: LockSpacePublicAdmissionRequest :one
select request_handle, arrival_handle, tenant_id, space_id, display_name, state,
       requested_at, expires_at, decided_at, decided_by, decision_request_key
from space_public_admission_requests
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and request_handle = sqlc.arg(request_handle)
for update;

-- name: CreateSpacePublicAdmissionRequest :one
insert into space_public_admission_requests (
    request_handle, arrival_handle, tenant_id, space_id, display_name, state,
    requested_at, expires_at
)
values (
    sqlc.arg(request_handle), sqlc.arg(arrival_handle), sqlc.arg(tenant_id),
    sqlc.arg(space_id), sqlc.arg(display_name), 'pending', sqlc.arg(requested_at),
    sqlc.arg(expires_at)
)
on conflict (arrival_handle) do update
set arrival_handle = excluded.arrival_handle
returning request_handle, arrival_handle, tenant_id, space_id, display_name, state,
          requested_at, expires_at, decided_at, decided_by, decision_request_key;

-- name: UpdateSpacePublicAdmissionRequest :one
update space_public_admission_requests
set state = sqlc.arg(state), decided_at = now(), decided_by = sqlc.narg(decided_by),
    decision_request_key = sqlc.narg(decision_request_key)
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and request_handle = sqlc.arg(request_handle)
returning request_handle, arrival_handle, tenant_id, space_id, display_name, state,
          requested_at, expires_at, decided_at, decided_by, decision_request_key;

-- name: ListDueAutoSpaceLifecycles :many
with reclaim_expired_claims as (
    update auto_space_lifecycles
    set state = 'active', claim_expires_at = null, updated_at = now()
    where state = 'archiving'
      and claim_expires_at <= sqlc.arg(now_at)
    returning tenant_id, space_id
)
select lifecycle.tenant_id, lifecycle.space_id, lifecycle.deadline_at,
       lifecycle.creator_arrival_handle, lifecycle.state, lifecycle.claim_expires_at,
       lifecycle.next_retry_at,
       lifecycle.retry_count, lifecycle.last_error_family, lifecycle.archive_completed_at,
       lifecycle.journey_id, lifecycle.created_at, lifecycle.updated_at
from auto_space_lifecycles lifecycle
left join reclaim_expired_claims reclaimed
  on reclaimed.tenant_id = lifecycle.tenant_id
 and reclaimed.space_id = lifecycle.space_id
left join space_public_arrivals creator_arrival
  on creator_arrival.tenant_id = lifecycle.tenant_id
 and creator_arrival.space_id = lifecycle.space_id
 and creator_arrival.arrival_handle = lifecycle.creator_arrival_handle
where (lifecycle.state = 'active' or reclaimed.tenant_id is not null)
  and (lifecycle.deadline_at <= sqlc.arg(now_at)
       or creator_arrival.state in ('left', 'rejected', 'unavailable'))
  and (lifecycle.next_retry_at is null or lifecycle.next_retry_at <= sqlc.arg(now_at))
order by lifecycle.deadline_at, lifecycle.tenant_id, lifecycle.space_id
limit sqlc.arg(page_size)::integer;

-- name: GetAutoSpaceLifecycle :one
select tenant_id, space_id, deadline_at, creator_arrival_handle, state,
       claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
       created_at, updated_at
from auto_space_lifecycles
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id);

-- name: LockAutoSpaceLifecycle :one
select tenant_id, space_id, deadline_at, creator_arrival_handle, state,
       claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
       created_at, updated_at
from auto_space_lifecycles
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
for update;

-- name: CreateAutoSpaceLifecycle :one
insert into auto_space_lifecycles (
    tenant_id, space_id, deadline_at, creator_arrival_handle, state,
    next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id
)
values (
    sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(deadline_at),
    sqlc.narg(creator_arrival_handle), sqlc.arg(state), sqlc.narg(next_retry_at),
    sqlc.arg(retry_count), sqlc.narg(last_error_family), sqlc.narg(archive_completed_at), sqlc.narg(journey_id)
)
on conflict (tenant_id, space_id) do nothing
returning tenant_id, space_id, deadline_at, creator_arrival_handle, state,
       claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
       created_at, updated_at;

-- name: MarkAutoSpaceLifecycleArchiving :one
update auto_space_lifecycles
set state = 'archiving', claim_expires_at = now() + interval '5 minutes', updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
  and state = 'active'
returning tenant_id, space_id, deadline_at, creator_arrival_handle, state,
          claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
          created_at, updated_at;

-- name: MarkAutoSpaceLifecycleArchived :one
update auto_space_lifecycles
set state = 'archived', claim_expires_at = null, archive_completed_at = now(), next_retry_at = null,
    last_error_family = null, updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
returning tenant_id, space_id, deadline_at, creator_arrival_handle, state,
          claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
          created_at, updated_at;

-- name: RetryAutoSpaceLifecycle :one
update auto_space_lifecycles
set state = 'active', claim_expires_at = null, next_retry_at = sqlc.arg(next_retry_at),
    retry_count = retry_count + 1, last_error_family = sqlc.narg(last_error_family),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and state = 'archiving'
returning tenant_id, space_id, deadline_at, creator_arrival_handle, state,
          claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
          created_at, updated_at;
