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
with inserted_head as (
    insert into episode_diagnostic_cursor_heads (tenant_id, diagnostic_id)
    values (sqlc.arg(tenant_id), sqlc.arg(diagnostic_id))
    on conflict (tenant_id, diagnostic_id) do nothing
), inserted_offset as (
    insert into diagnostic_projector_offsets (tenant_id, diagnostic_id)
    values (sqlc.arg(tenant_id), sqlc.arg(diagnostic_id))
    on conflict (tenant_id, diagnostic_id) do nothing
)
select 1;

-- name: GetEpisodeDiagnosticByOpaqueID :one
select *
from episode_diagnostics
where tenant_id = sqlc.arg(tenant_id)
  and id = sqlc.arg(id);

-- name: GetEpisodeDiagnosticByOpaqueIDGlobal :one
select *
from episode_diagnostics
where id = sqlc.arg(id);

-- name: GetEpisodeDiagnosticByEpisode :one
select *
from episode_diagnostics
where tenant_id = sqlc.arg(tenant_id)
  and episode_id = sqlc.arg(episode_id);

-- name: ListMissingEpisodeDiagnostics :many
select e.*
from episodes e
left join episode_diagnostics d
  on d.tenant_id = e.tenant_id
 and d.episode_id = e.id
where e.tenant_id = sqlc.arg(tenant_id)
  and d.id is null
  and (sqlc.narg(after_created_at)::timestamptz is null or e.created_at > sqlc.narg(after_created_at)::timestamptz)
order by e.created_at asc, e.id asc
limit sqlc.arg(page_limit)::int;

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
-- name: ListEpisodeDiagnosticsMissingEpisodeReference :many
select d.tenant_id, d.id as diagnostic_id, d.episode_id
from episode_diagnostics d
where d.environment = sqlc.arg(environment)
  and d.state <> 'expired'
  and not exists (
      select 1
      from diagnostic_references r
      where r.tenant_id = d.tenant_id
        and r.diagnostic_id = d.id
        and r.id_class = 'chalk.episode'
        and r.raw_value = d.episode_id::text
  )
order by d.created_at asc, d.tenant_id asc, d.id asc
limit sqlc.arg(page_limit)::int;

-- Existing diagnostics can outlive the observer callback. Reconcile compares
-- the durable root with the authoritative Episode row and repairs ended_at
-- drift in bounded batches.
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
  and (d.episode_ended_at is null or e.ended_at > d.episode_ended_at)
order by e.ended_at asc, d.tenant_id asc, d.id asc
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

-- name: LockDiagnosticCursorHead :one
select *
from episode_diagnostic_cursor_heads
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
for update;

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

-- name: GetDiagnosticCursorHead :one
select *
from episode_diagnostic_cursor_heads
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id);

-- Durable event pages and stream catch-up.

-- name: GetDiagnosticParticipant :one
select id, generation, status
from participants
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and episode_id = sqlc.arg(episode_id)
  and id = sqlc.arg(participant_id);

-- name: ListDiagnosticParticipants :many
select participant_id,
       joined_at,
       left_at,
       latest_lifecycle_name,
       latest_lifecycle_state,
       operation_count,
       issue_count,
       first_observed_at,
       last_observed_at
from diagnostic_participant_projections
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and (sqlc.narg(participant_id)::uuid is null or participant_id = sqlc.narg(participant_id)::uuid)
order by participant_id
limit least(sqlc.arg(page_limit)::int, 100);

-- name: UpsertDiagnosticParticipantProjection :exec
insert into diagnostic_participant_projections (
    tenant_id, diagnostic_id, participant_id, joined_at, left_at,
    latest_lifecycle_cursor, latest_lifecycle_name, latest_lifecycle_state,
    operation_count, issue_count, first_observed_at, last_observed_at
)
select e.tenant_id,
       e.diagnostic_id,
       e.participant_id,
       case when e.name in ('participant.join', 'participant.rejoin', 'participant.reconnect') then e.occurred_at end,
       case when e.name = 'participant.leave' then e.occurred_at end,
       case when e.name in ('participant.join', 'participant.rejoin', 'participant.reconnect', 'participant.leave') then e.cursor else 0 end,
       case when e.name in ('participant.join', 'participant.rejoin', 'participant.reconnect', 'participant.leave') then e.name else '' end,
       case when e.name in ('participant.join', 'participant.rejoin', 'participant.reconnect', 'participant.leave') then e.state else '' end,
       0,
       0,
       e.occurred_at,
       e.occurred_at
from diagnostic_events e
where e.tenant_id = sqlc.arg(tenant_id)
  and e.diagnostic_id = sqlc.arg(diagnostic_id)
  and e.cursor = sqlc.arg(cursor)
  and e.participant_id = sqlc.arg(participant_id)
on conflict (tenant_id, diagnostic_id, participant_id) do update
set joined_at = case
        when excluded.joined_at is null then diagnostic_participant_projections.joined_at
        when diagnostic_participant_projections.joined_at is null then excluded.joined_at
        else least(diagnostic_participant_projections.joined_at, excluded.joined_at)
    end,
    left_at = case
        when excluded.left_at is null then diagnostic_participant_projections.left_at
        when diagnostic_participant_projections.left_at is null then excluded.left_at
        else greatest(diagnostic_participant_projections.left_at, excluded.left_at)
    end,
    latest_lifecycle_cursor = case
        when excluded.latest_lifecycle_cursor > diagnostic_participant_projections.latest_lifecycle_cursor then excluded.latest_lifecycle_cursor
        else diagnostic_participant_projections.latest_lifecycle_cursor
    end,
    latest_lifecycle_name = case
        when excluded.latest_lifecycle_cursor > diagnostic_participant_projections.latest_lifecycle_cursor then excluded.latest_lifecycle_name
        else diagnostic_participant_projections.latest_lifecycle_name
    end,
    latest_lifecycle_state = case
        when excluded.latest_lifecycle_cursor > diagnostic_participant_projections.latest_lifecycle_cursor then excluded.latest_lifecycle_state
        else diagnostic_participant_projections.latest_lifecycle_state
    end,
    operation_count = diagnostic_participant_projections.operation_count + excluded.operation_count,
    first_observed_at = least(diagnostic_participant_projections.first_observed_at, excluded.first_observed_at),
    last_observed_at = greatest(diagnostic_participant_projections.last_observed_at, excluded.last_observed_at),
    updated_at = now();

