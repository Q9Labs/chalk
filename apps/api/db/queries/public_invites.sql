-- name: LockTenantSpaceForAdmission :one
-- Serialize admission and policy changes without blocking the previous API's
-- arrival-first INSERT, which needs a foreign-key KEY SHARE lock on this Space.
select * from spaces
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id)
for no key update;

-- name: GetSpacePublicInvite :one
select tenant_id, space_id, handle, invite_code, invite_words, generation, state_epoch, enabled, public_role,
       admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
       last_rotation_request_key
from space_public_invites
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id);

-- name: LockSpacePublicInvite :one
select tenant_id, space_id, handle, invite_code, invite_words, generation, state_epoch, enabled, public_role,
       admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
       last_rotation_request_key
from space_public_invites
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
for update;

-- name: GetSpacePublicInviteByHandle :one
select tenant_id, space_id, handle, invite_code, invite_words, generation, state_epoch, enabled, public_role,
       admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
       last_rotation_request_key
from space_public_invites
where handle = sqlc.arg(handle);

-- name: GetSpacePublicInviteByCode :one
select tenant_id, space_id, handle, invite_code, invite_words, generation, state_epoch, enabled, public_role,
       admission_mode, created_at, updated_at, rotated_at, disabled_at, last_actor_id,
       last_rotation_request_key
from space_public_invites
where invite_code = sqlc.arg(invite_code) or invite_words = sqlc.arg(invite_code);

-- name: LockSpacePublicInviteByHandle :one
select tenant_id, space_id, handle, invite_code, invite_words, generation, state_epoch, enabled, public_role,
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
returning tenant_id, space_id, handle, invite_code, invite_words, generation, state_epoch, enabled, public_role,
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
returning tenant_id, space_id, handle, invite_code, invite_words, generation, state_epoch, enabled, public_role,
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
returning tenant_id, space_id, handle, invite_code, invite_words, generation, state_epoch, enabled, public_role,
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
