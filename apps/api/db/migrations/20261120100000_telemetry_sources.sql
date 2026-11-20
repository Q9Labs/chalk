-- +goose Up
-- The telemetry ledger (docs/telemetry-delivery.md): which seqs of each SDK source the server has
-- stored, rejected or been told were dropped. One row per source and participant, so a batch signed
-- for one participant can never mark another participant's seqs as stored. The ranges are
-- half-open and capped in size by the API. A new table: the previous release never reads or writes it.
create table telemetry_sources (
    tenant_id uuid not null,
    source_id uuid not null,
    participant_id uuid not null,
    episode_id uuid not null,
    -- {"stored": [{"from": 0, "to": 5}], "rejected": [...], "dropped": {"queue_full": [...]}}
    ranges jsonb not null default '{"stored": [], "rejected": [], "dropped": {}}',
    reported_next_seq bigint not null default 0 check (reported_next_seq >= 0),
    end_state text check (end_state in ('closed', 'abandoned')),
    end_next_seq bigint check (end_next_seq >= 0),
    first_received_at timestamptz not null,
    last_received_at timestamptz not null,
    primary key (tenant_id, source_id, participant_id),
    check ((end_state is null) = (end_next_seq is null))
);
create index telemetry_sources_episode_idx on telemetry_sources (tenant_id, episode_id);

-- +goose Down
drop table telemetry_sources;
