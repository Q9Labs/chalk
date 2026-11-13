-- name: ListDueAdmissionRequests :many
-- Separate pending expiry from admitted cleanup. The lateral lookup starts
-- cleanup at current active seats, never at retained admitted-request history.
with candidates as materialized (
    select requests.* from sync_admission_requests requests
    left join space_public_admission_requests public
      on public.tenant_id = requests.tenant_id and public.space_id = requests.space_id
      and public.request_handle = requests.admission_request_id
    left join space_public_arrivals arrivals
      on arrivals.tenant_id = public.tenant_id and arrivals.arrival_handle = public.arrival_handle
    where requests.status = 'pending' and requests.decision_external_operation_id is null
      and sync_admission_expiry_due(requests.expires_at, arrivals.state, now())
    union all
    select request.* from participants participant
    cross join lateral (
        select requests.* from sync_admission_requests requests
        join space_public_admission_requests public
          on public.tenant_id = requests.tenant_id and public.space_id = requests.space_id
          and public.request_handle = requests.admission_request_id
        join space_public_arrivals arrivals
          on arrivals.tenant_id = public.tenant_id and arrivals.arrival_handle = public.arrival_handle
        where requests.tenant_id = participant.tenant_id
          and requests.episode_id = participant.episode_id
          and requests.participant_id = participant.id and requests.status = 'admitted'
          and ((arrivals.state = 'pending'
            and requests.expires_at <= now() and requests.completed_at <= now() - interval '1 minute')
            or arrivals.state in ('unavailable', 'rejected'))
        limit 1
    ) request
    where participant.status = 'active'
)
select requests.*, arrivals.arrival_handle as public_arrival_handle,
       intent.journey_id, intent.producing_trace_id, intent.producing_span_id
from candidates requests
left join sync_lifecycle_intents intent on intent.tenant_id = requests.tenant_id
  and intent.episode_id = requests.episode_id and intent.request_key = requests.request_key
  and intent.intent_name = 'admission_requested'
left join space_public_admission_requests public on public.tenant_id = requests.tenant_id
  and public.space_id = requests.space_id and public.request_handle = requests.admission_request_id
left join space_public_arrivals arrivals on arrivals.tenant_id = public.tenant_id
  and arrivals.arrival_handle = public.arrival_handle
join episodes on episodes.tenant_id = requests.tenant_id and episodes.space_id = requests.space_id
  and episodes.id = requests.episode_id
join participants on participants.tenant_id = requests.tenant_id and participants.episode_id = requests.episode_id
  and participants.id = requests.participant_id
where episodes.status = 'active'
order by requests.expires_at, requests.admission_request_id
limit sqlc.arg(page_size)::integer;

-- name: LockEpisodeAdmissionRequest :one
select * from sync_admission_requests
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
  and episode_id = sqlc.arg(episode_id) and admission_request_id = sqlc.arg(admission_request_id)
for update;

-- name: ReserveEpisodeAdmissionDecision :execrows
update sync_admission_requests
set decision_external_operation_id = sqlc.arg(external_operation_id)
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
  and episode_id = sqlc.arg(episode_id) and admission_request_id = sqlc.arg(admission_request_id)
  and status = 'pending' and decision_external_operation_id is null;


-- name: GetAdmissionDecisionOperationName :one
select operation_name from sync_external_operations
where tenant_id = sqlc.arg(tenant_id) and episode_id = sqlc.arg(episode_id)
  and external_operation_id = sqlc.arg(external_operation_id);

-- name: RequeueFailedAdmissionDecision :one
update sync_external_operations
set status = 'pending', completed_at = null, last_error_code = null,
    next_attempt_at = now(), attempt_count = 0
where tenant_id = sqlc.arg(tenant_id) and episode_id = sqlc.arg(episode_id)
  and external_operation_id = sqlc.arg(external_operation_id)
  and operation_name in ('admit_participant', 'deny_admission', 'admission_request_expired')
  and status = 'failed'
returning *;

-- name: ExpireUncollectedPublicArrival :exec
update space_public_arrivals
set state = 'unavailable', terminal_at = now(), updated_at = now(),
    terminal_reason = 'admission_not_collected'
where tenant_id = sqlc.arg(tenant_id) and arrival_handle = sqlc.arg(arrival_handle)
  and state = 'pending';

-- name: IsAdmissionRequestExpiryDue :one
select sync_admission_expiry_due(sqlc.arg(expires_at)::timestamptz, sqlc.narg(arrival_state)::text, now())::boolean as due;

-- name: ClaimExpiredParticipantPresence :many
-- Lock control before Episode/participant, as entry and heartbeat renewal do.
select control.tenant_id, control.space_id, control.episode_id
from sync_episode_control control
where sqlc.narg(presence_recover_after)::timestamptz <= clock_timestamp()
    and exists (
        select 1 from participants p
        join episodes e on e.tenant_id=p.tenant_id and e.space_id=p.space_id and e.id=p.episode_id
        left join participant_presence_leases lease on lease.tenant_id=p.tenant_id and lease.space_id=p.space_id
            and lease.episode_id=p.episode_id and lease.participant_id=p.id and lease.generation=p.generation
        where p.tenant_id=control.tenant_id and p.space_id=control.space_id
            and p.episode_id=control.episode_id
            and coalesce(lease.expires_at, p.joined_at + interval '600 seconds') <= clock_timestamp()
            and p.status='active' and e.status='active'
    )
    and control.episode_id <> all(sqlc.arg(excluded_episode_ids)::uuid[])
order by control.episode_id
for update of control skip locked
limit sqlc.arg(batch_size);

-- name: ExpiredParticipantPresence :many
select sqlc.embed(p), coalesce(seat.issued_entry_generation, 0)::bigint as entry_generation,
    (lease.expires_at is not null)::boolean as has_presence_lease,
    (extract(epoch from clock_timestamp() - coalesce(lease.expires_at - interval '120 seconds', p.joined_at)) * 1000)::bigint as presence_age_ms
from participants p
left join participant_join_seats seat on seat.tenant_id=p.tenant_id and seat.space_id=p.space_id
    and seat.episode_id=p.episode_id and seat.participant_id=p.id and seat.generation=p.generation
left join participant_presence_leases lease on lease.tenant_id=p.tenant_id and lease.space_id=p.space_id
    and lease.episode_id=p.episode_id and lease.participant_id=p.id and lease.generation=p.generation
where p.tenant_id=sqlc.arg(tenant_id) and p.space_id=sqlc.arg(space_id) and p.episode_id=sqlc.arg(episode_id)
    and p.status='active'
    and coalesce(lease.expires_at, p.joined_at + interval '600 seconds') <= clock_timestamp()
order by p.id
for update of p
limit sqlc.arg(batch_size);
