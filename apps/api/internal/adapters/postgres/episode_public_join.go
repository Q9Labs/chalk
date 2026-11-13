package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r EpisodeLifecycleRepository) JoinPublic(ctx context.Context, input episodes.PublicJoinInput) (episodes.PublicJoinResult, error) {
	var result episodes.PublicJoinResult
	var commitMetric webhookCommitMetric
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		join := publicJoin{repo: r, queries: queries, tx: tx, input: input}
		var err error
		result, commitMetric, err = join.run(ctx)
		return err
	})
	if err != nil {
		return episodes.PublicJoinResult{}, err
	}
	commitMetric.Record(ctx)
	return result, nil
}

// publicJoin is one public join inside its transaction.
type publicJoin struct {
	repo    EpisodeLifecycleRepository
	queries *sqlc.Queries
	tx      pgx.Tx
	input   episodes.PublicJoinInput
}

func (j publicJoin) run(ctx context.Context) (episodes.PublicJoinResult, webhookCommitMetric, error) {
	invite, space, err := j.lockSpace(ctx)
	if err != nil {
		return episodes.PublicJoinResult{}, webhookCommitMetric{}, err
	}
	episode, created, metric, err := j.repo.ensurePublicLiveEpisode(ctx, j.queries, j.tx, j.input.TenantID, j.input.SpaceID, space, j.input.MediaClients)
	if err != nil {
		return episodes.PublicJoinResult{}, webhookCommitMetric{}, err
	}
	if episode.Status != episodes.EpisodeStatusActive {
		return episodes.PublicJoinResult{}, metric, episodes.ErrEpisodeNotActive
	}
	if !j.input.KnockArrivalID.IsZero() {
		if err := j.checkKnockArrival(ctx, space, invite, episode); err != nil {
			return episodes.PublicJoinResult{}, metric, err
		}
	}
	for _, existing := range []func(context.Context, sqlc.Episode, bool) (episodes.PublicJoinResult, bool, error){j.replay, j.existingAccountJoin} {
		result, found, err := existing(ctx, episode, created)
		if err != nil || found {
			return result, metric, err
		}
	}
	result, err := j.create(ctx, episode, created)
	return result, metric, err
}

