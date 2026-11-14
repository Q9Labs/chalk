-- +goose Up
-- When each Space was last active: when it was created, or when an Episode in it was created, started or ended,
-- whichever is latest. A list of Spaces by activity reads this table in index order, so the most recently used
-- Spaces come first without reading every Space a Tenant holds. Triggers keep it, so every writer of Spaces and
-- Episodes (the API and Sync) keeps it current. The previous release ignores this table, so it stays runnable.
create table space_activity (
    tenant_id uuid not null,
    space_id uuid not null,
    active_at timestamptz not null,
    primary key (tenant_id, space_id),
    foreign key (tenant_id, space_id) references spaces(tenant_id, id) on delete cascade
);
create index space_activity_tenant_active_at_idx on space_activity(tenant_id, active_at desc, space_id desc);

-- +goose StatementBegin
create function record_space_created()
returns trigger
language plpgsql
as $$
begin
    insert into space_activity (tenant_id, space_id, active_at)
    values (new.tenant_id, new.id, new.created_at)
    on conflict (tenant_id, space_id) do nothing;
    return null;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function record_episode_activity()
returns trigger
language plpgsql
as $$
begin
    insert into space_activity (tenant_id, space_id, active_at)
    values (new.tenant_id, new.space_id, coalesce(new.ended_at, new.started_at, new.created_at))
    on conflict (tenant_id, space_id) do update set active_at = greatest(space_activity.active_at, excluded.active_at);
    return null;
end;
$$;
-- +goose StatementEnd

create trigger spaces_record_activity
after insert on spaces
for each row execute function record_space_created();

create trigger episodes_record_activity
after insert or update of started_at, ended_at on episodes
for each row execute function record_episode_activity();

-- Writes from the running release wait for the backfill, so no Space or Episode is written between the backfill's
-- read and the triggers taking effect.
lock table spaces, episodes in share mode;

insert into space_activity (tenant_id, space_id, active_at)
select s.tenant_id, s.id, greatest(s.created_at, max(coalesce(e.ended_at, e.started_at, e.created_at)))
from spaces s
left join episodes e on e.tenant_id = s.tenant_id and e.space_id = s.id
group by s.tenant_id, s.id, s.created_at
on conflict (tenant_id, space_id) do update set active_at = greatest(space_activity.active_at, excluded.active_at);

-- +goose Down
drop trigger episodes_record_activity on episodes;
drop trigger spaces_record_activity on spaces;
drop function record_episode_activity();
drop function record_space_created();
drop table space_activity;