-- name: ListDiagnosticParticipantsAfter :many
select participant_id, joined_at, left_at, latest_lifecycle_name, latest_lifecycle_state,
       operation_count, issue_count, first_observed_at, last_observed_at
from diagnostic_participant_projections
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and (sqlc.narg(after_participant_id)::uuid is null or participant_id > sqlc.narg(after_participant_id)::uuid)
order by participant_id asc
limit least(sqlc.arg(page_limit)::int, 100);

-- name: ListEventsAfterCursor :many
select *
from diagnostic_events
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and cursor > sqlc.arg(after_cursor)
order by cursor asc
limit least(sqlc.arg(page_limit)::int, 10000);

-- name: PageEvents :many
select e.*
from diagnostic_events e
where e.tenant_id = sqlc.arg(tenant_id)
  and e.diagnostic_id = sqlc.arg(diagnostic_id)
  and e.cursor > coalesce(sqlc.narg(after_cursor)::bigint, 0)
  and (sqlc.narg(before_cursor)::bigint is null or e.cursor < sqlc.narg(before_cursor)::bigint)
  and (sqlc.narg(participant_id)::uuid is null or e.participant_id = sqlc.narg(participant_id)::uuid)
  and (sqlc.narg(source)::text is null or e.source = sqlc.narg(source)::text)
  and (sqlc.narg(operation_kind)::text is null or e.operation_id in (
      select id
      from diagnostic_operations
      where diagnostic_operations.tenant_id = sqlc.arg(tenant_id)
        and diagnostic_operations.diagnostic_id = sqlc.arg(diagnostic_id)
        and kind = sqlc.narg(operation_kind)::text
  ))
  and (sqlc.narg(state)::text is null or e.state = sqlc.narg(state)::text)
  and (sqlc.narg(release_id)::text is null or e.release_id = sqlc.narg(release_id)::text)
  and (sqlc.narg(request_id)::text is null or e.request_id = sqlc.narg(request_id)::text)
  and (sqlc.narg(command_id)::text is null or e.command_id = sqlc.narg(command_id)::text)
  and (sqlc.narg(provider_id)::text is null or e.provider_id = sqlc.narg(provider_id)::text)
  and (sqlc.narg(journey_id)::text is null or e.journey_id = sqlc.narg(journey_id)::text)
  and (sqlc.narg(trace_id)::text is null or e.trace_id = sqlc.narg(trace_id)::text)
  and (sqlc.narg(span_id)::text is null or (
      sqlc.narg(trace_id)::text is not null
      and e.trace_id = sqlc.narg(trace_id)::text
      and e.span_id = sqlc.narg(span_id)::text
  ))
  and (sqlc.narg(from_time)::timestamptz is null or e.occurred_at >= sqlc.narg(from_time)::timestamptz)
  and (sqlc.narg(to_time)::timestamptz is null or e.occurred_at < sqlc.narg(to_time)::timestamptz)
order by e.cursor asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: GetDiagnosticEventByCursor :one
select *
from diagnostic_events
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and cursor = sqlc.arg(cursor);

-- name: CountDiagnosticParticipantsFiltered :one
select count(*)::bigint as participant_count
from diagnostic_participant_projections p
where p.tenant_id = sqlc.arg(tenant_id)
  and p.diagnostic_id = sqlc.arg(diagnostic_id)
  and (sqlc.narg(participant_id)::uuid is null or p.participant_id = sqlc.narg(participant_id)::uuid)
  and exists (
      select 1 from diagnostic_events e
      where e.tenant_id = p.tenant_id and e.diagnostic_id = p.diagnostic_id and e.participant_id = p.participant_id
        and e.cursor >= coalesce(sqlc.narg(from_cursor)::bigint, 0)
        and (sqlc.narg(to_cursor)::bigint is null or e.cursor <= sqlc.narg(to_cursor)::bigint)
        and (sqlc.narg(source)::text is null or e.source = sqlc.narg(source)::text)
        and (sqlc.narg(operation_kind)::text is null or e.operation_id in (select id from diagnostic_operations op where op.tenant_id = e.tenant_id and op.diagnostic_id = e.diagnostic_id and op.kind = sqlc.narg(operation_kind)::text))
        and (sqlc.narg(state)::text is null or e.state = sqlc.narg(state)::text)
        and (sqlc.narg(release_id)::text is null or e.release_id = sqlc.narg(release_id)::text)
        and (sqlc.narg(request_id)::text is null or e.request_id = sqlc.narg(request_id)::text)
        and (sqlc.narg(command_id)::text is null or e.command_id = sqlc.narg(command_id)::text)
        and (sqlc.narg(provider_id)::text is null or e.provider_id = sqlc.narg(provider_id)::text)
        and (sqlc.narg(journey_id)::text is null or e.journey_id = sqlc.narg(journey_id)::text)
        and (sqlc.narg(trace_id)::text is null or e.trace_id = sqlc.narg(trace_id)::text)
        and (sqlc.narg(span_id)::text is null or (sqlc.narg(trace_id)::text is not null and e.trace_id = sqlc.narg(trace_id)::text and e.span_id = sqlc.narg(span_id)::text))
        and (sqlc.narg(from_time)::timestamptz is null or e.occurred_at >= sqlc.narg(from_time)::timestamptz)
        and (sqlc.narg(to_time)::timestamptz is null or e.occurred_at < sqlc.narg(to_time)::timestamptz)
  );

