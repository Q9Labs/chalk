-- +goose Up
-- A capture worker may run beside one own-SFU node. Its registration lives in a table of its own,
-- never in recording_fleet_nodes: earlier releases read that table as the DigitalOcean fleet, so a
-- row there would stop their reconciler and, with a trusted certificate, let them hand the worker
-- captures of any node. Earlier releases never read this table, so rolling the API back leaves the
-- worker unauthorized there.
create table recording_colocated_capture_workers (
    environment text not null check (octet_length(environment) between 1 and 100),
    sfu_node text not null check (octet_length(sfu_node) between 1 and 100),
    worker_id uuid not null unique,
    state text not null default 'active' check (state in ('active', 'revoked')),
    ready boolean not null default false,
    admission_open boolean not null default false,
    ready_capacity integer not null default 0 check (ready_capacity >= 0),
    resources_latest jsonb,
    peak_rss_bytes bigint not null default 0 check (peak_rss_bytes >= 0),
    observed_at timestamptz,
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (environment, sfu_node),
    check (not admission_open or (state = 'active' and ready and ready_capacity > 0)),
    check ((state = 'revoked') = (revoked_at is not null)),
    check (state <> 'revoked' or (not ready and not admission_open and ready_capacity = 0))
);

-- A colocated worker counts as able to take a capture only while it reports ready and open and
-- its last report is recent. Readiness is reported every 10 seconds.
-- +goose StatementBegin
create function recording_colocated_worker_healthy(target_node text)
returns boolean language sql stable as $$
    select exists (
        select 1 from recording_colocated_capture_workers worker
        where worker.sfu_node = target_node and worker.state = 'active'
          and worker.ready and worker.admission_open and worker.ready_capacity > 0
          and worker.observed_at > clock_timestamp() - interval '35 seconds'
          and worker.observed_at <= clock_timestamp()
    );
$$;
-- +goose StatementEnd

-- True when an earlier attempt of the capture job ran on a colocated worker. That attempt ended in
-- a failure or a lapsed lease, so the next one goes to the fleet instead of back to the same worker.
-- The placement of every attempt is already recorded in recording_job_attempt_authorities.
-- +goose StatementBegin
create function recording_capture_colocated_attempted(target_job_id uuid)
returns boolean language sql stable as $$
    select exists (
        select 1 from recording_job_attempt_authorities authority
        join recording_colocated_capture_workers worker on worker.worker_id::text = authority.lease_owner
        where authority.job_id = target_job_id and authority.kind = 'capture'
    );
$$;
-- +goose StatementEnd

-- True while the Recording's capture is the colocated worker's: leased by one, or waiting no
-- longer than the grace for the healthy one beside the Episode's own-SFU node, for an attempt no
-- colocated worker has failed yet. After the grace, when that worker is not healthy, or once it
-- has failed an attempt, the fleet may claim the job and its demand counts again.
-- +goose StatementBegin
create function recording_capture_colocated(target_recording_id uuid, grace_seconds integer)
returns boolean language sql stable as $$
    select grace_seconds > 0 and exists (
        select 1 from recording_jobs job
        join episodes on episodes.id = job.episode_id
        where job.recording_id = target_recording_id and job.kind = 'capture'
          and (
              (job.state = 'leased' and exists (
                  select 1 from recording_colocated_capture_workers worker where worker.worker_id::text = job.lease_owner))
              or (job.state in ('pending', 'retryable_failure')
                  and job.available_at + grace_seconds * interval '1 second' > clock_timestamp()
                  and episodes.config_snapshot->'media_plane_binding'->>'provider' = 'chalk_sfu'
                  and not recording_capture_colocated_attempted(job.id)
                  and recording_colocated_worker_healthy(episodes.config_snapshot->'media_plane_binding'->>'node'))
          )
    );
$$;
-- +goose StatementEnd

-- +goose Down
drop function recording_capture_colocated(uuid, integer);
drop function recording_capture_colocated_attempted(uuid);
drop function recording_colocated_worker_healthy(text);
drop table recording_colocated_capture_workers;
