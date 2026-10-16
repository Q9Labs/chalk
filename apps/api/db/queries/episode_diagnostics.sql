-- Episode Diagnostic roots and reconciliation.

-- name: EnsureDiagnosticEnvironmentOwnership :one
insert into diagnostic_environment_ownership (id, environment)
values (1, sqlc.arg(environment))
on conflict (id) do update
set claimed_at = diagnostic_environment_ownership.claimed_at
where diagnostic_environment_ownership.environment = excluded.environment
returning environment;

-- name: EnsureEpisodeDiagnostic :one
insert into episode_diagnostics (
    id,
    tenant_id,
    space_id,
    episode_id,
    environment,
    state,
    episode_started_at,
    episode_ended_at,
    epilogue_completed_at,
    expires_at,
    run_end_cursor,
    config_snapshot
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    sqlc.arg(environment),
    sqlc.arg(state),
    sqlc.arg(episode_started_at),
    sqlc.narg(episode_ended_at),
    sqlc.narg(epilogue_completed_at),
    sqlc.narg(expires_at),
    sqlc.narg(run_end_cursor),
    sqlc.arg(config_snapshot)
)
on conflict (tenant_id, episode_id) do update
set updated_at = now()
returning *;

-- name: EnsureDiagnosticAuxiliaryRows :exec
    insert into episode_diagnostic_cursor_heads (tenant_id, diagnostic_id)
    values (sqlc.arg(tenant_id), sqlc.arg(diagnostic_id))
    on conflict (tenant_id, diagnostic_id) do nothing;

-- name: GetEpisodeDiagnosticByEpisode :one
select *
from episode_diagnostics
where tenant_id = sqlc.arg(tenant_id)
  and episode_id = sqlc.arg(episode_id);

-- name: ListMissingEpisodeDiagnosticsGlobal :many
select e.*
from episodes e
left join episode_diagnostics d
  on d.tenant_id = e.tenant_id
 and d.episode_id = e.id
where d.id is null
  and e.started_at <= sqlc.arg(now_at)
  and (sqlc.narg(after_created_at)::timestamptz is null or e.created_at > sqlc.narg(after_created_at)::timestamptz)
order by e.created_at asc, e.tenant_id asc, e.id asc
limit sqlc.arg(page_limit)::int;

-- Existing roots created before Episode references were introduced need the
-- same bounded, idempotent reference as newly observed Episodes.
-- name: ListDiagnosticLifecycleDrift :many
select d.*, e.ended_at as authoritative_ended_at
from episode_diagnostics d
join episodes e
  on e.tenant_id = d.tenant_id
 and e.space_id = d.space_id
 and e.id = d.episode_id
where d.environment = sqlc.arg(environment)
  and d.state in ('live', 'ended')
  and e.ended_at is not null
order by d.updated_at asc, d.tenant_id asc, d.id asc
limit sqlc.arg(page_limit)::int;

-- name: UpdateEpisodeDiagnosticLifecycle :one
update episode_diagnostics
set state = sqlc.arg(state),
    episode_ended_at = sqlc.narg(episode_ended_at),
    epilogue_completed_at = sqlc.narg(epilogue_completed_at),
    expires_at = sqlc.narg(expires_at),
    run_end_cursor = sqlc.narg(run_end_cursor),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and id = sqlc.arg(diagnostic_id)
returning *;

-- Cursor-head locking and durable append.

-- name: LockDiagnosticAppendState :one
select h.committed_cursor, d.state, d.episode_started_at, d.episode_ended_at, d.expires_at, d.environment
from episode_diagnostic_cursor_heads h
join episode_diagnostics d
  on d.tenant_id = h.tenant_id
  and d.id = h.diagnostic_id
where h.tenant_id = sqlc.arg(tenant_id)
  and h.diagnostic_id = sqlc.arg(diagnostic_id)
for update of h, d;

-- name: FindEventByID :one
select *
from diagnostic_events
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and event_id = sqlc.arg(event_id);

-- name: FindEventsByIDs :many
select *
from diagnostic_events
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and event_id = any(sqlc.arg(event_ids)::text[])
order by cursor asc;

-- name: InsertDiagnosticEvent :one
insert into diagnostic_events (
    tenant_id,
    diagnostic_id,
    cursor,
    event_id,
    event_fingerprint,
    event_version,
    operation_id,
    producer_operation_ref,
    parent_producer_operation_ref,
    participant_id,
    source,
    name,
    phase,
    state,
    expectation_name,
    expectation_version,
    checkpoint_key,
    checkpoint_class,
    deadline_at,
    journey_id,
    trace_id,
    span_id,
    request_id,
    command_id,
    provider_id,
    retry_group_ref,
    attempt,
    release_id,
    source_commit,
    occurred_at,
    received_at,
    producer_sequence,
    safe_attributes
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(diagnostic_id),
    sqlc.arg(cursor),
    sqlc.arg(event_id),
    sqlc.arg(event_fingerprint),
    sqlc.arg(event_version),
    sqlc.narg(operation_id),
    sqlc.narg(producer_operation_ref),
    sqlc.narg(parent_producer_operation_ref),
    sqlc.narg(participant_id),
    sqlc.arg(source),
    sqlc.arg(name),
    sqlc.arg(phase),
    sqlc.arg(state),
    sqlc.narg(expectation_name),
    sqlc.narg(expectation_version),
    sqlc.narg(checkpoint_key),
    sqlc.narg(checkpoint_class),
    sqlc.narg(deadline_at),
    sqlc.narg(journey_id),
    sqlc.narg(trace_id),
    sqlc.narg(span_id),
    sqlc.narg(request_id),
    sqlc.narg(command_id),
    sqlc.narg(provider_id),
    sqlc.narg(retry_group_ref),
    sqlc.narg(attempt),
    sqlc.narg(release_id),
    sqlc.narg(source_commit),
    sqlc.arg(occurred_at),
    coalesce(sqlc.narg(received_at), now()),
    sqlc.arg(producer_sequence),
    sqlc.arg(safe_attributes)
)
on conflict (tenant_id, diagnostic_id, event_id) do nothing
returning *;

