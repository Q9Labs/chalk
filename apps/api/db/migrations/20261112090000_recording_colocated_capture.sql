-- +goose Up
-- A capture worker may run beside one own-SFU node. Its row sits in recording_fleet_nodes so the
-- worker authorization and readiness paths stay one code path, but the fleet reconciler never
-- lists it (ListRecordingFleetNodeObservations filters on colocated_sfu_node is null).
alter table recording_fleet_nodes
    add column colocated_sfu_node text,
    add constraint recording_fleet_nodes_colocated_check check (
        colocated_sfu_node is null
        or (role = 'capture' and provider_id = 'sfu:' || colocated_sfu_node and octet_length(colocated_sfu_node) between 1 and 100)
    );

create unique index recording_fleet_nodes_colocated_idx
    on recording_fleet_nodes(environment, colocated_sfu_node)
    where colocated_sfu_node is not null;

-- A colocated worker counts as able to take a capture only while it reports ready and open and
-- its last report is recent. Readiness is reported every 10 seconds.
-- +goose StatementBegin
create function recording_colocated_worker_healthy(target_node text)
returns boolean language sql stable as $$
    select exists (
        select 1 from recording_fleet_nodes node
        where node.colocated_sfu_node = target_node
          and node.role = 'capture' and node.state = 'active'
          and node.ready and node.admission_open and node.ready_capacity > 0
          and node.observed_at > clock_timestamp() - interval '35 seconds'
          and node.observed_at <= clock_timestamp()
    );
$$;
-- +goose StatementEnd

-- True while the Recording's capture is the colocated worker's: leased by one, or waiting no
-- longer than the grace for the healthy one beside the Episode's own-SFU node. After the grace, or
-- when that worker is not healthy, the fleet may claim the job and its demand counts again.
-- +goose StatementBegin
create function recording_capture_colocated(target_recording_id uuid, grace_seconds integer)
returns boolean language sql stable as $$
    select grace_seconds > 0 and exists (
        select 1 from recording_jobs job
        join episodes on episodes.id = job.episode_id
        where job.recording_id = target_recording_id and job.kind = 'capture'
          and (
              (job.state = 'leased' and exists (
                  select 1 from recording_fleet_nodes node
                  where node.worker_id::text = job.lease_owner and node.colocated_sfu_node is not null))
              or (job.state in ('pending', 'retryable_failure')
                  and job.available_at + grace_seconds * interval '1 second' > clock_timestamp()
                  and episodes.config_snapshot->'media_plane_binding'->>'provider' = 'chalk_sfu'
                  and recording_colocated_worker_healthy(episodes.config_snapshot->'media_plane_binding'->>'node'))
          )
    );
$$;
-- +goose StatementEnd

-- +goose Down
drop function recording_capture_colocated(uuid, integer);
drop function recording_colocated_worker_healthy(text);
drop index recording_fleet_nodes_colocated_idx;
alter table recording_fleet_nodes drop constraint recording_fleet_nodes_colocated_check, drop column colocated_sfu_node;
