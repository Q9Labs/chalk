package main

// Both tenant_class and space_class mirror the resolution in
// apps/api/internal/adapters/mediaplaneproviders (selectedProvider,
// resolveProviderConfig, ResolveBinding). Keep them in step with that package.
//
// tenant_class.config_source is how resolveProviderConfig reads
// tenants.media_plane_provider_config: empty is the deployment default,
// enabled=false disables media, and mode picks Chalk-managed or tenant-managed.
// A malformed document, unknown provider string or unknown mode is invalid.
//
// space_class.selected is the Space's own media_plane_setting (or a stored chalk_sfu that
// has no setting yet), else the Tenant default (an unknown value, or a chalk_sfu no operator
// approved, names no plane), else the stored media_plane, which holds
// the platform default for a Space that inherits.
// A chalk_sfu selection outside the allowlist is pinned to Cloudflare, and one under a Tenant on its
// own credentials selects Cloudflare, as the resolver does.
// outcome is the provider a new Episode would bind, or none (no provider or
// media disabled), or unresolvable (the API refuses to create the binding).
const classificationSQL = `
with tenant_doc as (
    select t.id, t.default_media_plane, t.default_media_plane_approved, t.media_plane_provider_config as c from tenants t
),
tenant_class as (
    select d.id,
        case
            when d.default_media_plane is null then 'none'
            else case btrim(d.default_media_plane) when 'cf_sfu' then 'cf_sfu' when 'chalk_sfu' then 'chalk_sfu' else 'unknown' end
        end as default_provider,
        case
            when btrim(coalesce(d.default_media_plane, '')) = 'cf_sfu' then 'cf_sfu'
            when btrim(coalesce(d.default_media_plane, '')) = 'chalk_sfu' and d.default_media_plane_approved then 'chalk_sfu'
            else 'none'
        end as resolver_default,
        case
            when d.c is null or jsonb_typeof(d.c) = 'null' then 'deployment_default'
            when jsonb_typeof(d.c) <> 'object'
                or coalesce(jsonb_typeof(d.c -> 'enabled'), 'null') not in ('boolean', 'null')
                or coalesce(jsonb_typeof(d.c -> 'provider'), 'null') not in ('string', 'null')
                or coalesce(jsonb_typeof(d.c -> 'mode'), 'null') not in ('string', 'null')
                or coalesce(jsonb_typeof(d.c -> 'cloudflare'), 'null') not in ('object', 'null')
                or coalesce(jsonb_typeof(d.c -> 'cloudflare' -> 'account_id'), 'null') not in ('string', 'null')
                or coalesce(jsonb_typeof(d.c -> 'cloudflare' -> 'sfu'), 'null') not in ('object', 'null')
                or coalesce(jsonb_typeof(d.c -> 'cloudflare' -> 'sfu' -> 'app_id'), 'null') not in ('string', 'null')
                or coalesce(jsonb_typeof(d.c -> 'cloudflare' -> 'sfu' -> 'app_secret'), 'null') not in ('string', 'null') then 'invalid'
            when d.c -> 'enabled' = 'false'::jsonb then 'disabled'
            when btrim(coalesce(d.c ->> 'provider', '')) not in ('', 'cf_sfu', 'chalk_sfu') then 'invalid'
            when btrim(coalesce(d.c ->> 'mode', '')) = 'chalk_managed' then 'tenant_chalk_managed'
            when btrim(coalesce(d.c ->> 'mode', '')) = 'tenant_managed' then 'tenant_managed'
            else 'invalid'
        end as config_source,
        btrim(coalesce(d.c ->> 'provider', '')) as config_provider,
        coalesce(jsonb_typeof(d.c -> 'cloudflare' -> 'sfu') = 'object', false) as sfu_configured
    from tenant_doc d
),
space_class as (
    select s.id, s.tenant_id, tc.config_source,
        case
            when own.plane is not null then 'space'
            when tc.resolver_default <> 'none' then 'tenant_default'
            else 'space'
        end as selection_source,
        case when pick.chosen = 'chalk_sfu' and tc.config_source = 'tenant_managed' then 'cf_sfu' else pick.chosen end as selected,
        tc.config_provider, tc.sfu_configured
    from spaces s
    join tenant_class tc on tc.id = s.tenant_id
    cross join lateral (
        select coalesce(s.media_plane_setting, case when btrim(s.media_plane) = 'chalk_sfu' then 'chalk_sfu' end) as plane
    ) own
    cross join lateral (
        select case
            when own.plane is not null then case own.plane when 'cf_sfu' then 'cf_sfu' when 'chalk_sfu' then 'chalk_sfu' else 'unknown' end
            when tc.resolver_default <> 'none' then tc.resolver_default
            when btrim(s.media_plane) = '' then 'none'
            else case btrim(s.media_plane) when 'cf_sfu' then 'cf_sfu' when 'chalk_sfu' then 'chalk_sfu' else 'unknown' end
        end as chosen
    ) pick
    where s.archived_at is null
),
space_outcome as (
    select sc.*,
        (sc.selected = 'chalk_sfu' and not ($1::boolean or sc.id = any($2::uuid[]))) as pinned
    from space_class sc
),
space_result as (
    select so.*,
        case
            when so.selected = 'unknown' then 'unresolvable'
            when so.selected = 'none' or so.config_source = 'disabled' then 'none'
            when so.config_source = 'invalid' then 'unresolvable'
            when so.config_source = 'tenant_managed' then
                case
                    when not so.sfu_configured then 'unresolvable'
                    when not so.pinned and so.config_provider not in ('', 'cf_sfu') then 'unresolvable'
                    else 'cf_sfu'
                end
            else case when so.pinned then 'cf_sfu' else so.selected end
        end as outcome
    from space_outcome so
)`