// lockSpace takes the locks in the order the rest of the lifecycle uses and refuses an archived Space.
func (j publicJoin) lockSpace(ctx context.Context) (sqlc.SpacePublicInvite, sqlc.Space, error) {
	input := j.input
	var invite sqlc.SpacePublicInvite
	if j.repo.tenantLimits.AppliesTo(input.TenantID) && j.repo.tenantLimits.MaxLiveEpisodes > 0 {
		if _, err := j.queries.LockTenantMediaLimits(ctx, uuid(input.TenantID)); err != nil {
			return invite, sqlc.Space{}, fmt.Errorf("lock tenant media limits: %w", err)
		}
	}
	if !input.KnockArrivalID.IsZero() {
		var err error
		invite, err = j.queries.LockSpacePublicInvite(ctx, sqlc.LockSpacePublicInviteParams{TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return invite, sqlc.Space{}, publicinvites.ErrArrivalUnavailable
		}
		if err != nil {
			return invite, sqlc.Space{}, fmt.Errorf("lock knock invite: %w", err)
		}
	}
	space, err := j.queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(input.TenantID), ID: uuid(input.SpaceID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return invite, space, episodes.ErrSpaceNotFound
	}
	if err != nil {
		return invite, space, fmt.Errorf("lock public invite Space: %w", err)
	}
	if space.ArchivedAt.Valid {
		return invite, space, episodes.ErrAdmissionClosed
	}
	return invite, space, nil
}

func (j publicJoin) checkKnockArrival(ctx context.Context, space sqlc.Space, invite sqlc.SpacePublicInvite, episode sqlc.Episode) error {
	arrival, err := j.queries.LockSpacePublicArrival(ctx, uuid(j.input.KnockArrivalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return publicinvites.ErrArrivalUnavailable
	}
	if err != nil {
		return fmt.Errorf("lock knock arrival: %w", err)
	}
	if arrival.TenantID != uuid(j.input.TenantID) || arrival.SpaceID != uuid(j.input.SpaceID) {
		return publicinvites.ErrArrivalUnavailable
	}
	valid, err := publicAdmissionProvenanceValid(space, invite, arrival, episode, time.Now())
	if err != nil {
		return err
	}
	if !valid {
		return publicinvites.ErrArrivalUnavailable
	}
	return nil
}

// replay answers a repeat of the same join request with the stored result.
func (j publicJoin) replay(ctx context.Context, episode sqlc.Episode, created bool) (episodes.PublicJoinResult, bool, error) {
	input := j.input
	intent, err := j.queries.LockLifecycleIntentForRequestForUpdate(ctx, sqlc.LockLifecycleIntentForRequestForUpdateParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID,
		IntentName: episodes.IntentParticipantJoined, RequestKey: input.Request.Key,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return episodes.PublicJoinResult{}, false, nil
	}
	if err != nil {
		return episodes.PublicJoinResult{}, false, fmt.Errorf("lock public join intent: %w", err)
	}
	if err := idempotencyConflict(intent, input.Request); err != nil {
		return episodes.PublicJoinResult{}, false, err
	}
	participant, err := lockLifecycleParticipant(ctx, j.queries, input.TenantID, input.SpaceID, utilities.IDFromBytes(episode.ID.Bytes), nullableID(intent.ParticipantID))
	if err != nil {
		return episodes.PublicJoinResult{}, false, err
	}
	if participantGone(participant) {
		return episodes.PublicJoinResult{}, false, episodes.ErrParticipantNotActive
	}
	return publicJoinResult(episode, participant, intent, created), true, nil
}

// existingAccountJoin answers a signed-in account that already joined this Episode under another request.
func (j publicJoin) existingAccountJoin(ctx context.Context, episode sqlc.Episode, created bool) (episodes.PublicJoinResult, bool, error) {
	input := j.input
	if input.IdentityMode != "account" {
		return episodes.PublicJoinResult{}, false, nil
	}
	participant, err := j.queries.LockDashboardParticipantForUpdate(ctx, sqlc.LockDashboardParticipantForUpdateParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID, AccountID: uuid(input.AccountID),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return episodes.PublicJoinResult{}, false, nil
	}
	if err != nil {
		return episodes.PublicJoinResult{}, false, fmt.Errorf("lock public account participant: %w", err)
	}
	if participantGone(participant) {
		return episodes.PublicJoinResult{}, false, episodes.ErrParticipantNotActive
	}
	intent, err := j.queries.LockDashboardJoinIntentForUpdate(ctx, sqlc.LockDashboardJoinIntentForUpdateParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID, ParticipantID: participant.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return episodes.PublicJoinResult{}, false, nil
	}
	if err != nil {
		return episodes.PublicJoinResult{}, false, fmt.Errorf("lock existing public account join intent: %w", err)
	}
	return publicJoinResult(episode, participant, intent, created), true, nil
}

func (j publicJoin) create(ctx context.Context, episode sqlc.Episode, created bool) (episodes.PublicJoinResult, error) {
	input := j.input
	config, err := episodeConfig(episode.ConfigSnapshot)
	if err != nil {
		return episodes.PublicJoinResult{}, err
	}
	capabilities, ok := config.Roles[input.Role]
	if !ok {
		return episodes.PublicJoinResult{}, episodes.ErrInvalidRole
	}
	participantID, err := utilities.NewID()
	if err != nil {
		return episodes.PublicJoinResult{}, fmt.Errorf("create public participant id: %w", err)
	}
	payload := episodes.ParticipantJoinedPayload(participantID, input.DisplayName, input.Role)
	if _, err := j.queries.ReserveParticipantAdmission(ctx, sqlc.ReserveParticipantAdmissionParams{
		SnapshotReservationBytes: episodes.ParticipantSnapshotReservationBytes,
		ReservationBytes:         episodes.LifecycleReservationBytes,
		IntentPayloadBytes:       int64(len(payload)),
		MaxActiveParticipants:    episodes.MaximumActiveParticipants,
		TenantID:                 uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return episodes.PublicJoinResult{}, episodes.ErrCapacityExceeded
	} else if err != nil {
		return episodes.PublicJoinResult{}, fmt.Errorf("reserve public participant capacity: %w", err)
	}
	participant, err := j.insertParticipant(ctx, episode, participantID, capabilities)
	if err != nil {
		return episodes.PublicJoinResult{}, fmt.Errorf("create public participant: %w", err)
	}
	intent, err := j.insertJoinIntent(ctx, episode, participant, payload)
	if err != nil {
		return episodes.PublicJoinResult{}, err
	}
	return publicJoinResult(episode, participant, intent, created), nil
}

func (j publicJoin) insertParticipant(ctx context.Context, episode sqlc.Episode, participantID utilities.ID, capabilities []string) (sqlc.Participant, error) {
	input := j.input
	if input.IdentityMode == "account" {
		return j.queries.CreateDashboardLifecycleParticipant(ctx, sqlc.CreateDashboardLifecycleParticipantParams{
			ID: uuid(participantID), Name: pgtype.Text{String: input.DisplayName, Valid: true},
			Capabilities: append([]string(nil), capabilities...), Role: input.Role,
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID, AccountID: uuid(input.AccountID),
		})
	}
	return j.queries.CreateLifecycleParticipant(ctx, sqlc.CreateLifecycleParticipantParams{
		ID: uuid(participantID), Name: pgtype.Text{String: input.DisplayName, Valid: true},
		Capabilities: append([]string(nil), capabilities...), Role: input.Role,
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID,
	})
}

func (j publicJoin) insertJoinIntent(ctx context.Context, episode sqlc.Episode, participant sqlc.Participant, payload []byte) (sqlc.SyncLifecycleIntent, error) {
	input := j.input
	intentID, err := utilities.NewID()
	if err != nil {
		return sqlc.SyncLifecycleIntent{}, fmt.Errorf("create public participant intent id: %w", err)
	}
	journey, err := lifecycleJourneyFromContext(ctx)
	if err != nil {
		return sqlc.SyncLifecycleIntent{}, err
	}
	if err := persistLifecycleJourneyRoot(ctx, j.tx, journey, "participant.public_joined"); err != nil {
		return sqlc.SyncLifecycleIntent{}, err
	}
	intent, err := j.queries.CreateLifecycleIntent(ctx, sqlc.CreateLifecycleIntentParams{
		TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID,
		LifecycleIntentID: uuid(intentID), RequestKey: input.Request.Key, RequestFingerprint: input.Request.Fingerprint[:],
		IntentName: episodes.IntentParticipantJoined, ParticipantID: participant.ID,
		ParticipantGeneration: pgtype.Int8{Int64: participant.Generation, Valid: true}, Payload: jsonBytes(payload),
		JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID),
		ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID),
	})
	if err != nil {
		return intent, fmt.Errorf("create public participant intent: %w", err)
	}
	return intent, nil
}

func participantGone(participant sqlc.Participant) bool {
	return participant.Status == episodes.ParticipantStatusLeft || participant.Status == episodes.ParticipantStatusLeaving
}

func publicJoinResult(episode sqlc.Episode, participant sqlc.Participant, intent sqlc.SyncLifecycleIntent, created bool) episodes.PublicJoinResult {
	return episodes.PublicJoinResult{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent), EpisodeCreated: created}
}

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

var _ episodes.PublicJoinRepository = EpisodeLifecycleRepository{}
