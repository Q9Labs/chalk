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

// rawReport holds exact counts. Only report.go turns it into publishable output.
type tenantCounts struct {
	ByDefaultMediaPlane   counts
	ByConfigurationSource counts
	BySpaceSelection      counts
}

type spaceCounts struct {
	Archived                 int
	BySelection              counts
	ByNewEpisodeProvider     counts
	ByConfigurationSource    counts
	CloudflareByConfigSource counts
}

type rawReport struct {
	Tenants  tenantCounts
	Spaces   spaceCounts
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

// collect reads every count from one snapshot. It writes nothing.
func collect(ctx context.Context, q querier, list allowlist) (rawReport, error) {
	var report rawReport
	report.Tenants.ByDefaultMediaPlane, report.Tenants.ByConfigurationSource, report.Tenants.BySpaceSelection = counts{}, counts{}, counts{}
	report.Spaces.BySelection, report.Spaces.ByNewEpisodeProvider = counts{}, counts{}
	report.Spaces.ByConfigurationSource, report.Spaces.CloudflareByConfigSource = counts{}, counts{}

	if err := countTenants(ctx, q, list, &report.Tenants); err != nil {
		return rawReport{}, fmt.Errorf("count Tenants: %w", err)
	}
	if err := countSpaces(ctx, q, list, &report.Spaces); err != nil {
		return rawReport{}, fmt.Errorf("count Spaces: %w", err)
	}
	if err := scan(ctx, q, archivedSpacesSQL, nil, func(rows pgx.Rows) error {
		return rows.Scan(&report.Spaces.Archived)
	}); err != nil {
		return rawReport{}, fmt.Errorf("count archived Spaces: %w", err)
	}
	if err := countBoundProviders(ctx, q, &report); err != nil {
		return rawReport{}, err
	}
	return report, nil
}

func countTenants(ctx context.Context, q querier, list allowlist, tenants *tenantCounts) error {
	return scan(ctx, q, tenantsSQL, []any{list.all, list.spaces}, func(rows pgx.Rows) error {
		var provider, source string
		var hasCloudflareSpace bool
		var n int
		if err := rows.Scan(&provider, &source, &hasCloudflareSpace, &n); err != nil {
			return err
		}
		tenants.ByDefaultMediaPlane[provider] += n
		tenants.ByConfigurationSource[source] += n
		if hasCloudflareSpace {
			tenants.BySpaceSelection["has_cloudflare_space"] += n
		} else {
			tenants.BySpaceSelection["no_cloudflare_space"] += n
		}
		return nil
	})
}

func countSpaces(ctx context.Context, q querier, list allowlist, spaces *spaceCounts) error {
	return scan(ctx, q, spacesSQL, []any{list.all, list.spaces}, func(rows pgx.Rows) error {
		var selected, selectionSource, source, outcome string
		var pinned bool
		var n int
		if err := rows.Scan(&selected, &selectionSource, &source, &outcome, &pinned, &n); err != nil {
			return err
		}
		if selected == "none" {
			spaces.BySelection["none"] += n
		} else {
			spaces.BySelection[selectionSource+"_"+selected] += n
		}
		if outcome == "cf_sfu" && pinned {
			outcome = "cf_sfu_by_allowlist"
		}
		spaces.ByNewEpisodeProvider[outcome] += n
		spaces.ByConfigurationSource[source] += n
		if selected == "cf_sfu" || pinned {
			spaces.CloudflareByConfigSource[source] += n
		}
		return nil
	})
}

// countBoundProviders counts the Episodes and dependent work that stay bound to each media plane provider.
func countBoundProviders(ctx context.Context, q querier, report *rawReport) error {
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
			return fmt.Errorf("count %s: %w", query.name, err)
		}
		*query.into = result
	}
	return nil
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
