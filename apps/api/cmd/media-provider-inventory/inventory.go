package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// querier is the read side of a pgx connection or transaction.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// counts maps a value to how many rows have it.
type counts map[string]int

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

// Stored settings and bindings are provenance, not routing. Report them separately
// from what the only current media plane can serve.
const classificationSQL = `
with tenant_class as (
    select t.id,
        case btrim(t.default_media_plane)
            when 'cf_sfu' then 'cf_sfu'
            when 'cf_rtk' then 'cf_sfu'
            when 'chalk_sfu' then 'chalk_sfu'
            else case when t.default_media_plane is null then 'none' else 'unknown' end
        end as default_provider,
        case
            when t.media_plane_provider_config -> 'enabled' = 'false'::jsonb then 'disabled'
            when t.media_plane_provider_config is null or t.media_plane_provider_config = 'null'::jsonb then 'deployment_default'
            when jsonb_typeof(t.media_plane_provider_config) = 'object' then 'tenant_chalk_managed'
            else 'invalid'
        end as config_source
    from tenants t
),
space_result as (
    select s.tenant_id, t.config_source,
        case coalesce(s.media_plane_setting, btrim(s.media_plane))
            when 'cf_sfu' then 'cf_sfu'
            when 'cf_rtk' then 'cf_sfu'
            when 'chalk_sfu' then 'chalk_sfu'
            else 'unknown'
        end as stored_provider,
        case when t.config_source = 'disabled' then 'none' else 'chalk_sfu' end as outcome
    from spaces s join tenant_class t on t.id = s.tenant_id
    where s.archived_at is null
)`

const tenantsSQL = classificationSQL + `
select t.default_provider, t.config_source,
    exists (select 1 from space_result s where s.tenant_id = t.id and s.stored_provider = 'cf_sfu'),
    count(*)
from tenant_class t
group by 1, 2, 3`

const spacesSQL = classificationSQL + `
select stored_provider, config_source, outcome, count(*)
from space_result
group by 1, 2, 3`

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
                when 'cf_sfu' then 'cf_sfu' when 'cf_rtk' then 'cf_rtk' when 'chalk_sfu' then 'chalk_sfu' else 'other' end
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
func collect(ctx context.Context, q querier) (rawReport, error) {
	var report rawReport
	report.Tenants.ByDefaultMediaPlane, report.Tenants.ByConfigurationSource, report.Tenants.BySpaceSelection = counts{}, counts{}, counts{}
	report.Spaces.BySelection, report.Spaces.ByNewEpisodeProvider = counts{}, counts{}
	report.Spaces.ByConfigurationSource, report.Spaces.CloudflareByConfigSource = counts{}, counts{}

	err := scan(ctx, q, tenantsSQL, nil, func(rows pgx.Rows) error {
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

	err = scan(ctx, q, spacesSQL, nil, func(rows pgx.Rows) error {
		var stored, source, outcome string
		var n int
		if err := rows.Scan(&stored, &source, &outcome, &n); err != nil {
			return err
		}
		report.Spaces.BySelection["space_"+stored] += n
		report.Spaces.ByNewEpisodeProvider[outcome] += n
		report.Spaces.ByConfigurationSource[source] += n
		if stored == "cf_sfu" {
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
