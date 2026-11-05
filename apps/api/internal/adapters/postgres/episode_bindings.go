package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeBindingQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// EpisodeBindings reads the provider frozen into the Episode. Capture uses it to
// refuse the Episodes it cannot serve, and cleanup uses it to pick the closer.
// An Episode with no binding predates it and ran on Cloudflare.
type EpisodeBindings struct{ db episodeBindingQuerier }

func NewEpisodeBindings(db episodeBindingQuerier) EpisodeBindings {
	return EpisodeBindings{db: db}
}

// BindingOf returns the bound provider and node. Both are "" for an Episode with
// no binding, and the node is "" for a provider with one endpoint.
func (e EpisodeBindings) BindingOf(ctx context.Context, tenantID, episodeID utilities.ID) (string, string, error) {
	var provider, node *string
	err := e.db.QueryRow(ctx, `select config_snapshot->'media_plane_binding'->>'provider', config_snapshot->'media_plane_binding'->>'node' from episodes where tenant_id = $1 and id = $2`, uuid(tenantID), uuid(episodeID)).Scan(&provider, &node)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", recordingpipeline.ErrPipelineNotFound
	}
	if err != nil {
		return "", "", fmt.Errorf("read Episode media plane binding: %w", err)
	}
	if provider == nil {
		return "", "", nil
	}
	if node == nil {
		return *provider, "", nil
	}
	return *provider, *node, nil
}

func (e EpisodeBindings) CaptureSupported(ctx context.Context, tenantID, episodeID utilities.ID) error {
	provider, _, err := e.BindingOf(ctx, tenantID, episodeID)
	if err != nil {
		return err
	}
	if provider == string(spaces.MediaPlaneProviderChalkSFU) {
		return recordingpipeline.ErrCaptureUnsupported
	}
	return nil
}

var _ recordingpipeline.CaptureEligibility = EpisodeBindings{}
