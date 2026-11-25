-- +goose Up
create table sfu_window_nodes (
    id text primary key check (id ~ '^window-sfu-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    application_id text not null,
    provider_firewall_id uuid not null,
    provider_id bigint unique check (provider_id > 0),
    control_address inet check (family(control_address) = 4 and masklen(control_address) = 32),
    phase text not null default 'starting' check (phase in ('starting', 'serving', 'draining', 'deleting', 'deleted')),
    empty_since timestamptz,
    empty_incarnation text,
    created_at timestamptz not null default clock_timestamp(),
    deleted_at timestamptz,
    check (phase = 'starting' or provider_id is not null),
    check (phase not in ('serving', 'draining') or control_address is not null),
    check ((phase = 'deleted') = (deleted_at is not null)),
    check ((empty_since is null) = (empty_incarnation is null)),
    check (empty_since is null or phase = 'draining')
);

create index sfu_window_nodes_live_idx on sfu_window_nodes(application_id, created_at) where deleted_at is null;

-- +goose StatementBegin
create function fence_sfu_window_binding() returns trigger
language plpgsql as $$
declare
    binding jsonb := new.config_snapshot -> 'media_plane_binding';
    target text := binding ->> 'node';
begin
    if new.status = 'ended' or target is null or target not like 'window-sfu-%' then
        return new;
    end if;

    if tg_op = 'UPDATE' and old.status in ('active', 'ending')
        and target = old.config_snapshot -> 'media_plane_binding' ->> 'node' then
        return new;
    end if;

    -- The row lock survives until the Episode commits. A concurrent drain
    -- either follows that commit or fences it out before it can bind.
    perform 1 from sfu_window_nodes where id = target and phase = 'serving' for share;
    if not found then
        raise check_violation using constraint = 'sfu_window_node_accepting',
            message = 'SFU window node is no longer accepting Episode bindings';
    end if;
    return new;
end;
$$;
-- +goose StatementEnd
create trigger episodes_sfu_window_binding
before insert or update of config_snapshot, status on episodes
for each row execute function fence_sfu_window_binding();

-- +goose Down
-- +goose StatementBegin
do $$
begin
    lock table episodes in share row exclusive mode;
    lock table sfu_window_nodes in access exclusive mode;
    if exists (select from sfu_window_nodes where deleted_at is null)
       or exists (select from episodes
                  where status in ('active', 'ending')
                    and config_snapshot -> 'media_plane_binding' ->> 'node' like 'window-sfu-%') then
        raise exception 'retire SFU window nodes and finish their Episodes before removing the journal';
    end if;
end;
$$;
-- +goose StatementEnd
drop trigger episodes_sfu_window_binding on episodes;
drop function fence_sfu_window_binding();
drop table sfu_window_nodes;