const tenantsSQL = classificationSQL + `
select tc.default_provider, tc.config_source,
    exists (select 1 from space_result sr where sr.tenant_id = tc.id and (sr.selected = 'cf_sfu' or sr.pinned)) as has_cloudflare_space,
    count(*)
from tenant_class tc
group by 1, 2, 3`

const spacesSQL = classificationSQL + `
select selected, selection_source, config_source, outcome, pinned, count(*)
from space_result
group by 1, 2, 3, 4, 5`

const archivedSpacesSQL = `select count(*) from spaces where archived_at is not null`

// boundProviderSQL names the provider in an Episode's media_plane_binding the way
// episodes.Episode.MediaPlaneBinding reads it: no binding key is a legacy
// Cloudflare Episode, a null binding is an Episode without media.
func boundProviderSQL(snapshot string) string {
	return `case
        when not (` + snapshot + ` ? 'media_plane_binding') then 'legacy_cf_sfu'
        else case jsonb_typeof(` + snapshot + ` -> 'media_plane_binding')
            when 'null' then 'none'
            when 'object' then case ` + snapshot + ` -> 'media_plane_binding' ->> 'provider'
                when 'cf_sfu' then 'cf_sfu' when 'chalk_sfu' then 'chalk_sfu' else 'other' end
            else 'unreadable'
        end
    end`
}

var (
	liveEpisodesSQL = `select ` + boundProviderSQL("e.config_snapshot") + ` as bound, count(*)
from episodes e where e.status in ('active', 'ending') group by 1`

	recentEpisodesSQL = `select ` + boundProviderSQL("e.config_snapshot") + ` as bound, count(*)
from episodes e where e.created_at >= now() - interval '24 hours' group by 1`

	recordingsSQL = `select ` + boundProviderSQL("e.config_snapshot") + ` as bound, count(*)
from recordings r join episodes e on e.id = r.episode_id group by 1`

	pipelinesSQL = `select ` + boundProviderSQL("e.config_snapshot") + ` as bound, count(*)
from recording_pipelines p
join recordings r on r.id = p.recording_id
join episodes e on e.id = r.episode_id
where p.state in ('requested', 'reserved', 'capture_leased', 'capturing_segmented', 'retryable_failure') group by 1`

	transcriptionsSQL = `select ` + boundProviderSQL("e.config_snapshot") + ` as bound, count(*)
from transcriptions x join episodes e on e.id = x.episode_id
where x.status in ('preparing', 'transcribing', 'verifying', 'retryable_failure') group by 1`
)
