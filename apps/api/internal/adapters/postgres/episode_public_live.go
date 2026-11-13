package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r EpisodeLifecycleRepository) ensurePublicLiveEpisode(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, tenantID, spaceID utilities.ID, space sqlc.Space, clients mediaplane.ClientProviders) (sqlc.Episode, bool, webhookCommitMetric, error) {
	// Read the ID without locking the Episode, then follow Sync's order:
	// control before Episode. The caller's Space lock serializes creation.
	candidate, err := queries.GetLiveEpisodeForPublicJoin(ctx, sqlc.GetLiveEpisodeForPublicJoinParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
	if err == nil {
		if _, err := lockLifecycleControlRow(ctx, queries, tenantID, spaceID, utilities.IDFromBytes(candidate.ID.Bytes)); err != nil {
			return sqlc.Episode{}, false, webhookCommitMetric{}, err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return sqlc.Episode{}, false, webhookCommitMetric{}, err
	}
	episode, err := queries.LockLiveEpisodeForUpdate(ctx, sqlc.LockLiveEpisodeForUpdateParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
	if err == nil {
		// The Episode keeps its provider. Refuse a guest whose SDK cannot run it
		// here, in the transaction that would otherwise reserve its seat.
		if err := requireClientRunsBinding(mapLifecycleEpisode(episode), clients); err != nil {
			return sqlc.Episode{}, false, webhookCommitMetric{}, err
		}
		return episode, false, webhookCommitMetric{}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return sqlc.Episode{}, false, webhookCommitMetric{}, fmt.Errorf("lock public live Episode: %w", err)
	}
	if err := r.checkLiveEpisodeLimit(ctx, queries, tenantID); err != nil {
		return sqlc.Episode{}, false, webhookCommitMetric{}, err
	}
	id, err := utilities.NewID()
	if err != nil {
		return sqlc.Episode{}, false, webhookCommitMetric{}, fmt.Errorf("create public Episode id: %w", err)
	}
	artifactPolicy, err := resolveArtifactPolicyDocument(ctx, queries, tenantID, space)
	if err != nil {
		return sqlc.Episode{}, false, webhookCommitMetric{}, fmt.Errorf("resolve public Episode Artifact policy: %w", err)
	}
	mediaBinding, err := r.resolveEpisodeMediaBinding(ctx, queries, tenantID, space, clients)
	if err != nil {
		return sqlc.Episode{}, false, webhookCommitMetric{}, fmt.Errorf("resolve public Episode media binding: %w", err)
	}
	deadline := time.Now().UTC().Truncate(time.Millisecond).Add(time.Duration(space.DefaultEpisodeDurationSeconds) * time.Second)
	episode, err = queries.CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(id), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), DeadlineAt: timestamptz(&deadline), ArtifactPolicy: artifactPolicy, MediaPlaneBinding: mediaBinding})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.Episode{}, false, webhookCommitMetric{}, episodes.ErrSpaceNotFound
	}
	if err != nil {
		return sqlc.Episode{}, false, webhookCommitMetric{}, fmt.Errorf("create public Episode: %w", err)
	}
	initialControl, err := episodes.NewInitialControlState(episodes.InitialControlPolicy{ConfigSnapshot: episode.ConfigSnapshot, DeadlineAt: timestamp(episode.DeadlineAt), DeadlineGeneration: episode.DeadlineGeneration})
	if err != nil {
		return sqlc.Episode{}, false, webhookCommitMetric{}, err
	}
	if _, err := queries.CreateSyncEpisodeControl(ctx, sqlc.CreateSyncEpisodeControlParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), EpisodeID: episode.ID, FoldedState: jsonBytes(initialControl.FoldedState), StateSchemaVersion: initialControl.SchemaVersion, StateDigest: initialControl.Digest[:], SnapshotBytes: initialControl.SnapshotBytes}); err != nil {
		return sqlc.Episode{}, false, webhookCommitMetric{}, fmt.Errorf("create public Episode control: %w", err)
	}
	snapshot := webhooks.EpisodeSnapshot{ID: id.String(), SpaceID: spaceID.String(), Status: episode.Status, StartedAt: nullableTimestamp(episode.StartedAt), EndedAt: nullableTimestamp(episode.EndedAt), CreatedAt: timestamp(episode.CreatedAt), UpdatedAt: timestamp(episode.UpdatedAt)}
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: tenantID, EventName: webhooks.EventEpisodeStarted, SemanticKey: "episode:" + id.String() + ":started", ResourceType: "episode", ResourceID: id, OccurredAt: timestamp(episode.CreatedAt), Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
		return webhooks.EncodeEpisodeEvent(metadata, snapshot)
	}})
	if err != nil {
		return sqlc.Episode{}, false, webhookCommitMetric{}, fmt.Errorf("produce public Episode started webhook: %w", err)
	}
	return episode, true, metric, nil
}

// requireClientRunsBinding returns mediaplane.ErrClientUnsupported when the
// Episode is bound to the own SFU and the caller's SDK cannot run it. Bindings
// name providers in the Space vocabulary, and every SDK runs Cloudflare, so only
// an own-SFU binding can refuse. An Episode with no binding, or one that predates
// bindings, is Cloudflare or has no media.
func requireClientRunsBinding(episode episodes.Episode, clients mediaplane.ClientProviders) error {
	binding, _, err := episode.MediaPlaneBinding()
	if err != nil {
		return err
	}
	if binding != nil && spaces.MediaPlaneProvider(binding.Provider) == spaces.MediaPlaneProviderChalkSFU && !clients.Runs(mediaplane.ProviderChalkSFU) {
		return mediaplane.ErrClientUnsupported
	}
	return nil
}
