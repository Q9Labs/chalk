package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r EpisodeLifecycleRepository) CreateEpisode(ctx context.Context, input episodes.CreateEpisodeInput) (episodes.Episode, error) {
	var result episodes.Episode
	var commitMetric webhookCommitMetric

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		request, err := queries.ReserveEpisodeCreateRequest(ctx, sqlc.ReserveEpisodeCreateRequestParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestKey: input.Request.Key,
			RequestFingerprint: input.Request.Fingerprint[:], EpisodeID: uuid(input.ID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			result, err = replayEpisodeCreate(ctx, queries, input)
			return err
		}
		if err != nil {
			return fmt.Errorf("reserve episode create request: %w", err)
		}
		if err := r.checkLiveEpisodeLimit(ctx, queries, input.TenantID); err != nil {
			return err
		}
		episode, err := r.insertEpisode(ctx, queries, input, timestamp(request.CreatedAt))
		if err != nil {
			return err
		}
		if err := createEpisodeControl(ctx, queries, input, episode); err != nil {
			return err
		}
		if commitMetric, err = produceEpisodeStarted(ctx, tx, input, episode); err != nil {
			return fmt.Errorf("produce episode.started webhook: %w", err)
		}
		result = mapLifecycleEpisode(episode)
		return nil
	})
	if err != nil {
		return episodes.Episode{}, err
	}
	commitMetric.Record(ctx)
	return result, nil
}

// replayEpisodeCreate answers a repeated create request with the Episode the first attempt made.
func replayEpisodeCreate(ctx context.Context, queries *sqlc.Queries, input episodes.CreateEpisodeInput) (episodes.Episode, error) {
	request, err := queries.GetEpisodeCreateRequest(ctx, sqlc.GetEpisodeCreateRequestParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), RequestKey: input.Request.Key,
	})
	if err != nil {
		return episodes.Episode{}, fmt.Errorf("read episode create request: %w", err)
	}
	if !bytes.Equal(request.RequestFingerprint, input.Request.Fingerprint[:]) {
		return episodes.Episode{}, episodes.ErrIdempotencyConflict
	}
	episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, utilities.IDFromBytes(request.EpisodeID.Bytes))
	if err != nil {
		return episodes.Episode{}, err
	}
	return mapLifecycleEpisode(episode), nil
}

// insertEpisode locks the Space, resolves its media binding and Artifact policy, and creates the row.
func (r EpisodeLifecycleRepository) insertEpisode(ctx context.Context, queries *sqlc.Queries, input episodes.CreateEpisodeInput, requestedAt time.Time) (sqlc.Episode, error) {
	space, err := queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(input.TenantID), ID: uuid(input.SpaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.Episode{}, episodes.ErrSpaceNotFound
	}
	if err != nil {
		return sqlc.Episode{}, fmt.Errorf("lock episode space policy: %w", err)
	}
	mediaBinding, err := r.resolveEpisodeMediaBinding(ctx, queries, input.TenantID, space, input.MediaClients)
	if err != nil {
		return sqlc.Episode{}, fmt.Errorf("resolve episode media binding: %w", err)
	}
	artifactPolicy, err := resolveArtifactPolicyDocument(ctx, queries, input.TenantID, space)
	if err != nil {
		return sqlc.Episode{}, fmt.Errorf("resolve episode Artifact policy: %w", err)
	}
	deadlineAt := input.DeadlineAt.UTC().Truncate(time.Millisecond)
	if input.DeadlineAt.IsZero() {
		deadlineAt = requestedAt.UTC().Truncate(time.Millisecond).Add(time.Duration(space.DefaultEpisodeDurationSeconds) * time.Second)
	}
	episode, err := queries.CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{
		ID: uuid(input.ID), Metadata: jsonBytes(input.Metadata), CreatedByUserID: uuid(input.CreatedByUserID),
		StartedAt: timestamptz(input.StartedAt), DeadlineAt: timestamptz(&deadlineAt),
		ArtifactPolicy:    artifactPolicy,
		MediaPlaneBinding: mediaBinding,
		TenantID:          uuid(input.TenantID), SpaceID: uuid(input.SpaceID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.Episode{}, episodes.ErrSpaceNotFound
	}
	if episodeAlreadyExists(err) {
		return sqlc.Episode{}, episodes.ErrEpisodeAlreadyExists
	}
	if err != nil {
		return sqlc.Episode{}, fmt.Errorf("create lifecycle episode: %w", err)
	}
	return episode, nil
}

func createEpisodeControl(ctx context.Context, queries *sqlc.Queries, input episodes.CreateEpisodeInput, episode sqlc.Episode) error {
	initialControl, err := episodes.NewInitialControlState(episodes.InitialControlPolicy{
		ConfigSnapshot:     episode.ConfigSnapshot,
		DeadlineAt:         timestamp(episode.DeadlineAt),
		DeadlineGeneration: episode.DeadlineGeneration,
	})
	if err != nil {
		return err
	}
	if _, err := queries.CreateSyncEpisodeControl(ctx, sqlc.CreateSyncEpisodeControlParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.ID),
		FoldedState: jsonBytes(initialControl.FoldedState), StateSchemaVersion: initialControl.SchemaVersion,
		StateDigest: initialControl.Digest[:], SnapshotBytes: initialControl.SnapshotBytes,
	}); err != nil {
		return fmt.Errorf("create episode control: %w", err)
	}
	return nil
}

