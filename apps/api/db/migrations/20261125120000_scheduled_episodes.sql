-- +goose Up
-- A Scheduled Episode is an expectation recorded in a Space: when a bounded run of activity is planned
-- and who is expected. It is distinct from an Episode and never starts, ends or admits anything.
-- The id is assigned by the caller and is immutable. A cancelled row is a tombstone that stays so a
-- late write cannot bring the booking back; a tombstone created for an id that was never written holds
-- no expectation (starts_at and the other expectation columns are null).
create table scheduled_episodes (
    tenant_id uuid not null,
    space_id uuid not null,
    id uuid not null,
    starts_at timestamptz,
    expected_ends_at timestamptz,
    expected_participants jsonb,
    metadata jsonb,
    cancelled_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, id),
    foreign key (tenant_id, space_id) references spaces(tenant_id, id) on delete restrict,
    check (
        (
            starts_at is null and expected_ends_at is null and expected_participants is null and metadata is null
            and cancelled_at is not null
        ) or (
            starts_at is not null and expected_ends_at is not null and expected_participants is not null
            and expected_ends_at > starts_at and expected_ends_at - starts_at <= interval '7 days'
            and jsonb_typeof(expected_participants) = 'array'
            and (metadata is null or jsonb_typeof(metadata) = 'object')
        )
    )
);
-- One Space's upcoming plans, in start order.
create index scheduled_episodes_space_upcoming_idx
    on scheduled_episodes (tenant_id, space_id, starts_at)
    where cancelled_at is null;
-- The lookahead across all Tenants: what starts inside a window.
create index scheduled_episodes_upcoming_idx
    on scheduled_episodes (starts_at, tenant_id, space_id, id)
    where cancelled_at is null;

-- +goose Down
drop table scheduled_episodes;
