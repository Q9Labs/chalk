-- name: ReserveParticipantRemoval :one
update sync_episode_control
set
    lifecycle_intent_count = lifecycle_intent_count + 1,
    lifecycle_intent_bytes = lifecycle_intent_bytes + sqlc.arg(intent_payload_bytes),
    lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
    lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - sqlc.arg(reservation_bytes),
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and lifecycle_reserved_intents >= 1
    and lifecycle_reserved_intent_bytes >= sqlc.arg(reservation_bytes)
    and lifecycle_intent_count + lifecycle_reserved_intents <= 2048
    and lifecycle_intent_bytes + lifecycle_reserved_intent_bytes + sqlc.arg(intent_payload_bytes) - sqlc.arg(reservation_bytes) <= 33554432
returning *;

-- name: ReserveEpisodeEnd :one
update sync_episode_control
set
    lifecycle_intent_count = lifecycle_intent_count + 1,
    lifecycle_intent_bytes = lifecycle_intent_bytes + sqlc.arg(intent_payload_bytes),
    lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
    lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - sqlc.arg(reservation_bytes),
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and lifecycle_reserved_intents >= 1
    and lifecycle_reserved_intent_bytes >= sqlc.arg(reservation_bytes)
    and lifecycle_intent_count + lifecycle_reserved_intents <= 2048
    and lifecycle_intent_bytes + lifecycle_reserved_intent_bytes + sqlc.arg(intent_payload_bytes) - sqlc.arg(reservation_bytes) <= 33554432
returning *;

-- name: CreateLifecycleParticipant :one
insert into participants (
    id,
    name,
    metadata,
    capabilities,
    role,
    tenant_id,
    space_id,
    episode_id,
    identity_id,
    generation,
    status
) values (
    sqlc.arg(id),
    sqlc.narg(name),
    sqlc.narg(metadata),
    sqlc.arg(capabilities),
    sqlc.arg(role),
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    sqlc.narg(identity_id),
    1,
    'joining'
)
returning *;

