-- +goose Up
-- A moved Episode owes a retire to every own-SFU allocation it left: the node closes the old
-- sessions and refuses the old generation. The debt row is written in the same transaction as the
-- binding move, and a background worker keeps asking the node until it acknowledges, reports a new
-- boot, or leaves the configuration. Only new code reads or writes the table, so the previous
-- release keeps running on the upgraded schema.
create table sfu_retirement_debts (
    tenant_id uuid not null,
    episode_id uuid not null,
    node text not null check (char_length(node) between 1 and 64),
    incarnation text not null default '' check (char_length(incarnation) <= 128),
    generation bigint not null check (generation >= 1),
    attempts integer not null default 0 check (attempts >= 0),
    next_attempt_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, node, incarnation)
);

create index sfu_retirement_debts_due_idx on sfu_retirement_debts (next_attempt_at);

-- +goose Down
drop table sfu_retirement_debts;
