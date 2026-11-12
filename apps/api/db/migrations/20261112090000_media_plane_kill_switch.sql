-- +goose Up
-- The own-SFU kill switch, stored like the Space and Tenant plane settings so a flip takes effect on
-- the next Episode without an API restart. paused = true sends every new Episode to Cloudflare;
-- Episodes already bound to the own SFU keep their binding. The previous release reads
-- CHALK_SFU_NEW_EPISODES and ignores this table, so it stays runnable.
create table media_plane_kill_switch (
    singleton boolean primary key default true check (singleton),
    paused boolean not null default false,
    updated_at timestamptz not null default now()
);
insert into media_plane_kill_switch (singleton, paused) values (true, false);

-- One row per flip, written in the same transaction as the flip.
create table media_plane_kill_switch_changes (
    id bigint generated always as identity primary key,
    changed_at timestamptz not null default now(),
    paused_before boolean not null,
    paused_after boolean not null,
    operator text not null check (btrim(operator) <> ''),
    reason text not null check (btrim(reason) <> '')
);

-- +goose Down
drop table media_plane_kill_switch_changes;
drop table media_plane_kill_switch;
