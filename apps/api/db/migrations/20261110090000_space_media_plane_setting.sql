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
-- value. An operator approves a default by writing the value it approved beside it. The default
-- counts as approved only while it equals that value, so a write from the previous release, which
-- knows nothing of approvals, leaves it unapproved. Existing rows are unapproved: a legacy chalk_sfu
-- never selects the own SFU until an operator writes it again, and an unknown value is ignored.
alter table tenants
    add column default_media_plane_approved_value text,
    add column default_media_plane_approved boolean not null generated always as (
        coalesce(default_media_plane = default_media_plane_approved_value, false)
    ) stored;

-- +goose Down
alter table tenants drop column default_media_plane_approved;
alter table tenants drop column default_media_plane_approved_value;
alter table spaces drop column media_plane_setting;
alter table spaces drop constraint spaces_media_plane_setting_witness;
alter table spaces drop column media_plane_setting_against;
alter table spaces drop column media_plane_setting_written;
