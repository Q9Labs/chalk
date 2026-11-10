-- +goose Up
-- Authority rule: a stored setting counts only while the legacy column it was written against still
-- holds the same value. The previous release never reads the setting and keeps writing the legacy
-- column, so a legacy write after the setting means the older release changed the choice and wins.

-- The Space's own choice of media plane. Null means inherit: the Tenant default, then the platform
-- default. media_plane_setting_written and media_plane_setting_against are what the operator and
-- Space writers store: the choice, and the media_plane value stored beside it. media_plane_setting,
-- which every reader uses, is the choice while media_plane still equals that value; once an older
-- release changed media_plane, it is that legacy value if it names a plane, else null (inherit).
alter table spaces
    add column media_plane_setting_written text
        check (media_plane_setting_written in ('cf_sfu', 'chalk_sfu')),
    add column media_plane_setting_against text,
    add constraint spaces_media_plane_setting_witness
        check ((media_plane_setting_written is null) = (media_plane_setting_against is null)),
    add column media_plane_setting text generated always as (
        case
            when media_plane_setting_written is null then null
            when media_plane_setting_against = btrim(media_plane) then media_plane_setting_written
            when btrim(media_plane) in ('cf_sfu', 'chalk_sfu') then btrim(media_plane)
            else null
        end
    ) stored;

-- Any tenant could write tenants.default_media_plane before operators owned it, with no check on the
-- value. default_media_plane_approved marks a default an operator wrote, and only the operator
-- command can set it: a trigger clears it whenever the default changes, and refuses any other
-- write of the flag, unless the transaction says it is the operator's
-- (set_config('chalk.operator_write', 'on', true)). No sequence of writes from the API or from the
-- previous release can create or restore an approval. Existing rows are unapproved: a legacy
-- chalk_sfu never selects the own SFU until an operator writes it again, and an unknown value is ignored.
alter table tenants
    add column default_media_plane_approved boolean not null default false;

-- +goose StatementBegin
create function guard_tenant_media_plane_approval()
returns trigger
language plpgsql
as $$
begin
    if coalesce(current_setting('chalk.operator_write', true), '') = 'on' then
        return new;
    end if;
    if tg_op = 'INSERT' or new.default_media_plane is distinct from old.default_media_plane then
        new.default_media_plane_approved := false;
    else
        new.default_media_plane_approved := old.default_media_plane_approved;
    end if;
    return new;
end;
$$;
-- +goose StatementEnd

create trigger tenants_guard_media_plane_approval
    before insert or update on tenants
    for each row execute function guard_tenant_media_plane_approval();

-- +goose Down
drop trigger tenants_guard_media_plane_approval on tenants;
drop function guard_tenant_media_plane_approval();
alter table tenants drop column default_media_plane_approved;
alter table spaces drop column media_plane_setting;
alter table spaces drop constraint spaces_media_plane_setting_witness;
alter table spaces drop column media_plane_setting_against;
alter table spaces drop column media_plane_setting_written;
