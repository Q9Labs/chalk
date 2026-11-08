package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// querier is the read side of a pgx connection or transaction.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// allowlist is the CHALK_SFU_ALLOWED_SPACES value the API runs with: "*" or Space IDs.
type allowlist struct {
	all    bool
	spaces []string
}

func parseAllowlist(value string) (allowlist, error) {
	list := allowlist{spaces: []string{}}
	for _, entry := range strings.Split(value, ",") {
		entry = strings.TrimSpace(entry)
		switch {
		case entry == "":
		case entry == "*":
			list.all = true
		default:
			id, err := utilities.ParseID(entry)
			if err != nil {
				return allowlist{}, fmt.Errorf("allowlist entry is not a Space ID or *")
			}
			list.spaces = append(list.spaces, id.String())
		}
	}
	return list, nil
}

// counts maps a value to how many rows have it.
type counts map[string]int

func (c counts) total() int {
	sum := 0
	for _, n := range c {
		sum += n
	}
	return sum
}

// rawReport holds exact counts. Only report.go turns it into publishable output.
type rawReport struct {
	Tenants struct {
		ByDefaultMediaPlane   counts
		ByConfigurationSource counts
		BySpaceSelection      counts
	}
	Spaces struct {
		Archived                 int
		BySelection              counts
		ByNewEpisodeProvider     counts
		ByConfigurationSource    counts
		CloudflareByConfigSource counts
	}
	Episodes struct {
		LiveByBoundProvider           counts
		CreatedLast24hByBoundProvider counts
	}
	Dependencies struct {
		RecordingsByBoundProvider            counts
		RecordingPipelinesInFlightByProvider counts
		TranscriptionsInFlightByProvider     counts
	}
}

// Both tenant_class and space_class mirror the resolution in
// apps/api/internal/adapters/mediaplaneproviders (selectedProvider,
// resolveProviderConfig, ResolveBinding). Keep them in step with that package.
//
// tenant_class.config_source is how resolveProviderConfig reads
// tenants.media_plane_provider_config: empty is the deployment default,
// enabled=false disables media, and mode picks Chalk-managed or tenant-managed.
// A malformed document, unknown provider string or unknown mode is invalid.
//
// space_class.selected is the Space's own media_plane, else the Tenant default.
// A chalk_sfu selection outside the allowlist is pinned to Cloudflare.
// outcome is the provider a new Episode would bind, or none (no provider or
// media disabled), or unresolvable (the API refuses to create the binding).
const classificationSQL = `
with tenant_doc as (
    select t.id, t.default_media_plane, t.media_plane_provider_config as c from tenants t
),
tenant_class as (
    select d.id,
        case
            when d.default_media_plane is null then 'none'
            else case btrim(d.default_media_plane) when 'cf_sfu' then 'cf_sfu' when 'chalk_sfu' then 'chalk_sfu' else 'unknown' end
        end as default_provider,
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
        case when btrim(s.media_plane) <> '' then 'space' else 'tenant_default' end as selection_source,
        case
            when btrim(s.media_plane) = '' then tc.default_provider
            else case btrim(s.media_plane) when 'cf_sfu' then 'cf_sfu' when 'chalk_sfu' then 'chalk_sfu' else 'unknown' end
        end as selected,
        tc.config_provider, tc.sfu_configured
    from spaces s
    join tenant_class tc on tc.id = s.tenant_id
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
                    when so.selected = 'chalk_sfu' and not so.pinned then 'unresolvable'
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

// collect reads every count from one snapshot. It writes nothing.
func collect(ctx context.Context, q querier, list allowlist) (rawReport, error) {
	var report rawReport
	report.Tenants.ByDefaultMediaPlane, report.Tenants.ByConfigurationSource, report.Tenants.BySpaceSelection = counts{}, counts{}, counts{}
	report.Spaces.BySelection, report.Spaces.ByNewEpisodeProvider = counts{}, counts{}
	report.Spaces.ByConfigurationSource, report.Spaces.CloudflareByConfigSource = counts{}, counts{}

	err := scan(ctx, q, tenantsSQL, []any{list.all, list.spaces}, func(rows pgx.Rows) error {
		var provider, source string
		var hasCloudflareSpace bool
		var n int
		if err := rows.Scan(&provider, &source, &hasCloudflareSpace, &n); err != nil {
			return err
		}
		report.Tenants.ByDefaultMediaPlane[provider] += n
		report.Tenants.ByConfigurationSource[source] += n
		if hasCloudflareSpace {
			report.Tenants.BySpaceSelection["has_cloudflare_space"] += n
		} else {
			report.Tenants.BySpaceSelection["no_cloudflare_space"] += n
		}
		return nil
	})
	if err != nil {
		return rawReport{}, fmt.Errorf("count Tenants: %w", err)
	}

	err = scan(ctx, q, spacesSQL, []any{list.all, list.spaces}, func(rows pgx.Rows) error {
		var selected, selectionSource, source, outcome string
		var pinned bool
		var n int
		if err := rows.Scan(&selected, &selectionSource, &source, &outcome, &pinned, &n); err != nil {
			return err
		}
		if selected == "none" {
			report.Spaces.BySelection["none"] += n
		} else {
			report.Spaces.BySelection[selectionSource+"_"+selected] += n
		}
		if outcome == "cf_sfu" && pinned {
			outcome = "cf_sfu_by_allowlist"
		}
		report.Spaces.ByNewEpisodeProvider[outcome] += n
		report.Spaces.ByConfigurationSource[source] += n
		if selected == "cf_sfu" || pinned {
			report.Spaces.CloudflareByConfigSource[source] += n
		}
		return nil
	})
	if err != nil {
		return rawReport{}, fmt.Errorf("count Spaces: %w", err)
	}

	if err := scan(ctx, q, archivedSpacesSQL, nil, func(rows pgx.Rows) error {
		return rows.Scan(&report.Spaces.Archived)
	}); err != nil {
		return rawReport{}, fmt.Errorf("count archived Spaces: %w", err)
	}

	for _, query := range []struct {
		name string
		sql  string
		into *counts
	}{
		{"live Episodes", liveEpisodesSQL, &report.Episodes.LiveByBoundProvider},
		{"recent Episodes", recentEpisodesSQL, &report.Episodes.CreatedLast24hByBoundProvider},
		{"Recordings", recordingsSQL, &report.Dependencies.RecordingsByBoundProvider},
		{"recording pipelines", pipelinesSQL, &report.Dependencies.RecordingPipelinesInFlightByProvider},
		{"Transcriptions", transcriptionsSQL, &report.Dependencies.TranscriptionsInFlightByProvider},
	} {
		result := counts{}
		if err := scan(ctx, q, query.sql, nil, func(rows pgx.Rows) error {
			var bound string
			var n int
			if err := rows.Scan(&bound, &n); err != nil {
				return err
			}
			result[bound] += n
			return nil
		}); err != nil {
			return rawReport{}, fmt.Errorf("count %s: %w", query.name, err)
		}
		*query.into = result
	}
	return report, nil
}

func scan(ctx context.Context, q querier, sql string, args []any, each func(pgx.Rows) error) error {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := each(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}