-- name: AdvanceDiagnosticCursorHead :one
with advanced as (
    update episode_diagnostic_cursor_heads
    set committed_cursor = sqlc.arg(committed_cursor),
        updated_at = now()
    where episode_diagnostic_cursor_heads.tenant_id = sqlc.arg(tenant_id)
      and episode_diagnostic_cursor_heads.diagnostic_id = sqlc.arg(diagnostic_id)
      and episode_diagnostic_cursor_heads.committed_cursor <= sqlc.arg(committed_cursor)
    returning episode_diagnostic_cursor_heads.tenant_id,
        episode_diagnostic_cursor_heads.diagnostic_id,
        episode_diagnostic_cursor_heads.committed_cursor
), synced as (
    update episode_diagnostics d
    set committed_cursor = advanced.committed_cursor,
        updated_at = now()
    from advanced
    where d.tenant_id = advanced.tenant_id
      and d.id = advanced.diagnostic_id
    returning d.tenant_id, d.id as diagnostic_id, d.committed_cursor
)
select *
from synced;

-- name: GetDiagnosticParticipant :one
select id, generation, status
from participants
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and episode_id = sqlc.arg(episode_id)
  and id = sqlc.arg(participant_id);

-- name: UpsertDiagnosticBranch :one
insert into diagnostic_branches (
    tenant_id, diagnostic_id, id, kind, state, lease_ends_at, started_at,
    terminal_at, terminal_cursor, attempts, fan_in_children, late_observations, unknown_reason
) values (
    sqlc.arg(tenant_id), sqlc.arg(diagnostic_id), sqlc.arg(id), sqlc.arg(kind), sqlc.arg(state), sqlc.arg(lease_ends_at), sqlc.narg(started_at),
    sqlc.narg(terminal_at), sqlc.narg(terminal_cursor), sqlc.arg(attempts), sqlc.arg(fan_in_children), sqlc.narg(late_observations), sqlc.narg(unknown_reason)
)
on conflict (tenant_id, diagnostic_id, id) do update set
    kind = excluded.kind,
    state = excluded.state,
    lease_ends_at = excluded.lease_ends_at,
    started_at = excluded.started_at,
    terminal_at = excluded.terminal_at,
    terminal_cursor = excluded.terminal_cursor,
    attempts = excluded.attempts,
    fan_in_children = excluded.fan_in_children,
    late_observations = excluded.late_observations,
    unknown_reason = excluded.unknown_reason,
    updated_at = now()
returning *;

-- name: ListDiagnosticBranchesAfter :many
select *
from diagnostic_branches
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and (
      sqlc.narg(after_created_at)::timestamptz is null
      or created_at > sqlc.narg(after_created_at)::timestamptz
      or (created_at = sqlc.narg(after_created_at)::timestamptz and id > sqlc.narg(after_id)::uuid)
  )
order by created_at asc, id asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- Alternate reference resolver.

-- name: ClaimExpiredDiagnostics :many
with candidates as (
    select ed.tenant_id, ed.id
    from episode_diagnostics ed
    where ed.state = 'complete'
      and ed.expires_at is not null
      and ed.expires_at <= sqlc.arg(now_at)
      and (ed.retention_claimed_until is null or ed.retention_claimed_until <= sqlc.arg(now_at))
    order by ed.expires_at asc, ed.tenant_id asc, ed.id asc
    for update skip locked
    limit sqlc.arg(page_limit)::int
)
update episode_diagnostics d
set retention_claim_token = sqlc.arg(claim_token),
    retention_claimed_until = sqlc.arg(claimed_until),
    retention_attempts = retention_attempts + 1,
    updated_at = now()
from candidates
where d.tenant_id = candidates.tenant_id
  and d.id = candidates.id
returning d.*;

-- name: DeleteDiagnosticEventBatch :execrows
with doomed as (
    select e0.tenant_id, e0.diagnostic_id, e0.cursor
    from diagnostic_events e0
    where e0.tenant_id = sqlc.arg(tenant_id)
      and e0.diagnostic_id = sqlc.arg(diagnostic_id)
    order by e0.cursor asc
    limit least(sqlc.arg(page_limit)::int, 10000)
)
delete from diagnostic_events e
using doomed
where e.tenant_id = doomed.tenant_id
  and e.diagnostic_id = doomed.diagnostic_id
  and e.cursor = doomed.cursor;

-- name: DeleteDiagnosticProjectionChanges :execrows
delete from diagnostic_projection_changes
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id);

-- name: DeleteDiagnosticReferences :execrows
delete from diagnostic_references
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id);

-- name: DeleteDiagnosticProjectorState :execrows
delete from diagnostic_projector_dead_letters
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id);

-- name: DeleteDiagnosticRoot :one
delete from episode_diagnostics d
where d.tenant_id = sqlc.arg(tenant_id)
  and d.id = sqlc.arg(diagnostic_id)
  and state in ('complete', 'expired')
  and (expires_at is null or expires_at <= sqlc.arg(now_at))
  and retention_claim_token = sqlc.arg(claim_token)
  and not exists (
      select 1 from diagnostic_events e
      where e.tenant_id = d.tenant_id
        and e.diagnostic_id = d.id
  )
returning *;
