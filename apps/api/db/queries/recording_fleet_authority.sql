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
      and not (sqlc.arg(role)::text = 'capture' and recording_capture_colocated(recording_id, sqlc.arg(colocated_grace_seconds)::integer))
),
job_demand as (
    select
        count(*) filter (where state in ('pending', 'retryable_failure'))::integer as queued_jobs,
        count(*) filter (where state = 'leased' and lease_expires_at > clock_timestamp())::integer as leased_jobs,
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
      and not (kind = 'capture' and recording_capture_colocated(recording_id, sqlc.arg(colocated_grace_seconds)::integer))
),
preparation_demand as (
    select count(*)::integer as count, max(preparation.updated_at) as revision
    from recording_preparations preparation
    join spaces on spaces.tenant_id = preparation.tenant_id and spaces.id = preparation.space_id
    where sqlc.arg(role)::text = 'capture' and preparation.state = 'scheduled'
      and preparation.starts_at <= sqlc.arg(observed_at)::timestamptz + interval '5 minutes'
      and preparation.starts_at > sqlc.arg(observed_at)::timestamptz - interval '5 minutes'
      and spaces.archived_at is null and spaces.recording_policy <> 'disabled'
      and (coalesce(
        (select coalesce(episode.config_snapshot->'media_plane_binding'->>'provider', '') from episodes episode
         where episode.tenant_id = spaces.tenant_id and episode.space_id = spaces.id and episode.status = 'active' limit 1),
        nullif(btrim(spaces.media_plane), ''),
        (select tenants.default_media_plane from tenants where tenants.id = spaces.tenant_id), '') <> 'chalk_sfu'
        or (sqlc.arg(own_capture)::boolean and not (sqlc.arg(colocated_grace_seconds)::integer > 0 and exists (
            select 1 from recording_colocated_capture_workers colocated
            where recording_colocated_worker_healthy(colocated.sfu_node)))))
),
facts as (
    select
        case when sqlc.arg(role)::text = 'capture' then reservation_demand.scheduled_prewarms else 0 end::integer as scheduled_prewarms,
        case when sqlc.arg(role)::text = 'capture' then reservation_demand.held_starts else 0 end::integer as held_starts,
        job_demand.queued_jobs,
        job_demand.leased_jobs,
		greatest(reservation_demand.episode_count, job_demand.queued_jobs + job_demand.leased_jobs)::integer as slot_demand,
		greatest(
		    ((reservation_demand.participant_count + 39) / 40)::integer,
		    ((reservation_demand.input_bitrate_bps + 15999999) / 16000000)::integer
		)::integer as physical_node_floor,
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
    select facts.*, least(preparation_demand.count, greatest(0, coalesce(nullif(sqlc.arg(recording_cap)::integer, 0), 10) - base_nodes))::integer as prepared_nodes,
        greatest(facts.revised_at, preparation_demand.revision) as target_revision
    from facts cross join preparation_demand
)
select
    concat(sqlc.arg(role)::text, ':', coalesce(extract(epoch from target_revision)::bigint, 0), ':', scheduled_prewarms, ':', held_starts, ':', queued_jobs, ':', leased_jobs, ':', prepared_nodes)::text as revision,
    (base_nodes + prepared_nodes)::integer as desired_nodes,
    (scheduled_prewarms + prepared_nodes)::integer as scheduled_prewarms,
    held_starts,
    queued_jobs,
	(slot_demand + prepared_nodes)::integer as slot_demand,
	physical_node_floor,
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
  -- An issued identity must use close-admission, a later lease read, and revoke.
  and recording_fleet_nodes.state in ('requested', 'revoked')
returning provider_id;
