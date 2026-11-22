package telemetrydelivery

import (
	"context"
	"slices"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// EpisodeReader reads the ledger rows of the sources one Episode names.
type EpisodeReader interface {
	Episode(ctx context.Context, tenant, episode utilities.ID) ([]SourceRow, error)
}

// SourceReport is one source's watermark and the seq ranges it cannot account for.
type SourceReport struct {
	SourceID  utilities.ID    `json:"source_id"`
	Watermark SourceWatermark `json:"watermark"`
	Gaps      []EvidenceGap   `json:"gaps"`
}

// Report is what the ledger knows of one Episode, the shape telemetry-watermarks prints and diagnose's live reader reads.
type Report struct {
	TenantID  utilities.ID   `json:"tenant_id"`
	EpisodeID utilities.ID   `json:"episode_id"`
	Sources   []SourceReport `json:"sources"`
}

// EpisodeReport runs Gaps on each of the Episode's sources, one row each, ordered by source id.
func EpisodeReport(ctx context.Context, ledger EpisodeReader, tenant, episode utilities.ID) (Report, error) {
	rows, err := ledger.Episode(ctx, tenant, episode)
	if err != nil {
		return Report{}, err
	}
	sources := make([]SourceReport, 0, len(rows))
	for _, row := range rows {
		gaps, mark := Gaps(row)
		sources = append(sources, SourceReport{SourceID: row.SourceID, Watermark: mark, Gaps: gaps})
	}
	slices.SortFunc(sources, func(a, b SourceReport) int { return strings.Compare(a.SourceID.String(), b.SourceID.String()) })
	return Report{TenantID: tenant, EpisodeID: episode, Sources: sources}, nil
}