-- name: CountDiagnosticEventsFiltered :one
select count(*)::bigint as event_count
from diagnostic_events e
where e.tenant_id = sqlc.arg(tenant_id)
  and e.diagnostic_id = sqlc.arg(diagnostic_id)
  and e.cursor >= coalesce(sqlc.narg(from_cursor)::bigint, 0)
  and (sqlc.narg(to_cursor)::bigint is null or e.cursor <= sqlc.narg(to_cursor)::bigint)
  and (sqlc.narg(participant_id)::uuid is null or e.participant_id = sqlc.narg(participant_id)::uuid)
  and (sqlc.narg(source)::text is null or e.source = sqlc.narg(source)::text)
  and (sqlc.narg(operation_kind)::text is null or e.operation_id in (
      select id from diagnostic_operations op
      where op.tenant_id = e.tenant_id and op.diagnostic_id = e.diagnostic_id and op.kind = sqlc.narg(operation_kind)::text
  ))
  and (sqlc.narg(state)::text is null or e.state = sqlc.narg(state)::text)
  and (sqlc.narg(release_id)::text is null or e.release_id = sqlc.narg(release_id)::text)
  and (sqlc.narg(request_id)::text is null or e.request_id = sqlc.narg(request_id)::text)
  and (sqlc.narg(command_id)::text is null or e.command_id = sqlc.narg(command_id)::text)
  and (sqlc.narg(provider_id)::text is null or e.provider_id = sqlc.narg(provider_id)::text)
  and (sqlc.narg(journey_id)::text is null or e.journey_id = sqlc.narg(journey_id)::text)
  and (sqlc.narg(trace_id)::text is null or e.trace_id = sqlc.narg(trace_id)::text)
  and (sqlc.narg(span_id)::text is null or (sqlc.narg(trace_id)::text is not null and e.trace_id = sqlc.narg(trace_id)::text and e.span_id = sqlc.narg(span_id)::text))
  and (sqlc.narg(from_time)::timestamptz is null or e.occurred_at >= sqlc.narg(from_time)::timestamptz)
  and (sqlc.narg(to_time)::timestamptz is null or e.occurred_at < sqlc.narg(to_time)::timestamptz);

-- Projector leasing, event paging, and projection writes.

-- name: ClaimProjectorOffsets :many
with candidates as (
    select o.tenant_id, o.diagnostic_id
    from diagnostic_projector_offsets o
    join episode_diagnostics d
      on d.tenant_id = o.tenant_id and d.id = o.diagnostic_id
    where o.projected_cursor < d.committed_cursor
      and (o.lease_until is null or o.lease_until <= now())
    order by o.updated_at asc, o.tenant_id asc, o.diagnostic_id asc
    for update of o skip locked
    limit sqlc.arg(page_limit)::int
)
update diagnostic_projector_offsets o
set lease_token = sqlc.arg(lease_token),
    lease_owner = sqlc.arg(lease_owner),
    lease_until = now() + make_interval(secs => sqlc.arg(lease_seconds)::int),
    updated_at = now()
from candidates
where o.tenant_id = candidates.tenant_id
  and o.diagnostic_id = candidates.diagnostic_id
returning o.*;

-- name: RenewProjectorOffsetLease :one
update diagnostic_projector_offsets
set lease_until = now() + make_interval(secs => sqlc.arg(lease_seconds)::int),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and lease_token = sqlc.arg(lease_token)
returning *;

-- name: ListUnprojectedEvents :many
select e.*
from diagnostic_events e
join diagnostic_projector_offsets o
  on o.tenant_id = e.tenant_id and o.diagnostic_id = e.diagnostic_id
where e.tenant_id = sqlc.arg(tenant_id)
  and e.diagnostic_id = sqlc.arg(diagnostic_id)
  and e.cursor > o.projected_cursor
order by e.cursor asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: AdvanceProjectorOffset :one
update diagnostic_projector_offsets
set projected_cursor = greatest(projected_cursor, sqlc.arg(projected_cursor)),
    lease_token = null,
    lease_owner = null,
    lease_until = null,
    failure_count = 0,
    last_error_class = null,
    last_error_at = null,
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and lease_token = sqlc.arg(lease_token)
returning *;

-- name: RecordProjectorFailure :one
update diagnostic_projector_offsets
set failure_count = failure_count + 1,
    last_error_class = sqlc.arg(error_class),
    last_error_at = now(),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and lease_token = sqlc.arg(lease_token)
returning *;

-- name: ReleaseProjectorFailureLease :one
update diagnostic_projector_offsets
set lease_token = null,
    lease_owner = null,
    lease_until = null,
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and lease_token = sqlc.arg(lease_token)
returning *;

-- name: GetFirstUnprojectedDiagnosticEvent :one
select e.*
from diagnostic_events e
join diagnostic_projector_offsets o
  on o.tenant_id = e.tenant_id and o.diagnostic_id = e.diagnostic_id
where e.tenant_id = sqlc.arg(tenant_id)
  and e.diagnostic_id = sqlc.arg(diagnostic_id)
  and e.cursor > o.projected_cursor
order by e.cursor asc
limit 1;

-- name: AdvanceProjectorOffsetAfterDeadLetter :one
update diagnostic_projector_offsets
set projected_cursor = greatest(projected_cursor, sqlc.arg(projected_cursor)),
    lease_token = null,
    lease_owner = null,
    lease_until = null,
    failure_count = 0,
    last_error_class = null,
    last_error_at = null,
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and projected_cursor = sqlc.arg(expected_projected_cursor)
  and projected_cursor < sqlc.arg(projected_cursor)
  and lease_token = sqlc.arg(lease_token)
returning *;

