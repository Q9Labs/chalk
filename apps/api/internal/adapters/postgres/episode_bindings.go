package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeBindingQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// EpisodeBindings reads the provider frozen into the Episode. Capture uses it to
// refuse the Episodes it cannot serve, and cleanup uses it to pick the closer.
// An Episode with no binding predates it and ran on Cloudflare.
type EpisodeBindings struct {
	db         episodeBindingQuerier
	ownCapture bool
}

func NewEpisodeBindings(db episodeBindingQuerier) EpisodeBindings {
	return EpisodeBindings{db: db}
}

// WithOwnCapture says the recorder can reach the own SFU's nodes, so an Episode bound to it is
// capturable.
func (e EpisodeBindings) WithOwnCapture(enabled bool) EpisodeBindings {
	e.ownCapture = enabled
	return e
}

// BindingOf returns the bound provider, node and binding generation. The provider and node are
// "" for an Episode with no binding, and the node is "" for a provider with one endpoint. The
// generation is 0 until the Episode first moves.
func (e EpisodeBindings) BindingOf(ctx context.Context, tenantID, episodeID utilities.ID) (string, string, int64, error) {
	var provider, node *string
	var generation int64
	err := e.db.QueryRow(ctx, `select config_snapshot->'media_plane_binding'->>'provider', config_snapshot->'media_plane_binding'->>'node', coalesce((config_snapshot->'media_plane_binding'->>'generation')::bigint, 0) from episodes where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(episodeID)).Scan(&provider, &node, &generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", 0, recordingpipeline.ErrPipelineNotFound
	}
	if err != nil {
		return "", "", 0, fmt.Errorf("read Episode media plane binding: %w", err)
	}
	if provider == nil {
		return "", "", 0, nil
	}
	if node == nil {
		return *provider, "", generation, nil
	}
	return *provider, *node, generation, nil
}

func (e EpisodeBindings) CaptureSupported(ctx context.Context, tenantID, episodeID utilities.ID) error {
	provider, _, _, err := e.BindingOf(ctx, tenantID, episodeID)
	if err != nil {
		return err
	}
	if provider == mediaplane.ProviderChalkSFU.SettingName() && !e.ownCapture {
		return recordingpipeline.ErrCaptureUnsupported
	}
	return nil
}

var _ recordingpipeline.CaptureEligibility = EpisodeBindings{}