func produceEpisodeStarted(ctx context.Context, tx pgx.Tx, input episodes.CreateEpisodeInput, episode sqlc.Episode) (webhookCommitMetric, error) {
	snapshot := webhooks.EpisodeSnapshot{
		ID: input.ID.String(), SpaceID: input.SpaceID.String(), Status: episode.Status,
		StartedAt: nullableTimestamp(episode.StartedAt), EndedAt: nullableTimestamp(episode.EndedAt),
		CreatedAt: timestamp(episode.CreatedAt), UpdatedAt: timestamp(episode.UpdatedAt),
	}
	occurredAt := timestamp(episode.CreatedAt)
	if episode.StartedAt.Valid {
		occurredAt = timestamp(episode.StartedAt)
	}
	return fanoutWebhookEvent(ctx, tx, webhookProduction{
		TenantID: input.TenantID, EventName: webhooks.EventEpisodeStarted, SemanticKey: "episode:" + input.ID.String() + ":started",
		ResourceType: "episode", ResourceID: input.ID, OccurredAt: occurredAt,
		Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
			return webhooks.EncodeEpisodeEvent(metadata, snapshot)
		},
	})
}

func resolveArtifactPolicyDocument(ctx context.Context, queries *sqlc.Queries, tenantID utilities.ID, space sqlc.Space) ([]byte, error) {
	policy, err := queries.LockTenantArtifactPolicyForShare(ctx, uuid(tenantID))
	if err != nil {
		return nil, err
	}
	tenantPolicy := artifactpolicy.TenantPolicy{
		TranscriptionCeiling:      artifactpolicy.TranscriptionMode(policy.TranscriptionCeiling),
		TranscriptionDefault:      artifactpolicy.TranscriptionMode(policy.TranscriptionDefaultMode),
		ProviderPolicyVersion:     policy.ProviderPolicyVersion,
		RecordingRetention:        time.Duration(policy.RecordingRetentionSeconds) * time.Second,
		TranscriptRetention:       time.Duration(policy.TranscriptRetentionSeconds) * time.Second,
		TranscriptionSourceWindow: time.Duration(policy.SourceWindowSeconds) * time.Second,
	}
	return artifactPolicyDocument(tenantPolicy, artifactpolicy.SpacePolicy{
		Recording:     artifactpolicy.RecordingMode(space.RecordingPolicy),
		Transcription: artifactpolicy.TranscriptionMode(space.TranscriptionPolicy),
	})
}

func artifactPolicyDocument(tenantPolicy artifactpolicy.TenantPolicy, spacePolicy artifactpolicy.SpacePolicy) ([]byte, error) {
	snapshot, err := artifactpolicy.Resolve(tenantPolicy, spacePolicy)
	if err != nil {
		return nil, err
	}
	document, err := snapshot.Document()
	if err != nil {
		return nil, err
	}
	return json.Marshal(document)
}

func episodeAlreadyExists(err error) bool {
	return uniqueConstraintViolation(err, "episodes_pkey") || uniqueConstraintViolation(err, "episodes_one_live_per_space_idx")
}

func episodeConfig(raw []byte) (episodes.EpisodeConfigSnapshot, error) {
	var config episodes.EpisodeConfigSnapshot
	if err := json.Unmarshal(raw, &config); err != nil {
		return episodes.EpisodeConfigSnapshot{}, episodes.ErrInvalidConfigSnapshot
	}
	return config, nil
}

func configAdmissionMode(raw json.RawMessage) (string, error) {
	var policy struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(raw, &policy); err != nil {
		return "", episodes.ErrInvalidAdmissionPolicy
	}
	if policy.Mode != "open" && policy.Mode != "knock" && policy.Mode != "members_only" {
		return "", episodes.ErrInvalidAdmissionPolicy
	}
	return policy.Mode, nil
}