-- name: UpsertDiagnosticOperation :one
insert into diagnostic_operations (
    tenant_id, diagnostic_id, id, parent_id, branch_id, participant_id,
    producer_operation_ref, parent_producer_operation_ref, kind, expectation_version,
    state, retry_group_id, retry_group_ref, attempt, started_at, deadline_at,
    grace_ends_at, ended_at, error_class, source, release_id, source_commit,
    request_id, command_id, provider_id, journey_id, trace_id, span_id,
    clock_uncertainty, visibility_gaps, first_evidence_cursor, last_evidence_cursor
) values (
    sqlc.arg(tenant_id), sqlc.arg(diagnostic_id), sqlc.arg(id), sqlc.narg(parent_id), sqlc.narg(branch_id), sqlc.narg(participant_id),
    sqlc.narg(producer_operation_ref), sqlc.narg(parent_producer_operation_ref), sqlc.arg(kind), sqlc.arg(expectation_version),
    sqlc.arg(state), sqlc.narg(retry_group_id), sqlc.narg(retry_group_ref), sqlc.arg(attempt), sqlc.arg(started_at), sqlc.narg(deadline_at),
    sqlc.narg(grace_ends_at), sqlc.narg(ended_at), sqlc.narg(error_class), sqlc.arg(source), sqlc.narg(release_id), sqlc.narg(source_commit),
    sqlc.narg(request_id), sqlc.narg(command_id), sqlc.narg(provider_id), sqlc.narg(journey_id), sqlc.narg(trace_id), sqlc.narg(span_id),
    sqlc.narg(clock_uncertainty), sqlc.arg(visibility_gaps), sqlc.arg(first_evidence_cursor), sqlc.narg(last_evidence_cursor)
)
on conflict (tenant_id, diagnostic_id, id) do update set
    parent_id = excluded.parent_id,
    branch_id = excluded.branch_id,
    participant_id = coalesce(diagnostic_operations.participant_id, excluded.participant_id),
    producer_operation_ref = excluded.producer_operation_ref,
    parent_producer_operation_ref = excluded.parent_producer_operation_ref,
    kind = excluded.kind,
    expectation_version = excluded.expectation_version,
    state = excluded.state,
    retry_group_id = excluded.retry_group_id,
    retry_group_ref = excluded.retry_group_ref,
    attempt = excluded.attempt,
    started_at = excluded.started_at,
    deadline_at = excluded.deadline_at,
    grace_ends_at = excluded.grace_ends_at,
    ended_at = excluded.ended_at,
    error_class = excluded.error_class,
    source = excluded.source,
    release_id = excluded.release_id,
    source_commit = excluded.source_commit,
    request_id = excluded.request_id,
    command_id = excluded.command_id,
    provider_id = excluded.provider_id,
    journey_id = excluded.journey_id,
    trace_id = excluded.trace_id,
    span_id = excluded.span_id,
    clock_uncertainty = excluded.clock_uncertainty,
    visibility_gaps = excluded.visibility_gaps,
    first_evidence_cursor = case
        when diagnostic_operations.first_evidence_cursor = 0 then excluded.first_evidence_cursor
        when excluded.first_evidence_cursor = 0 then diagnostic_operations.first_evidence_cursor
        else least(diagnostic_operations.first_evidence_cursor, excluded.first_evidence_cursor)
    end,
    last_evidence_cursor = excluded.last_evidence_cursor,
    updated_at = now()
returning *;

-- name: AssignDiagnosticEventOperation :execrows
update diagnostic_events
set operation_id = sqlc.arg(operation_id)
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and cursor = sqlc.arg(cursor)
  and (operation_id is null or operation_id = sqlc.arg(operation_id));

-- name: RefreshDiagnosticParticipantCounts :exec
update diagnostic_participant_projections p
set operation_count = (
        select count(*)::bigint
        from diagnostic_operations op
        where op.tenant_id = p.tenant_id
          and op.diagnostic_id = p.diagnostic_id
          and op.participant_id = p.participant_id
    ),
    issue_count = (
        select count(distinct i.id)::bigint
        from diagnostic_issues i
        join diagnostic_operations op
          on op.tenant_id = i.tenant_id
         and op.diagnostic_id = i.diagnostic_id
         and op.id = i.operation_id
        where i.tenant_id = p.tenant_id
          and i.diagnostic_id = p.diagnostic_id
          and op.participant_id = p.participant_id
    ),
    updated_at = now()
where p.tenant_id = sqlc.arg(tenant_id)
  and p.diagnostic_id = sqlc.arg(diagnostic_id);

-- name: UpsertDiagnosticCheckpoint :one
insert into diagnostic_checkpoints (
    tenant_id, diagnostic_id, operation_id, checkpoint_key, class, display_order,
    deadline_at, state, evidence_cursor, unknown_reason, predicate
) values (
    sqlc.arg(tenant_id), sqlc.arg(diagnostic_id), sqlc.arg(operation_id), sqlc.arg(checkpoint_key), sqlc.arg(class),
    sqlc.arg(display_order), sqlc.narg(deadline_at), sqlc.arg(state), sqlc.narg(evidence_cursor), sqlc.narg(unknown_reason), sqlc.narg(predicate)
)
on conflict (tenant_id, diagnostic_id, operation_id, checkpoint_key) do update set
    class = excluded.class,
    display_order = excluded.display_order,
    deadline_at = excluded.deadline_at,
    state = excluded.state,
    evidence_cursor = excluded.evidence_cursor,
    unknown_reason = excluded.unknown_reason,
    predicate = excluded.predicate,
    updated_at = now()
returning *;

-- name: UpsertDiagnosticIssue :one
insert into diagnostic_issues (
    tenant_id, diagnostic_id, id, operation_id, kind, severity, state, summary,
    affected_kind, affected_id_class, affected_id_value, affected_id_copyable,
    last_confirmed_checkpoint, missing_checkpoint, first_observed_at, last_observed_at,
    resolved_at, retry_state, unknown_reason
) values (
    sqlc.arg(tenant_id), sqlc.arg(diagnostic_id), sqlc.arg(id), sqlc.narg(operation_id), sqlc.arg(kind),
    sqlc.arg(severity), sqlc.arg(state), sqlc.arg(summary), sqlc.narg(affected_kind), sqlc.narg(affected_id_class), sqlc.narg(affected_id_value), sqlc.narg(affected_id_copyable), sqlc.narg(last_confirmed_checkpoint), sqlc.narg(missing_checkpoint),
    sqlc.arg(first_observed_at), sqlc.narg(last_observed_at), sqlc.narg(resolved_at), sqlc.narg(retry_state), sqlc.narg(unknown_reason)
)
on conflict (tenant_id, diagnostic_id, id) do update set
    operation_id = excluded.operation_id,
    kind = excluded.kind,
    severity = excluded.severity,
    state = excluded.state,
    summary = excluded.summary,
    affected_kind = excluded.affected_kind,
    affected_id_class = excluded.affected_id_class,
    affected_id_value = excluded.affected_id_value,
    affected_id_copyable = excluded.affected_id_copyable,
    last_confirmed_checkpoint = excluded.last_confirmed_checkpoint,
    missing_checkpoint = excluded.missing_checkpoint,
    first_observed_at = excluded.first_observed_at,
    last_observed_at = excluded.last_observed_at,
    resolved_at = excluded.resolved_at,
    retry_state = excluded.retry_state,
    unknown_reason = excluded.unknown_reason,
    updated_at = now()
returning *;

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