-- name: CreateLifecycleIntent :one
insert into sync_lifecycle_intents (
    tenant_id,
    space_id,
    episode_id,
    lifecycle_intent_id,
    request_key,
    request_fingerprint,
    intent_name,
    participant_id,
    participant_generation,
    payload,
    status,
    journey_id,
    parent_journey_event_id,
    producing_trace_id,
    producing_span_id
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    sqlc.arg(lifecycle_intent_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(intent_name),
    sqlc.narg(participant_id),
    sqlc.narg(participant_generation),
    sqlc.arg(payload),
    'pending',
    sqlc.narg(journey_id),
    sqlc.narg(parent_journey_event_id),
    sqlc.narg(producing_trace_id),
    sqlc.narg(producing_span_id)
)
returning *;

-- name: CreateDeferredLifecycleIntent :one
insert into sync_lifecycle_intents (
    tenant_id,
    space_id,
    episode_id,
    lifecycle_intent_id,
    request_key,
    request_fingerprint,
    intent_name,
    participant_id,
    participant_generation,
    payload,
    status,
    next_attempt_at,
    journey_id,
    parent_journey_event_id,
    producing_trace_id,
    producing_span_id
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    sqlc.arg(lifecycle_intent_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(intent_name),
    sqlc.arg(participant_id),
    sqlc.arg(participant_generation),
    sqlc.arg(payload),
    'pending',
    'infinity'::timestamptz,
    sqlc.narg(journey_id),
    sqlc.narg(parent_journey_event_id),
    sqlc.narg(producing_trace_id),
    sqlc.narg(producing_span_id)
)
returning *;

-- name: MarkLifecycleParticipantLeaving :one
update participants
set
    status = 'leaving',
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and id = sqlc.arg(participant_id)
    and generation = sqlc.arg(participant_generation)
    and status = 'active'
returning *;

-- name: MarkLifecycleEpisodeEnding :one
update episodes
set
    status = 'ending',
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and id = sqlc.arg(episode_id)
    and status = 'active'
returning *;

-- name: ClaimEmptyEpisodeLingers :many
select episodes.tenant_id, episodes.space_id, episodes.id as episode_id
from episodes
join sync_episode_control control on control.tenant_id=episodes.tenant_id
    and control.space_id=episodes.space_id and control.episode_id=episodes.id
left join episode_presence_leases presence on presence.tenant_id=episodes.tenant_id
    and presence.space_id=episodes.space_id and presence.episode_id=episodes.id
cross join lateral (
    select max(p.left_at) as last_departure_at from participants p
    where p.tenant_id=episodes.tenant_id and p.space_id=episodes.space_id and p.episode_id=episodes.id
        and p.joined_at is not null
) departure
cross join lateral (
    select least(
        case when not exists (
            select 1 from participants p
            where p.tenant_id=episodes.tenant_id and p.space_id=episodes.space_id and p.episode_id=episodes.id
                and p.status in ('joining', 'active', 'leaving')
        ) then departure.last_departure_at end,
        case when sqlc.narg(presence_recover_after)::timestamptz is not null then greatest(
            sqlc.narg(presence_recover_after)::timestamptz,
            coalesce(presence.expires_at, episodes.created_at + interval '120 seconds')
        ) end
    ) as empty_since
) empty_window
cross join lateral (
    -- A failed end must not block the Episode: each retry is a new operation
    -- keyed "<base>-retry-<n>", backed off 1, 2, 4 ... 60 minutes.
    select count(*) filter (where o.status<>'failed') as live_attempts,
        (count(*) filter (where o.status='failed'))::integer as failed_attempts,
        max(o.completed_at) filter (where o.status='failed') as last_failed_at
    from sync_external_operations o
    where o.tenant_id=episodes.tenant_id and o.space_id=episodes.space_id and o.episode_id=episodes.id
        and o.operation_name='tenant_end_episode'
        and (o.request_key='empty-episode-linger-' || ((extract(epoch from empty_window.empty_since) * 1000000)::bigint)::text
            or o.request_key like 'empty-episode-linger-' || ((extract(epoch from empty_window.empty_since) * 1000000)::bigint)::text || '-retry-%')
) linger
where episodes.status='active' and empty_window.empty_since is not null
    and linger.live_attempts = 0
    and (linger.failed_attempts = 0 or linger.last_failed_at
        + make_interval(mins => least(power(2, least(linger.failed_attempts - 1, 6))::integer, 60)) <= clock_timestamp())
    and empty_window.empty_since + make_interval(secs => coalesce((episodes.config_snapshot->>'linger_window_seconds')::integer, 0)) <= clock_timestamp()
    and episodes.id <> all(sqlc.arg(excluded_episode_ids)::uuid[])
order by episodes.id
for update of control skip locked
limit sqlc.arg(batch_size);

-- name: EpisodeLingerStillDue :one
-- Recheck both empty signals after the Episode lock. Heartbeat renewal and
-- admission use that same lock, so an earlier reconnect cancels the old window.
select empty_window.empty_since::timestamptz as empty_since, coalesce(
    episodes.status='active'
    and linger.live_attempts = 0
    and (linger.failed_attempts = 0 or linger.last_failed_at
        + make_interval(mins => least(power(2, least(linger.failed_attempts - 1, 6))::integer, 60)) <= clock_timestamp())
    and empty_window.empty_since + make_interval(secs => coalesce((episodes.config_snapshot->>'linger_window_seconds')::integer, 0)) <= clock_timestamp(), false
)::boolean as due, linger.failed_attempts
from episodes
left join episode_presence_leases presence on presence.tenant_id=episodes.tenant_id
    and presence.space_id=episodes.space_id and presence.episode_id=episodes.id
cross join lateral (
    select max(p.left_at) as last_departure_at from participants p
    where p.tenant_id=episodes.tenant_id and p.space_id=episodes.space_id and p.episode_id=episodes.id
        and p.joined_at is not null
) departure
cross join lateral (
    select least(
        case when not exists (
            select 1 from participants p
            where p.tenant_id=episodes.tenant_id and p.space_id=episodes.space_id and p.episode_id=episodes.id
                and p.status in ('joining', 'active', 'leaving')
        ) then departure.last_departure_at end,
        case when sqlc.narg(presence_recover_after)::timestamptz is not null then greatest(
            sqlc.narg(presence_recover_after)::timestamptz,
            coalesce(presence.expires_at, episodes.created_at + interval '120 seconds')
        ) end
    ) as empty_since
) empty_window
cross join lateral (
    -- A failed end must not block the Episode: each retry is a new operation
    -- keyed "<base>-retry-<n>", backed off 1, 2, 4 ... 60 minutes.
    select count(*) filter (where o.status<>'failed') as live_attempts,
        (count(*) filter (where o.status='failed'))::integer as failed_attempts,
        max(o.completed_at) filter (where o.status='failed') as last_failed_at
    from sync_external_operations o
    where o.tenant_id=episodes.tenant_id and o.space_id=episodes.space_id and o.episode_id=episodes.id
        and o.operation_name='tenant_end_episode'
        and (o.request_key='empty-episode-linger-' || ((extract(epoch from empty_window.empty_since) * 1000000)::bigint)::text
            or o.request_key like 'empty-episode-linger-' || ((extract(epoch from empty_window.empty_since) * 1000000)::bigint)::text || '-retry-%')
) linger
where episodes.tenant_id=sqlc.arg(tenant_id) and episodes.space_id=sqlc.arg(space_id) and episodes.id=sqlc.arg(episode_id);
