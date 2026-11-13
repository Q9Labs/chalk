-- name: ListPendingSpacePublicAdmissionRequests :many

select sqlc.embed(public),
       (case when live.status = 'admitted' then 'approved'
             when live.status = 'denied' then 'denied'
             when live.status = 'expired' then 'expired'
             when live.admission_request_id is null and public.state = 'pending' and public.expires_at <= now() then 'expired'
             else public.state end)::text as effective_state,
       coalesce(live.status, '')::text as admission_status,
       live.decision_external_operation_id,
       coalesce(operation.operation_name, '')::text as decision_operation
from space_public_admission_requests public
left join sync_admission_requests live
  on live.tenant_id = public.tenant_id and live.space_id = public.space_id
  and live.admission_request_id = public.request_handle
left join sync_external_operations operation
  on operation.tenant_id = live.tenant_id and operation.episode_id = live.episode_id
  and operation.external_operation_id = live.decision_external_operation_id
where public.tenant_id = sqlc.arg(tenant_id) and public.space_id = sqlc.arg(space_id)
  and (not sqlc.arg(state_set)::boolean or public.state = 'pending')
  and (not sqlc.arg(state_set)::boolean or sqlc.arg(state)::text <> 'pending' or public.expires_at > now())
  and (not sqlc.arg(state_set)::boolean or (case when live.status = 'admitted' then 'approved'
             when live.status = 'denied' then 'denied'
             when live.status = 'expired' then 'expired'
             when live.admission_request_id is null and public.state = 'pending' and public.expires_at <= now() then 'expired'
             else public.state end)::text = sqlc.arg(state)::text)
order by public.requested_at, public.request_handle
limit sqlc.arg(page_size)::integer;

-- name: GetSpacePublicAdmissionRequest :one
select sqlc.embed(public),
       (case when live.status = 'admitted' then 'approved'
             when live.status = 'denied' then 'denied'
             when live.status = 'expired' then 'expired'
             when live.admission_request_id is null and public.state = 'pending' and public.expires_at <= now() then 'expired'
             else public.state end)::text as effective_state,
       coalesce(live.status, '')::text as admission_status,
       live.decision_external_operation_id,
       coalesce(operation.operation_name, '')::text as decision_operation
from space_public_admission_requests public
left join sync_admission_requests live
  on live.tenant_id = public.tenant_id and live.space_id = public.space_id
  and live.admission_request_id = public.request_handle
left join sync_external_operations operation
  on operation.tenant_id = live.tenant_id and operation.episode_id = live.episode_id
  and operation.external_operation_id = live.decision_external_operation_id
where public.tenant_id = sqlc.arg(tenant_id) and public.space_id = sqlc.arg(space_id)
  and public.request_handle = sqlc.arg(request_handle);

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

-- name: RecordPublicAdmissionDecision :exec
update space_public_admission_requests
set decided_by = sqlc.narg(decided_by), decision_request_key = sqlc.narg(decision_request_key)
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
  and request_handle = sqlc.arg(request_handle) and state = 'pending';

-- name: GetSpacePublicAdmissionRequestForArrival :one
select sqlc.embed(public),
       (case when live.status = 'admitted' then 'approved'
             when live.status = 'denied' then 'denied'
             when live.status = 'expired' then 'expired'
             when live.admission_request_id is null and public.state = 'pending' and public.expires_at <= now() then 'expired'
             else public.state end)::text as effective_state,
       coalesce(live.status, '')::text as admission_status,
       live.decision_external_operation_id,
       coalesce(operation.operation_name, '')::text as decision_operation
from space_public_admission_requests public
left join sync_admission_requests live
  on live.tenant_id = public.tenant_id and live.space_id = public.space_id
  and live.admission_request_id = public.request_handle
left join sync_external_operations operation
  on operation.tenant_id = live.tenant_id and operation.episode_id = live.episode_id
  and operation.external_operation_id = live.decision_external_operation_id
where public.tenant_id = sqlc.arg(tenant_id) and public.space_id = sqlc.arg(space_id)
  and public.arrival_handle = sqlc.arg(arrival_handle);

-- name: LockPublicEpisodeAdmission :one
select live.*
from sync_admission_requests live
join space_public_admission_requests public
  on public.tenant_id = live.tenant_id and public.space_id = live.space_id
  and public.request_handle = live.admission_request_id
where public.tenant_id = sqlc.arg(tenant_id) and public.space_id = sqlc.arg(space_id)
  and public.request_handle = sqlc.arg(request_handle)
for update of live;

-- name: GetPublicEpisodeAdmission :one
select live.*
from sync_admission_requests live
join space_public_admission_requests public
  on public.tenant_id = live.tenant_id and public.space_id = live.space_id
  and public.request_handle = live.admission_request_id
where public.tenant_id = sqlc.arg(tenant_id) and public.space_id = sqlc.arg(space_id)
  and public.request_handle = sqlc.arg(request_handle);

-- name: GetPublicAdmissionBinding :one
select live.episode_id, live.participant_id, participants.generation
from sync_admission_requests live
join participants on participants.tenant_id = live.tenant_id and participants.space_id = live.space_id
  and participants.episode_id = live.episode_id and participants.id = live.participant_id
where live.tenant_id = sqlc.arg(tenant_id) and live.space_id = sqlc.arg(space_id)
  and live.admission_request_id = sqlc.arg(request_handle);