-- name: RecordProjectionChange :one
insert into diagnostic_projection_changes (
    tenant_id, diagnostic_id, cursor, ordinal, kind, entity_type, entity_id, payload
) values (
    sqlc.arg(tenant_id), sqlc.arg(diagnostic_id), sqlc.arg(cursor), sqlc.arg(ordinal), sqlc.arg(kind),
    sqlc.narg(entity_type), sqlc.narg(entity_id), sqlc.arg(payload)
)
on conflict (tenant_id, diagnostic_id, cursor) do nothing
returning *;

-- name: ListProjectionChangesAfterCursor :many
select *
from diagnostic_projection_changes
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and cursor > sqlc.arg(after_cursor)
order by cursor asc, ordinal asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: GetDiagnosticProjectorOffset :one
select *
from diagnostic_projector_offsets
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id);

-- Deadline scans and synthetic state transitions.

-- name: ScanOperationDeadlines :many
select *
from diagnostic_operations
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and state in ('running', 'retrying')
  and deadline_at is not null
  and deadline_at <= sqlc.arg(now_at)
order by deadline_at asc, id asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: ScanOperationDeadlinesGlobal :many
select o.*
from diagnostic_operations o
where o.state in ('running', 'retrying')
  and o.deadline_at is not null
  and o.deadline_at <= sqlc.arg(now_at)
order by o.deadline_at asc, o.tenant_id asc, o.diagnostic_id asc, o.id asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: ScanOperationGraceDeadlinesGlobal :many
select o.*
from diagnostic_operations o
where o.state = 'stalled'
  and o.grace_ends_at is not null
  and o.grace_ends_at <= sqlc.arg(now_at)
order by o.grace_ends_at asc, o.tenant_id asc, o.diagnostic_id asc, o.id asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: ScanBranchDeadlines :many
select *
from diagnostic_branches
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and state in ('pending', 'running')
  and lease_ends_at <= sqlc.arg(now_at)
order by lease_ends_at asc, id asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: ScanBranchDeadlinesGlobal :many
select b.*,
       owner.operation_id as branch_operation_id,
       owner.producer_operation_ref as branch_operation_ref
from diagnostic_branches b
left join lateral (
    select o.id as operation_id, o.producer_operation_ref
    from diagnostic_operations o
    where o.tenant_id = b.tenant_id
      and o.diagnostic_id = b.diagnostic_id
      and o.branch_id = b.id
    order by o.first_evidence_cursor asc, o.id asc
    limit 1
) owner on true
where b.state in ('pending', 'running')
  and b.lease_ends_at <= sqlc.arg(now_at)
order by b.lease_ends_at asc, b.tenant_id asc, b.diagnostic_id asc, b.id asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: MarkDiagnosticOperationState :one
update diagnostic_operations
set state = sqlc.arg(state),
    ended_at = sqlc.narg(ended_at),
    error_class = sqlc.narg(error_class),
    last_evidence_cursor = sqlc.narg(last_evidence_cursor),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = sqlc.arg(id)
returning *;

-- name: MarkDiagnosticBranchState :one
update diagnostic_branches
set state = sqlc.arg(state),
    terminal_at = sqlc.narg(terminal_at),
    terminal_cursor = sqlc.narg(terminal_cursor),
    late_observations = coalesce(sqlc.narg(late_observations), late_observations),
    unknown_reason = sqlc.narg(unknown_reason),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = sqlc.arg(id)
returning *;

-- Snapshot, operation/checkpoint/issue/branch pages, and counts.

-- name: GetDiagnosticSnapshot :one
select
    d.*,
    coalesce(o.projected_cursor, 0)::bigint as projected_cursor,
    (select count(*)::bigint from diagnostic_events e where e.tenant_id = d.tenant_id and e.diagnostic_id = d.id) as event_count,
    (select count(*)::bigint from diagnostic_operations op where op.tenant_id = d.tenant_id and op.diagnostic_id = d.id) as operation_count,
    (select count(*)::bigint from diagnostic_issues i where i.tenant_id = d.tenant_id and i.diagnostic_id = d.id) as issue_count,
    (select count(*)::bigint from diagnostic_issues i where i.tenant_id = d.tenant_id and i.diagnostic_id = d.id and i.state = 'open') as open_issue_count,
    (select count(distinct e.participant_id)::bigint from diagnostic_events e where e.tenant_id = d.tenant_id and e.diagnostic_id = d.id and e.participant_id is not null) as participant_count,
    (select count(*)::bigint from diagnostic_branches b where b.tenant_id = d.tenant_id and b.diagnostic_id = d.id) as branch_count
from episode_diagnostics d
left join diagnostic_projector_offsets o
  on o.tenant_id = d.tenant_id and o.diagnostic_id = d.id
where d.tenant_id = sqlc.arg(tenant_id)
  and d.id = sqlc.arg(diagnostic_id);

-- name: ListDiagnosticOperations :many
select *
from diagnostic_operations
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and (sqlc.narg(after_evidence_cursor)::bigint is null or first_evidence_cursor > sqlc.narg(after_evidence_cursor)::bigint)
  and (sqlc.narg(operation_kind)::text is null or kind = sqlc.narg(operation_kind)::text)
  and (sqlc.narg(state)::text is null or state = sqlc.narg(state)::text)
  and (sqlc.narg(source)::text is null or source = sqlc.narg(source)::text)
  and (sqlc.narg(release_id)::text is null or release_id = sqlc.narg(release_id)::text)
  and (sqlc.narg(request_id)::text is null or request_id = sqlc.narg(request_id)::text)
  and (sqlc.narg(command_id)::text is null or command_id = sqlc.narg(command_id)::text)
  and (sqlc.narg(provider_id)::text is null or provider_id = sqlc.narg(provider_id)::text)
  and (sqlc.narg(journey_id)::text is null or journey_id = sqlc.narg(journey_id)::text)
  and (sqlc.narg(trace_id)::text is null or trace_id = sqlc.narg(trace_id)::text)
  and (sqlc.narg(span_id)::text is null or (sqlc.narg(trace_id)::text is not null and trace_id = sqlc.narg(trace_id)::text and span_id = sqlc.narg(span_id)::text))
  and (sqlc.narg(from_time)::timestamptz is null or started_at >= sqlc.narg(from_time)::timestamptz)
  and (sqlc.narg(to_time)::timestamptz is null or started_at < sqlc.narg(to_time)::timestamptz)
