-- +goose Up
-- One durable record of every change to where new Episodes go: a Space's own plane, a Tenant's
-- default plane, and the Chalk SFU kill switch. The triggers below write it, so every writer is
-- covered in the same transaction as the change: the operator command, the public API, and the
-- previous release, which writes the legacy columns and knows nothing of this table.
--
-- old_plane and new_plane share one vocabulary for all three scopes: cf_sfu, chalk_sfu, or inherit
-- (no choice of its own). The kill switch is cf_sfu while it holds every new Episode on Cloudflare
-- and inherit while the settings decide. A Space's plane is its setting, or chalk_sfu while only the
-- legacy column stores it (see spaces.SelectPlane). A Tenant's plane is its approved default.
--
-- The writer says who and why through transaction-local settings (chalk.plane_actor,
-- chalk.plane_reason, chalk.plane_trace_id). A writer that says nothing is recorded as
-- 'unattributed', so a change is never lost for want of a name. The API's relay emits each row once
-- as the media_plane.changed event and stamps emitted_at.
create table media_plane_changes (
    id bigint generated always as identity primary key,
    changed_at timestamptz not null default now(),
    scope text not null check (scope in ('space', 'tenant', 'kill_switch')),
    tenant_id uuid,
    space_id uuid,
    old_plane text not null check (btrim(old_plane) <> ''),
    new_plane text not null check (btrim(new_plane) <> ''),
    actor text not null check (btrim(actor) <> '' and char_length(actor) <= 200),
    reason text not null check (btrim(reason) <> '' and char_length(reason) <= 500),
    trace_id text check (trace_id ~ '^[0-9a-f]{32}$'),
    emitted_at timestamptz,
    constraint media_plane_changes_scope_keys check (
        (scope = 'space' and tenant_id is not null and space_id is not null)
        or (scope = 'tenant' and tenant_id is not null and space_id is null)
        or (scope = 'kill_switch' and tenant_id is null and space_id is null)
    )
);

create index media_plane_changes_unemitted_idx on media_plane_changes (id) where emitted_at is null;
create index media_plane_changes_scope_idx on media_plane_changes (tenant_id, space_id, id desc);

-- The kill switch history moves over as emitted, so the relay does not announce old flips again. The
-- old table stays for the previous release and is dropped by a later release.
insert into media_plane_changes (changed_at, scope, old_plane, new_plane, actor, reason, emitted_at)
select changed_at, 'kill_switch',
       case when paused_before then 'cf_sfu' else 'inherit' end,
       case when paused_after then 'cf_sfu' else 'inherit' end,
       left(coalesce(nullif(btrim(operator), ''), 'unattributed'), 200),
       left(coalesce(nullif(btrim(reason), ''), 'unattributed'), 500), now()
from media_plane_kill_switch_changes
order by id;

-- +goose StatementBegin
create function record_media_plane_change(change_scope text, change_tenant uuid, change_space uuid, old_value text, new_value text)
returns void
language plpgsql
as $$
declare
    actor_value text := nullif(btrim(coalesce(current_setting('chalk.plane_actor', true), '')), '');
    reason_value text := nullif(btrim(coalesce(current_setting('chalk.plane_reason', true), '')), '');
    trace_value text := coalesce(current_setting('chalk.plane_trace_id', true), '');
begin
    insert into media_plane_changes (scope, tenant_id, space_id, old_plane, new_plane, actor, reason, trace_id)
    values (change_scope, change_tenant, change_space, old_value, new_value,
            left(coalesce(actor_value, 'unattributed'), 200), left(coalesce(reason_value, 'unattributed'), 500),
            case when trace_value ~ '^[0-9a-f]{32}$' then trace_value end);
end;
$$;
-- +goose StatementEnd

-- A Space's plane as the resolver reads it first: its setting, else chalk_sfu while only the legacy
-- column stores that, else no choice of its own.
-- +goose StatementBegin
create function space_media_plane(setting text, stored text)
returns text
language sql
immutable
as $$
    select coalesce(setting, case when btrim(stored) = 'chalk_sfu' then 'chalk_sfu' end, 'inherit')
$$;
-- +goose StatementEnd

-- A Tenant's plane as the resolver reads it: cf_sfu, or chalk_sfu once an operator approved it.
-- +goose StatementBegin
create function tenant_media_plane(stored text, approved boolean)
returns text
language sql
immutable
as $$
    select case
        when btrim(stored) = 'cf_sfu' then 'cf_sfu'
        when btrim(stored) = 'chalk_sfu' and approved then 'chalk_sfu'
        else 'inherit'
    end
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function audit_space_media_plane()
returns trigger
language plpgsql
as $$
declare
    old_value text := 'inherit';
    new_value text := space_media_plane(new.media_plane_setting, new.media_plane);
begin
    if tg_op = 'UPDATE' then
        old_value := space_media_plane(old.media_plane_setting, old.media_plane);
    end if;
    if old_value <> new_value then
        perform record_media_plane_change('space', new.tenant_id, new.id, old_value, new_value);
    end if;
    return null;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function audit_tenant_media_plane()
