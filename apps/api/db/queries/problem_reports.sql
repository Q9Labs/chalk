-- name: GetProblemReportAttribution :one
select s.name as space_name,
    coalesce(case when p.name ~ '[^[:space:]@<>]+@[^[:space:]@<>]+' then
        case when p.role = 'owner' or p.account_id = s.created_by_user_id then 'Space owner' else 'Participant' end
        else p.name end, 'Participant')::text as reporter_name,
    (case when p.role = 'owner' or p.account_id = s.created_by_user_id then 'owner' else 'guest' end)::text as reporter_role
from participants p
join spaces s on s.tenant_id = p.tenant_id and s.id = p.space_id
where p.tenant_id = sqlc.arg(tenant_id) and p.space_id = sqlc.arg(space_id)
    and p.episode_id = sqlc.arg(episode_id) and p.id = sqlc.arg(participant_id)
    and p.generation = sqlc.arg(participant_generation);

-- name: InsertProblemReport :exec
-- Commits the durable report row; the ledger event shares the transaction.
insert into problem_reports (
    id, chk_code, tenant_id, space_id, episode_id, participant_id, generation,
    client_session_id, sdk_version, journey_id, picked_symptom, description,
    diagnostics, forward_outcome
) values (
    sqlc.arg(id), sqlc.arg(chk_code), sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(episode_id),
    sqlc.arg(participant_id), sqlc.arg(generation), sqlc.narg(client_session_id), sqlc.narg(sdk_version),
    sqlc.narg(journey_id), sqlc.arg(picked_symptom), sqlc.arg(description), sqlc.narg(diagnostics),
    sqlc.arg(forward_outcome)
);

-- name: SetProblemReportForwardOutcome :exec
update problem_reports
set forward_outcome = sqlc.arg(forward_outcome), updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id);

-- name: GetProblemReport :one
select id, tenant_id, episode_id, participant_id from problem_reports
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id);

-- name: InsertDiagnosticUpload :one
insert into diagnostic_uploads (
    id, tenant_id, episode_id, report_id, live_request_id, trigger,
    state, object_key, expires_at
) values (
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.narg(episode_id), sqlc.narg(report_id),
    sqlc.narg(live_request_id), sqlc.arg(trigger), 'issued', sqlc.arg(object_key), sqlc.arg(expires_at)
)
returning id, expires_at;

-- name: GetDiagnosticUpload :one
select id, tenant_id, episode_id, report_id, live_request_id, trigger, state,
    bytes, sha256, object_key, issued_at, stored_at, failed_at, expires_at
from diagnostic_uploads
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id);

-- name: CompleteDiagnosticUpload :exec
-- Commits stored only for an issued row whose read-back object is the right size.
update diagnostic_uploads
set state = 'stored', stored_at = now(), bytes = sqlc.arg(bytes), sha256 = sqlc.narg(sha256)
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id) and state = 'issued';

-- name: FailDiagnosticUpload :exec
update diagnostic_uploads
set state = 'failed', failed_at = now()
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id) and state = 'issued';

-- name: ExpireDiagnosticUpload :exec
update diagnostic_uploads
set state = 'expired'
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id) and state = 'issued';

-- name: LockLiveRequestEpisode :one
-- Serializes live-request creation per Episode so the pending and hourly checks cannot race.
select id from episodes
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(episode_id)
for update;

-- name: CountPendingLiveIntrospectionRequests :one
select count(*)::bigint from live_introspection_requests
where tenant_id = sqlc.arg(tenant_id) and episode_id = sqlc.arg(episode_id)
    and participant_id = sqlc.arg(participant_id) and expires_at > now();

-- name: CountEpisodeLiveIntrospectionRequests :one
select count(*)::bigint from live_introspection_requests
where tenant_id = sqlc.arg(tenant_id) and episode_id = sqlc.arg(episode_id)
    and requested_at > now() - interval '1 hour';

-- name: InsertLiveIntrospectionRequest :one
-- Snapshots the seat and Episode status in the same statement, so the row is the
-- evidence for whether the seat could have answered.
insert into live_introspection_requests (
    id, tenant_id, episode_id, participant_id, expires_at,
    participant_status, seat_left_at, episode_status
)
select
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(episode_id), p.id,
    now() + interval '60 seconds',
    p.status, p.left_at, e.status
from episodes e
left join participants p
    on p.tenant_id = e.tenant_id and p.episode_id = e.id and p.id = sqlc.arg(participant_id)
where e.tenant_id = sqlc.arg(tenant_id) and e.id = sqlc.arg(episode_id)
returning id, participant_id, requested_at, expires_at, participant_status, seat_left_at, episode_status;

-- name: GetLiveIntrospectionRequest :one
select id, tenant_id, episode_id, participant_id, requested_at, expires_at,
    participant_status, seat_left_at, episode_status, delivery, delivered_at, sockets, unavailable_reason
from live_introspection_requests
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id);

-- name: SetLiveIntrospectionRequestDelivery :exec
-- Sync writes the deliver decision once; expired rows keep pending evidence.
update live_introspection_requests
set delivery = sqlc.arg(delivery), delivered_at = sqlc.narg(delivered_at),
    sockets = sqlc.narg(sockets), unavailable_reason = sqlc.narg(unavailable_reason)
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id) and expires_at > now();