order by first_evidence_cursor asc, id asc
limit least(sqlc.arg(page_limit)::int, 10000);

-- name: ListDiagnosticOperationsByIDs :many
select *
from diagnostic_operations
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = any(sqlc.arg(operation_ids)::uuid[])
order by first_evidence_cursor asc, id asc;

-- name: CountDiagnosticEvents :one
select count(*)::bigint as event_count
from diagnostic_events
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and cursor >= sqlc.arg(cursor_from)
  and (sqlc.narg(cursor_to)::bigint is null or cursor <= sqlc.narg(cursor_to)::bigint);

-- name: CountDiagnosticOperationsFiltered :one
select count(*)::bigint as operation_count
from diagnostic_operations
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and (sqlc.narg(operation_kind)::text is null or kind = sqlc.narg(operation_kind)::text)
  and (sqlc.narg(state)::text is null or state = sqlc.narg(state)::text)
  and (sqlc.narg(source)::text is null or source = sqlc.narg(source)::text)
  and (sqlc.narg(release_id)::text is null or release_id = sqlc.narg(release_id)::text)
  and (sqlc.narg(request_id)::text is null or request_id = sqlc.narg(request_id)::text)
  and (sqlc.narg(command_id)::text is null or command_id = sqlc.narg(command_id)::text)
  and (sqlc.narg(provider_id)::text is null or provider_id = sqlc.narg(provider_id)::text)
  and (sqlc.narg(journey_id)::text is null or journey_id = sqlc.narg(journey_id)::text)
  and (sqlc.narg(trace_id)::text is null or trace_id = sqlc.narg(trace_id)::text)
  and (sqlc.narg(span_id)::text is null or (sqlc.narg(trace_id)::text is not null and trace_id = sqlc.narg(trace_id)::text and span_id = sqlc.narg(span_id)::text))
  and (sqlc.narg(from_time)::timestamptz is null or started_at >= sqlc.narg(from_time)::timestamptz)
  and (sqlc.narg(to_time)::timestamptz is null or started_at < sqlc.narg(to_time)::timestamptz);

-- name: CountDiagnosticIssuesFiltered :one
select count(*)::bigint as issue_count,
       count(*) filter (where i.state = 'open')::bigint as open_issue_count
from diagnostic_issues i
left join diagnostic_operations op
  on op.tenant_id = i.tenant_id and op.diagnostic_id = i.diagnostic_id and op.id = i.operation_id
where i.tenant_id = sqlc.arg(tenant_id)
  and i.diagnostic_id = sqlc.arg(diagnostic_id)
  and (sqlc.narg(participant_id)::uuid is null or op.participant_id = sqlc.narg(participant_id)::uuid)
  and (sqlc.narg(issue_state)::text is null or i.state = sqlc.narg(issue_state)::text)
  and (sqlc.narg(operation_kind)::text is null and sqlc.narg(source)::text is null and sqlc.narg(release_id)::text is null and sqlc.narg(request_id)::text is null and sqlc.narg(command_id)::text is null and sqlc.narg(provider_id)::text is null and sqlc.narg(journey_id)::text is null and sqlc.narg(trace_id)::text is null and sqlc.narg(span_id)::text is null and sqlc.narg(from_time)::timestamptz is null and sqlc.narg(to_time)::timestamptz is null or (
      (sqlc.narg(operation_kind)::text is null or op.kind = sqlc.narg(operation_kind)::text)
      and (sqlc.narg(source)::text is null or op.source = sqlc.narg(source)::text)
      and (sqlc.narg(release_id)::text is null or op.release_id = sqlc.narg(release_id)::text)
      and (sqlc.narg(request_id)::text is null or op.request_id = sqlc.narg(request_id)::text)
      and (sqlc.narg(command_id)::text is null or op.command_id = sqlc.narg(command_id)::text)
      and (sqlc.narg(provider_id)::text is null or op.provider_id = sqlc.narg(provider_id)::text)
      and (sqlc.narg(journey_id)::text is null or op.journey_id = sqlc.narg(journey_id)::text)
      and (sqlc.narg(trace_id)::text is null or op.trace_id = sqlc.narg(trace_id)::text)
      and (sqlc.narg(span_id)::text is null or (sqlc.narg(trace_id)::text is not null and op.trace_id = sqlc.narg(trace_id)::text and op.span_id = sqlc.narg(span_id)::text))
      and (sqlc.narg(from_time)::timestamptz is null or op.started_at >= sqlc.narg(from_time)::timestamptz)
      and (sqlc.narg(to_time)::timestamptz is null or op.started_at < sqlc.narg(to_time)::timestamptz)
  ));

-- name: ListDiagnosticCheckpoints :many
select *
from diagnostic_checkpoints
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and operation_id = sqlc.arg(operation_id)
order by display_order asc, checkpoint_key asc;

-- name: CountDiagnosticBranchesFiltered :one
select count(*)::bigint as branch_count
from diagnostic_branches b
where b.tenant_id = sqlc.arg(tenant_id)
  and b.diagnostic_id = sqlc.arg(diagnostic_id)
  and exists (
      select 1 from diagnostic_operations op
      where op.tenant_id = b.tenant_id and op.diagnostic_id = b.diagnostic_id and op.branch_id = b.id
        and (sqlc.narg(operation_kind)::text is null or op.kind = sqlc.narg(operation_kind)::text)
        and (sqlc.narg(state)::text is null or op.state = sqlc.narg(state)::text)
        and (sqlc.narg(source)::text is null or op.source = sqlc.narg(source)::text)
        and (sqlc.narg(release_id)::text is null or op.release_id = sqlc.narg(release_id)::text)
        and (sqlc.narg(request_id)::text is null or op.request_id = sqlc.narg(request_id)::text)
        and (sqlc.narg(command_id)::text is null or op.command_id = sqlc.narg(command_id)::text)
        and (sqlc.narg(provider_id)::text is null or op.provider_id = sqlc.narg(provider_id)::text)
        and (sqlc.narg(journey_id)::text is null or op.journey_id = sqlc.narg(journey_id)::text)
        and (sqlc.narg(trace_id)::text is null or op.trace_id = sqlc.narg(trace_id)::text)
        and (sqlc.narg(span_id)::text is null or (sqlc.narg(trace_id)::text is not null and op.trace_id = sqlc.narg(trace_id)::text and op.span_id = sqlc.narg(span_id)::text))
        and (sqlc.narg(participant_id)::uuid is null or op.participant_id = sqlc.narg(participant_id)::uuid)
        and (sqlc.narg(from_time)::timestamptz is null or op.started_at >= sqlc.narg(from_time)::timestamptz)
        and (sqlc.narg(to_time)::timestamptz is null or op.started_at < sqlc.narg(to_time)::timestamptz)
  );

