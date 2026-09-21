-- name: GetRecordingFleetDemand :one
with reservation_demand as (
    select
        count(*) filter (where starts_at is not null and starts_at > sqlc.arg(observed_at)::timestamptz)::integer as scheduled_prewarms,
        count(*) filter (where starts_at is null or starts_at <= sqlc.arg(observed_at)::timestamptz)::integer as held_starts,
        count(*)::integer as episode_count,
        coalesce(sum(participant_count), 0)::bigint as participant_count,
        coalesce(sum(input_bitrate_bps), 0)::bigint as input_bitrate_bps,
        max(updated_at) as reservation_revision
    from recording_reservations
    where state = 'reserved'
      and ends_at > sqlc.arg(observed_at)::timestamptz
      and coalesce(starts_at, created_at) <= sqlc.arg(observed_at)::timestamptz + interval '5 minutes'
),
job_demand as (
    select
        count(*) filter (where state in ('pending', 'retryable_failure'))::integer as queued_jobs,
        count(*) filter (where state = 'leased' and lease_expires_at > sqlc.arg(observed_at)::timestamptz)::integer as leased_jobs,
        max(updated_at) as job_revision
    from recording_jobs
    where (
        kind = sqlc.arg(role)
        or (sqlc.arg(role)::text = 'render' and kind = 'transcription')
    )
      and state in ('pending', 'retryable_failure', 'leased')
      and (
          sqlc.arg(role)::text <> 'capture'
          or state = 'leased'
          or available_at <= sqlc.arg(observed_at)::timestamptz
      )
),
preparation_demand as (
    select count(*)::integer as count, max(preparation.updated_at) as revision
    from recording_preparations preparation
    join spaces on spaces.tenant_id = preparation.tenant_id and spaces.id = preparation.space_id
    where sqlc.arg(role)::text = 'capture' and preparation.state = 'scheduled'
      and preparation.starts_at <= sqlc.arg(observed_at)::timestamptz + interval '5 minutes'
      and preparation.starts_at > sqlc.arg(observed_at)::timestamptz - interval '5 minutes'
      and spaces.archived_at is null and spaces.recording_policy <> 'disabled'
),
facts as (
    select
        case when sqlc.arg(role)::text = 'capture' then reservation_demand.scheduled_prewarms else 0 end::integer as scheduled_prewarms,
        case when sqlc.arg(role)::text = 'capture' then reservation_demand.held_starts else 0 end::integer as held_starts,
        job_demand.queued_jobs,
        job_demand.leased_jobs,
        case
            when sqlc.arg(role)::text = 'capture' then greatest(
                reservation_demand.episode_count,
                ((reservation_demand.participant_count + 39) / 40)::integer,
                ((reservation_demand.input_bitrate_bps + 15999999) / 16000000)::integer,
                job_demand.queued_jobs + job_demand.leased_jobs
            )
            else job_demand.queued_jobs + job_demand.leased_jobs
        end::integer as base_nodes,
        greatest(reservation_demand.reservation_revision, job_demand.job_revision) as revised_at
    from reservation_demand, job_demand
), target as (
    select facts.*, least(preparation_demand.count, greatest(0, 10 - base_nodes))::integer as prepared_nodes,
        greatest(facts.revised_at, preparation_demand.revision) as target_revision
    from facts cross join preparation_demand
)
select
    concat(sqlc.arg(role)::text, ':', coalesce(extract(epoch from target_revision)::bigint, 0), ':', scheduled_prewarms, ':', held_starts, ':', queued_jobs, ':', leased_jobs, ':', prepared_nodes)::text as revision,
    (base_nodes + prepared_nodes)::integer as desired_nodes,
    (scheduled_prewarms + prepared_nodes)::integer as scheduled_prewarms,
    held_starts,
    queued_jobs,
    sqlc.arg(observed_at)::timestamptz as observed_at
from target;

-- name: ReserveRecordingFleetBootstrap :one
insert into recording_fleet_nodes (
    environment, role, provider_id, node_name, region, release_id,
    image_digest, boot_generation, inventory_digest, state
) values (
    sqlc.arg(environment), sqlc.arg(role), sqlc.arg(provider_id), sqlc.arg(node_name),
    sqlc.arg(region), sqlc.arg(release_id), sqlc.arg(image_digest),
    sqlc.arg(boot_generation), sqlc.arg(inventory_digest), 'requested'
)
on conflict (environment, role, provider_id) do update
set updated_at = recording_fleet_nodes.updated_at
where recording_fleet_nodes.node_name = excluded.node_name
  and recording_fleet_nodes.region = excluded.region
  and recording_fleet_nodes.release_id = excluded.release_id
  and recording_fleet_nodes.image_digest = excluded.image_digest
  and recording_fleet_nodes.boot_generation = excluded.boot_generation
  and recording_fleet_nodes.inventory_digest = excluded.inventory_digest
  and recording_fleet_nodes.state <> 'revoked'
returning *;

-- name: ActivateRecordingFleetBootstrap :one
update recording_fleet_nodes
set worker_id = sqlc.arg(worker_id), state = 'active', updated_at = now()
where environment = sqlc.arg(environment)
  and role = sqlc.arg(role)
  and provider_id = sqlc.arg(provider_id)
  and node_name = sqlc.arg(node_name)
  and region = sqlc.arg(region)
  and release_id = sqlc.arg(release_id)
  and image_digest = sqlc.arg(image_digest)
  and boot_generation = sqlc.arg(boot_generation)
  and inventory_digest = sqlc.arg(inventory_digest)
  and (state = 'requested' or (state = 'active' and worker_id = sqlc.arg(worker_id)))