returns trigger
language plpgsql
as $$
declare
    old_value text := 'inherit';
    new_value text := tenant_media_plane(new.default_media_plane, new.default_media_plane_approved);
begin
    if tg_op = 'UPDATE' then
        old_value := tenant_media_plane(old.default_media_plane, old.default_media_plane_approved);
    end if;
    if old_value <> new_value then
        perform record_media_plane_change('tenant', new.id, null, old_value, new_value);
    end if;
    return null;
end;
$$;
-- +goose StatementEnd

-- A flip that sets the value it already has is still recorded, so a repeated command leaves a trace.
-- +goose StatementBegin
create function audit_media_plane_kill_switch()
returns trigger
language plpgsql
as $$
begin
    perform record_media_plane_change('kill_switch', null, null,
        case when old.paused then 'cf_sfu' else 'inherit' end,
        case when new.paused then 'cf_sfu' else 'inherit' end);
    return null;
end;
$$;
-- +goose StatementEnd

-- The tenants approval trigger runs before the row is written, so these see the final values. The
-- WHEN clauses keep ordinary Space and Tenant updates from entering the function at all.
create trigger spaces_audit_media_plane_insert
    after insert on spaces
    for each row
    when (new.media_plane_setting is not null or btrim(new.media_plane) = 'chalk_sfu')
    execute function audit_space_media_plane();

create trigger spaces_audit_media_plane_update
    after update on spaces
    for each row
    when (old.media_plane_setting is distinct from new.media_plane_setting or old.media_plane is distinct from new.media_plane)
    execute function audit_space_media_plane();

create trigger tenants_audit_media_plane_insert
    after insert on tenants
    for each row
    when (new.default_media_plane is not null)
    execute function audit_tenant_media_plane();

create trigger tenants_audit_media_plane_update
    after update on tenants
    for each row
    when (old.default_media_plane is distinct from new.default_media_plane
          or old.default_media_plane_approved is distinct from new.default_media_plane_approved)
    execute function audit_tenant_media_plane();

create trigger media_plane_kill_switch_audit
    after update on media_plane_kill_switch
    for each row
    execute function audit_media_plane_kill_switch();

-- The release before this one moves a live Episode by rewriting its binding through a struct that does
-- not know selected_by, so the rewritten binding has lost it. The fence accepts that one difference
-- (selected_by dropped, never changed or added) so a rollback cannot strand an Episode born on this release.
-- +goose StatementBegin
create or replace function protect_immutable_episode_policy()
returns trigger
language plpgsql
as $$
declare
    old_binding jsonb := old.config_snapshot -> 'media_plane_binding';
    new_binding jsonb := new.config_snapshot -> 'media_plane_binding';
    placement constant text[] := array['node', 'node_incarnation', 'placement_reason', 'generation', 'previous_allocations'];
begin
    if new.config_snapshot is distinct from old.config_snapshot then
        if not coalesce(
            (new.config_snapshot - 'media_plane_binding') = (old.config_snapshot - 'media_plane_binding')
            and jsonb_typeof(old_binding) = 'object'
            and jsonb_typeof(new_binding) = 'object'
            and old_binding ->> 'provider' = 'chalk_sfu'
            and ((new_binding - placement) = (old_binding - placement)
                 or (new_binding - placement) = (old_binding - placement - 'selected_by'))
            and coalesce((new_binding ->> 'generation')::bigint, 0) = coalesce((old_binding ->> 'generation')::bigint, 0) + 1,
            false
        ) then
            raise exception 'Episode config_snapshot is immutable';
        end if;
    end if;

    if new.deadline_at is distinct from old.deadline_at
        then
        if new.deadline_generation <> old.deadline_generation + 1 then
            raise exception 'Episode deadline mutation must advance generation exactly once';
        end if;
    elsif new.deadline_generation is distinct from old.deadline_generation then
            raise exception 'Episode deadline generation cannot change without a deadline mutation';
    end if;

    return new;
end;
$$;
-- +goose StatementEnd

-- +goose Down
-- The changes recorded while this migration was applied go with the table. The kill switch history
-- from before it is still in media_plane_kill_switch_changes, which this migration leaves in place.
-- The relaxed fence stays: it only accepts a binding without selected_by, so the previous release runs on it.
drop trigger media_plane_kill_switch_audit on media_plane_kill_switch;
drop trigger tenants_audit_media_plane_update on tenants;
drop trigger tenants_audit_media_plane_insert on tenants;
drop trigger spaces_audit_media_plane_update on spaces;
drop trigger spaces_audit_media_plane_insert on spaces;
drop function audit_media_plane_kill_switch();
drop function audit_tenant_media_plane();
drop function audit_space_media_plane();
drop function tenant_media_plane(text, boolean);
drop function space_media_plane(text, text);
drop function record_media_plane_change(text, uuid, uuid, text, text);
drop table media_plane_changes;