-- name: ListDiagnosticIssues :many
select *
from diagnostic_issues
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and (sqlc.narg(state)::text is null or state = sqlc.narg(state)::text)
order by first_observed_at asc, id asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: ListDiagnosticIssuesByOperationIDs :many
select *
from diagnostic_issues
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and operation_id = any(sqlc.arg(operation_ids)::uuid[])
order by first_observed_at asc, id asc;

-- name: ListDiagnosticIssuesAfter :many
select *
from diagnostic_issues
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and (sqlc.narg(state)::text is null or state = sqlc.narg(state)::text)
  and (
      sqlc.narg(after_observed_at)::timestamptz is null
      or first_observed_at > sqlc.narg(after_observed_at)::timestamptz
      or (first_observed_at = sqlc.narg(after_observed_at)::timestamptz and id > sqlc.narg(after_issue_id)::uuid)
  )
order by first_observed_at asc, id asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: ListDiagnosticBranches :many
select *
from diagnostic_branches
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
order by created_at asc, id asc
limit least(sqlc.arg(page_limit)::int, 1000);

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

-- name: LookupDiagnosticReferenceRaw :many
select r.*, d.environment, d.state
from diagnostic_references r
join episode_diagnostics d
  on d.tenant_id = r.tenant_id and d.id = r.diagnostic_id
where r.tenant_id = sqlc.arg(tenant_id)
  and r.id_class = sqlc.arg(id_class)
  and r.raw_value = sqlc.arg(raw_value)
order by r.created_at desc
limit least(sqlc.arg(page_limit)::int, 100);

-- name: LookupDiagnosticReferenceRawGlobal :many
select r.*, d.environment, d.state
from diagnostic_references r
join episode_diagnostics d
  on d.tenant_id = r.tenant_id and d.id = r.diagnostic_id
where r.id_class = sqlc.arg(id_class)
  and r.raw_value = sqlc.arg(raw_value)
order by r.created_at desc, r.tenant_id asc, r.diagnostic_id asc
limit least(sqlc.arg(page_limit)::int, 100);

-- name: LookupDiagnosticReferenceHMAC :many
select r.*, d.environment, d.state
from diagnostic_references r
join episode_diagnostics d
  on d.tenant_id = r.tenant_id and d.id = r.diagnostic_id
where r.tenant_id = sqlc.arg(tenant_id)
  and r.id_class = sqlc.arg(id_class)
  and r.hmac_version = sqlc.arg(hmac_version)
  and r.value_hmac = sqlc.arg(value_hmac)
order by r.created_at desc
limit least(sqlc.arg(page_limit)::int, 100);

-- name: LookupDiagnosticReferenceHMACGlobal :many
select r.*, d.environment, d.state
from diagnostic_references r
join episode_diagnostics d
  on d.tenant_id = r.tenant_id and d.id = r.diagnostic_id
where r.id_class = sqlc.arg(id_class)
  and r.hmac_version = sqlc.arg(hmac_version)
  and r.value_hmac = sqlc.arg(value_hmac)
order by r.created_at desc, r.tenant_id asc, r.diagnostic_id asc
limit least(sqlc.arg(page_limit)::int, 100);

-- name: UpsertDiagnosticReference :execrows
insert into diagnostic_references (
    tenant_id, diagnostic_id, reference_id, id_class, raw_value, hmac_version, value_hmac,
    copyable, unknown_reason, event_cursor, operation_id
) values (
    sqlc.arg(tenant_id), sqlc.arg(diagnostic_id), sqlc.arg(reference_id), sqlc.arg(id_class), sqlc.narg(raw_value),
    sqlc.narg(hmac_version), sqlc.narg(value_hmac), sqlc.arg(copyable), sqlc.narg(unknown_reason),
    sqlc.narg(event_cursor), sqlc.narg(operation_id)
)
on conflict do nothing;

-- Projector dead letters.

-- name: InsertProjectorDeadLetter :one
insert into diagnostic_projector_dead_letters (
    tenant_id, diagnostic_id, id, event_cursor, event_id, error_class, error_reason, attempt_count
) values (
    sqlc.arg(tenant_id), sqlc.arg(diagnostic_id), sqlc.arg(id), sqlc.arg(event_cursor), sqlc.narg(event_id),
    sqlc.arg(error_class), sqlc.arg(error_reason), sqlc.arg(attempt_count)
)
on conflict (tenant_id, diagnostic_id, event_cursor) where state = 'pending' do update set
    error_class = excluded.error_class,
    error_reason = excluded.error_reason,
    attempt_count = diagnostic_projector_dead_letters.attempt_count + 1,
    updated_at = now()
returning *;

-- name: ListProjectorDeadLetters :many
select *
from diagnostic_projector_dead_letters
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and state = 'pending'
order by created_at asc, id asc
limit least(sqlc.arg(page_limit)::int, 1000);

-- name: MarkProjectorDeadLetterReplayed :one
update diagnostic_projector_dead_letters
set state = 'replayed', replayed_at = now(), updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = sqlc.arg(id)
  and state = 'pending'
returning *;

-- Export quota, claims, completion, and cancellation.

-- name: CountActiveDiagnosticExportJobs :one
select count(*)::bigint as active_count
from diagnostic_export_jobs
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and state in ('queued', 'running');

-- name: CreateDiagnosticExportJob :one
insert into diagnostic_export_jobs (
    tenant_id, diagnostic_id, id, state, cursor_from, cursor_to, lease_ends_at,
    operator_subject_hash, journey_id, trace_id, span_id, total_events
)
select
    sqlc.arg(tenant_id), sqlc.arg(diagnostic_id), sqlc.arg(id), 'queued', sqlc.arg(cursor_from), sqlc.narg(cursor_to),
    sqlc.arg(lease_ends_at), sqlc.arg(operator_subject_hash), sqlc.narg(journey_id), sqlc.narg(trace_id), sqlc.narg(span_id), sqlc.narg(total_events)