returning *;

-- name: AbandonRecordingFleetBootstrap :one
insert into recording_fleet_nodes (
    environment, role, provider_id, node_name, region, release_id,
    image_digest, boot_generation, inventory_digest, state, revoked_at
) values (
    sqlc.arg(environment), sqlc.arg(role), sqlc.arg(provider_id), sqlc.arg(node_name),
    sqlc.arg(region), sqlc.arg(release_id), sqlc.arg(image_digest),
    sqlc.arg(boot_generation), sqlc.arg(inventory_digest), 'revoked', sqlc.arg(revoked_at)
)
on conflict (environment, role, provider_id) do update
set state = 'revoked', ready = false, admission_open = false,
    ready_capacity = 0,
    revoked_at = coalesce(recording_fleet_nodes.revoked_at, excluded.revoked_at),
    updated_at = now()
where recording_fleet_nodes.node_name = excluded.node_name
  and recording_fleet_nodes.region = excluded.region
  and recording_fleet_nodes.release_id = excluded.release_id
  and recording_fleet_nodes.image_digest = excluded.image_digest
  and recording_fleet_nodes.boot_generation = excluded.boot_generation
  and recording_fleet_nodes.inventory_digest = excluded.inventory_digest
  and recording_fleet_nodes.state in ('requested', 'active', 'draining', 'revoked')
returning provider_id;

-- name: ListRecordingFleetNodeObservations :many
select
    node.provider_id,
    node.worker_id,
    node.role,
    node.boot_generation,
    node.ready,
    node.admission_open,
    node.ready_capacity,
    coalesce((
        select count(*)
        from recording_jobs job
        where job.kind = node.role
          and job.state = 'leased'
          and job.lease_owner = node.worker_id::text
          and job.lease_expires_at > sqlc.arg(observed_at)::timestamptz
    ), 0)::integer as active_leases,
    node.observed_at
from recording_fleet_nodes node
where node.environment = sqlc.arg(environment)
  and node.role = sqlc.arg(role)
  and node.state in ('active', 'draining')
  and node.observed_at is not null
order by node.provider_id;

-- name: CloseRecordingFleetNodeAdmission :one
update recording_fleet_nodes
set state = 'draining', ready = false, admission_open = false,
    ready_capacity = 0, updated_at = now()
where environment = sqlc.arg(environment)
  and role = sqlc.arg(role)
  and provider_id = sqlc.arg(provider_id)
  and worker_id = sqlc.arg(worker_id)
  and boot_generation = sqlc.arg(boot_generation)
  and state in ('active', 'draining')
returning provider_id;

-- name: RevokeRecordingFleetNode :one
update recording_fleet_nodes
set state = 'revoked', ready = false, admission_open = false,
    ready_capacity = 0, revoked_at = coalesce(revoked_at, sqlc.arg(revoked_at)),
    updated_at = now()
where environment = sqlc.arg(environment)
  and role = sqlc.arg(role)
  and provider_id = sqlc.arg(provider_id)
  and worker_id = sqlc.arg(worker_id)
  and boot_generation = sqlc.arg(boot_generation)
  and state in ('active', 'draining', 'revoked')
returning provider_id;

-- name: RecordRecordingFleetWorkerObservation :one
update recording_fleet_nodes
set ready = case when state = 'active' then sqlc.arg(ready) else false end,
    admission_open = case when state = 'active' then sqlc.arg(admission_open) else false end,
    ready_capacity = case when state = 'active' then sqlc.arg(ready_capacity) else 0 end,
    -- The database receipt time is authoritative for claim liveness. Worker
    -- wall-clock skew must not make a fresh report look stale or future-dated.
    observed_at = clock_timestamp(), updated_at = now()
where environment = sqlc.arg(environment)
  and role = sqlc.arg(role)
  and worker_id = sqlc.arg(worker_id)
  and state in ('active', 'draining')
returning provider_id, worker_id, role, boot_generation, ready, admission_open,
    ready_capacity, observed_at;

-- name: AuthorizeRecordingFleetWorker :one
select exists (
    select 1 from recording_fleet_nodes
    where environment = sqlc.arg(environment)
      and role = sqlc.arg(role)
      and worker_id = sqlc.arg(worker_id)
      and state in ('active', 'draining')
) as authorized;

-- name: AuthorizeRecordingFleetWorkerClaim :one
select exists (
    select 1 from recording_fleet_nodes
    where environment = sqlc.arg(environment)
      and role = sqlc.arg(role)
      and worker_id = sqlc.arg(worker_id)
      and state = 'active'
      and ready
      and admission_open
      and ready_capacity > 0
      and observed_at > clock_timestamp() - interval '2 minutes'
      and observed_at <= clock_timestamp()
) as authorized;

-- name: PublishRecordingFleetPool :one
insert into recording_pool_health (
    role, admission_open, ready_capacity, reason, observed_at, demand_revision
) values (
    sqlc.arg(role), sqlc.arg(admission_open), sqlc.arg(ready_capacity),
    sqlc.arg(reason), sqlc.arg(observed_at), sqlc.arg(demand_revision)
)
on conflict (role) do update set
    admission_open = excluded.admission_open,
    ready_capacity = excluded.ready_capacity,
    reason = excluded.reason,
    observed_at = excluded.observed_at,
    demand_revision = excluded.demand_revision,
    updated_at = now()
where recording_pool_health.observed_at <= excluded.observed_at
returning role;