from lateral (
    select
        pg_advisory_xact_lock(hashtextextended('operator:' || sqlc.arg(operator_subject_hash)::text, 0)),
        pg_advisory_xact_lock(hashtextextended(
            'diagnostic:' || (sqlc.arg(tenant_id)::uuid)::text || ':' || (sqlc.arg(diagnostic_id)::uuid)::text,
            0
        ))
) as quota_lock
where (
    select count(*)
    from diagnostic_export_jobs
    where tenant_id = sqlc.arg(tenant_id)
      and diagnostic_id = sqlc.arg(diagnostic_id)
      and state in ('queued', 'running')
) < 2
  and (
    select count(*)
    from diagnostic_export_jobs
    where operator_subject_hash = sqlc.arg(operator_subject_hash)
      and state in ('queued', 'running')
  ) < 2
returning *;

-- name: ClaimDiagnosticExportJobs :many
with candidates as (
    select tenant_id, diagnostic_id, id
    from diagnostic_export_jobs
    where state in ('queued', 'running')
      and (state = 'queued' or lease_ends_at <= now())
    order by created_at asc, id asc
    for update skip locked
    limit sqlc.arg(page_limit)::int
)
update diagnostic_export_jobs j
set state = 'running',
    lease_token = sqlc.arg(lease_token),
    lease_owner = sqlc.arg(lease_owner),
    lease_ends_at = now() + make_interval(secs => sqlc.arg(lease_seconds)::int),
    updated_at = now()
from candidates
where j.tenant_id = candidates.tenant_id
  and j.diagnostic_id = candidates.diagnostic_id
  and j.id = candidates.id
returning j.*;

-- name: DeleteDiagnosticExportArtifactChunks :execrows
delete from diagnostic_export_artifact_chunks
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and job_id = sqlc.arg(job_id);

-- name: InsertDiagnosticExportArtifactChunk :exec
insert into diagnostic_export_artifact_chunks (
    tenant_id, diagnostic_id, job_id, part_index, payload, checksum, byte_size
)
select
    sqlc.arg(tenant_id), sqlc.arg(diagnostic_id), sqlc.arg(job_id),
    sqlc.arg(part_index), sqlc.arg(payload), sqlc.arg(checksum), sqlc.arg(byte_size)
where exists (
    select 1
    from diagnostic_export_jobs
    where tenant_id = sqlc.arg(tenant_id)
      and diagnostic_id = sqlc.arg(diagnostic_id)
      and id = sqlc.arg(job_id)
      and state = 'running'
      and lease_token = sqlc.arg(lease_token)
)
on conflict (tenant_id, diagnostic_id, job_id, part_index) do update
set payload = excluded.payload,
    checksum = excluded.checksum,
    byte_size = excluded.byte_size;

-- name: ListDiagnosticExportArtifactChunks :many
select *
from diagnostic_export_artifact_chunks
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and job_id = sqlc.arg(job_id)
order by part_index asc;

-- name: GetDiagnosticExportJob :one
select *
from diagnostic_export_jobs
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = sqlc.arg(id);

-- name: GetDiagnosticExportJobForOperator :one
select *
from diagnostic_export_jobs
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = sqlc.arg(id)
  and operator_subject_hash = sqlc.arg(operator_subject_hash);

-- name: UpdateDiagnosticExportProgress :one
update diagnostic_export_jobs
set processed_events = sqlc.arg(processed_events),
    total_events = sqlc.narg(total_events),
    current_cursor = sqlc.narg(current_cursor),
    lease_ends_at = now() + make_interval(secs => sqlc.arg(lease_seconds)::int),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = sqlc.arg(id)
  and state = 'running'
  and lease_token = sqlc.arg(lease_token)
returning *;

-- name: CompleteDiagnosticExportJob :one
update diagnostic_export_jobs
set state = sqlc.arg(state),
    cursor_to = sqlc.arg(cursor_to),
    manifest = sqlc.arg(manifest),
    object_key = sqlc.narg(object_key),
    download_expires_at = sqlc.narg(download_expires_at),
    artifact_payload = sqlc.narg(artifact_payload),
    artifact_content_type = sqlc.narg(artifact_content_type),
    artifact_checksum = sqlc.narg(artifact_checksum),
    artifact_size = sqlc.narg(artifact_size),
    lease_token = null,
    lease_owner = null,
    completed_at = now(),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = sqlc.arg(id)
  and lease_token = sqlc.arg(lease_token)
  and state = 'running'
returning *;

-- name: FailDiagnosticExportJob :one
update diagnostic_export_jobs
set state = 'failed',
    error_reason = sqlc.arg(error_reason),
    lease_token = null,
    lease_owner = null,
    completed_at = now(),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = sqlc.arg(id)
  and lease_token = sqlc.arg(lease_token)
  and state = 'running'
returning *;

-- name: CancelDiagnosticExportJob :one
update diagnostic_export_jobs
set state = 'cancelled',
    lease_token = null,
    lease_owner = null,
    cancelled_at = now(),
    completed_at = now(),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = sqlc.arg(id)
  and state in ('queued', 'running')
  and (sqlc.narg(lease_token)::uuid is null or lease_token = sqlc.narg(lease_token)::uuid)
returning *;

-- name: CancelDiagnosticExportJobForOperator :one
update diagnostic_export_jobs
set state = 'cancelled',
    lease_token = null,
    lease_owner = null,
    cancelled_at = now(),
    completed_at = now(),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and diagnostic_id = sqlc.arg(diagnostic_id)
  and id = sqlc.arg(id)
  and operator_subject_hash = sqlc.arg(operator_subject_hash)
  and state in ('queued', 'running')
  and (sqlc.narg(lease_token)::uuid is null or lease_token = sqlc.narg(lease_token)::uuid)
returning *;

-- Retention claims and bounded deletes.

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

-- name: MarkDiagnosticExpired :one
update episode_diagnostics
set state = 'expired', updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and id = sqlc.arg(diagnostic_id)
  and state = 'complete'
  and expires_at is not null
  and expires_at <= sqlc.arg(now_at)
returning *;
