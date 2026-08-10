package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

// JoinSelf is the account-bound Dashboard path. The Space slug, live Episode,
// and account Participant are resolved while one Space row is locked. The
// legacy broker continues to use AdmitParticipant unchanged.
func (r EpisodeLifecycleRepository) JoinSelf(ctx context.Context, input episodes.SelfJoinInput) (episodes.SelfJoinResult, error) {
	var result episodes.SelfJoinResult
	var commitMetric webhookCommitMetric
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		space, err := queries.LockTenantSpaceBySlugForUpdate(ctx, sqlc.LockTenantSpaceBySlugForUpdateParams{TenantID: uuid(input.TenantID), Slug: input.SpaceSlug})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrSpaceNotFound
		}
		if err != nil {
			return fmt.Errorf("lock dashboard Space: %w", err)
		}
		if space.ArchivedAt.Valid {
			return episodes.ErrAdmissionClosed
		}

		episode, err := queries.LockLiveEpisodeForUpdate(ctx, sqlc.LockLiveEpisodeForUpdateParams{TenantID: uuid(input.TenantID), SpaceID: space.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			id, idErr := utilities.NewID()
			if idErr != nil {
				return idErr
			}
			deadline := time.Now().UTC().Truncate(time.Millisecond).Add(time.Duration(space.DefaultEpisodeDurationSeconds) * time.Second)
			episode, err = queries.CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{
				ID: uuid(id), TenantID: uuid(input.TenantID), SpaceID: space.ID,
				CreatedByUserID: uuid(input.AccountID), DeadlineAt: timestamptz(&deadline),
			})
			if errors.Is(err, pgx.ErrNoRows) {
				return episodes.ErrSpaceNotFound
			}
			if err != nil {
				return fmt.Errorf("create dashboard Episode: %w", err)
			}
			initialControl, controlErr := episodes.NewInitialControlState(episodes.InitialControlPolicy{ConfigSnapshot: episode.ConfigSnapshot, DeadlineAt: timestamp(episode.DeadlineAt), DeadlineGeneration: episode.DeadlineGeneration})
			if controlErr != nil {
				return controlErr
			}
			if _, controlErr = queries.CreateSyncEpisodeControl(ctx, sqlc.CreateSyncEpisodeControlParams{
				TenantID: uuid(input.TenantID), SpaceID: space.ID, EpisodeID: episode.ID,
				FoldedState: jsonBytes(initialControl.FoldedState), StateSchemaVersion: initialControl.SchemaVersion,
				StateDigest: initialControl.Digest[:], SnapshotBytes: initialControl.SnapshotBytes,
			}); controlErr != nil {
				return fmt.Errorf("create dashboard Episode control: %w", controlErr)
			}
			snapshot := webhooks.EpisodeSnapshot{ID: id.String(), SpaceID: utilities.IDFromBytes(space.ID.Bytes).String(), Status: episode.Status, StartedAt: nullableTimestamp(episode.StartedAt), EndedAt: nullableTimestamp(episode.EndedAt), CreatedAt: timestamp(episode.CreatedAt), UpdatedAt: timestamp(episode.UpdatedAt)}
			occurredAt := timestamp(episode.CreatedAt)
			if episode.StartedAt.Valid {
				occurredAt = timestamp(episode.StartedAt)
			}
			commitMetric, err = fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: input.TenantID, EventName: "episode.started", SemanticKey: "episode:" + id.String() + ":started", ResourceType: "episode", ResourceID: id, OccurredAt: occurredAt, Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
				return webhooks.EncodeEpisodeEvent(metadata, snapshot)
			}})
			if err != nil {
				return fmt.Errorf("produce dashboard episode.started webhook: %w", err)
			}
		} else if err != nil {
			return fmt.Errorf("lock dashboard live Episode: %w", err)
		}
		if episode.Status != episodes.EpisodeStatusActive {
			return episodes.ErrEpisodeNotActive
		}

		participant, err := queries.LockDashboardParticipantForUpdate(ctx, sqlc.LockDashboardParticipantForUpdateParams{TenantID: uuid(input.TenantID), SpaceID: space.ID, EpisodeID: episode.ID, AccountID: uuid(input.AccountID)})
		if err == nil {
			intent, intentErr := queries.LockDashboardJoinIntentForUpdate(ctx, sqlc.LockDashboardJoinIntentForUpdateParams{TenantID: uuid(input.TenantID), SpaceID: space.ID, EpisodeID: episode.ID, ParticipantID: participant.ID})
			if intentErr != nil {
				return fmt.Errorf("lock dashboard join intent: %w", intentErr)
			}
			if input.Request.Key == intent.RequestKey && !bytes.Equal(intent.RequestFingerprint, input.Request.Fingerprint[:]) {
				return episodes.ErrIdempotencyConflict
			}
			if participant.Status == episodes.ParticipantStatusLeft || participant.Status == episodes.ParticipantStatusLeaving {
				return episodes.ErrParticipantNotActive
			}
			result = episodes.SelfJoinResult{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent)}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock dashboard participant: %w", err)
		}

		config, err := episodeConfig(episode.ConfigSnapshot)
		if err != nil {
			return err
		}
		if episode.Status != episodes.EpisodeStatusActive {
			return episodes.ErrEpisodeNotActive
		}
		capabilities, ok := config.Roles["owner"]
		if !ok {
			return episodes.ErrInvalidRole
		}
		if _, err := lockLifecycleControlRow(ctx, queries, input.TenantID, utilities.IDFromBytes(space.ID.Bytes), utilities.IDFromBytes(episode.ID.Bytes)); err != nil {
			return err
		}
		payload := episodes.ParticipantJoinedPayload(utilities.ID{}, input.DisplayName, "owner")
		if _, err := queries.ReserveParticipantAdmission(ctx, sqlc.ReserveParticipantAdmissionParams{SnapshotReservationBytes: episodes.ParticipantSnapshotReservationBytes, ReservationBytes: episodes.LifecycleReservationBytes, IntentPayloadBytes: int64(len(payload)), MaxActiveParticipants: episodes.MaximumActiveParticipants, TenantID: uuid(input.TenantID), SpaceID: space.ID, EpisodeID: episode.ID}); errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrCapacityExceeded
		} else if err != nil {
			return fmt.Errorf("reserve dashboard participant capacity: %w", err)
		}
		participantID, err := utilities.NewID()
		if err != nil {
			return err
		}
		payload = episodes.ParticipantJoinedPayload(participantID, input.DisplayName, "owner")
		participant, err = queries.CreateDashboardLifecycleParticipant(ctx, sqlc.CreateDashboardLifecycleParticipantParams{ID: uuid(participantID), Name: pgtype.Text{String: input.DisplayName, Valid: true}, Capabilities: append([]string(nil), capabilities...), Role: "owner", TenantID: uuid(input.TenantID), SpaceID: space.ID, EpisodeID: episode.ID, AccountID: uuid(input.AccountID)})
		if err != nil {
			return fmt.Errorf("create dashboard participant: %w", err)
		}
		intentID, err := utilities.NewID()
		if err != nil {
			return err
		}
		journey, err := lifecycleJourneyFromContext(ctx)
		if err != nil {
			return err
		}
		if err := persistLifecycleJourneyRoot(ctx, tx, journey, "participant.dashboard_joined"); err != nil {
			return err
		}
		intent, err := queries.CreateLifecycleIntent(ctx, sqlc.CreateLifecycleIntentParams{TenantID: uuid(input.TenantID), SpaceID: space.ID, EpisodeID: episode.ID, LifecycleIntentID: uuid(intentID), RequestKey: input.Request.Key, RequestFingerprint: input.Request.Fingerprint[:], IntentName: episodes.IntentParticipantJoined, ParticipantID: uuid(participantID), ParticipantGeneration: pgtype.Int8{Int64: participant.Generation, Valid: true}, Payload: jsonBytes(payload), JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID), ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID)})
		if err != nil {
			return fmt.Errorf("create dashboard participant intent: %w", err)
		}
		result = episodes.SelfJoinResult{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent)}
		return nil
	})
	if err != nil {
		return episodes.SelfJoinResult{}, err
	}
	commitMetric.Record(ctx)
	return result, nil
}

func (r EpisodeLifecycleRepository) FindSelf(ctx context.Context, input episodes.SelfAccessInput) (episodes.SelfJoinResult, error) {
	var result episodes.SelfJoinResult
	err := r.transaction(ctx, func(queries *sqlc.Queries, _ pgx.Tx) error {
		space, err := queries.LockTenantSpaceBySlugForUpdate(ctx, sqlc.LockTenantSpaceBySlugForUpdateParams{TenantID: uuid(input.TenantID), Slug: input.SpaceSlug})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrSpaceNotFound
		}
		if err != nil {
			return err
		}
		if space.ArchivedAt.Valid {
			return episodes.ErrAdmissionClosed
		}
		episode, err := queries.LockLiveEpisodeForUpdate(ctx, sqlc.LockLiveEpisodeForUpdateParams{TenantID: uuid(input.TenantID), SpaceID: space.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrEpisodeNotFound
		}
		if err != nil {
			return err
		}
		if episode.Status != episodes.EpisodeStatusActive {
			return episodes.ErrEpisodeNotActive
		}
		participant, err := queries.LockDashboardParticipantForUpdate(ctx, sqlc.LockDashboardParticipantForUpdateParams{TenantID: uuid(input.TenantID), SpaceID: space.ID, EpisodeID: episode.ID, AccountID: uuid(input.AccountID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrParticipantNotFound
		}
		if err != nil {
			return err
		}
		intent, err := queries.LockDashboardJoinIntentForUpdate(ctx, sqlc.LockDashboardJoinIntentForUpdateParams{TenantID: uuid(input.TenantID), SpaceID: space.ID, EpisodeID: episode.ID, ParticipantID: participant.ID})
		if err != nil {
			return err
		}
		if participant.Status == episodes.ParticipantStatusLeft || participant.Status == episodes.ParticipantStatusLeaving {
			return episodes.ErrParticipantNotActive
		}
		result = episodes.SelfJoinResult{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent)}
		return nil
	})
	return result, err
}

func (r EpisodeLifecycleRepository) LeaveSelf(ctx context.Context, input episodes.SelfLeaveInput) (episodes.SelfLeaveResult, error) {
	var result episodes.SelfLeaveResult
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		space, err := queries.LockTenantSpaceBySlugForUpdate(ctx, sqlc.LockTenantSpaceBySlugForUpdateParams{TenantID: uuid(input.TenantID), Slug: input.SpaceSlug})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrSpaceNotFound
		}
		if err != nil {
			return err
		}
		participant, err := queries.LockLatestDashboardParticipantForUpdate(ctx, sqlc.LockLatestDashboardParticipantForUpdateParams{TenantID: uuid(input.TenantID), SpaceID: space.ID, AccountID: uuid(input.AccountID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, utilities.IDFromBytes(space.ID.Bytes), utilities.IDFromBytes(participant.EpisodeID.Bytes))
		if errors.Is(err, episodes.ErrEpisodeNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		mappedParticipant := mapLifecycleParticipant(participant)
		result = episodes.SelfLeaveResult{Episode: mapLifecycleEpisode(episode), Participant: mappedParticipant}
		if participant.Status == episodes.ParticipantStatusLeft || participant.Status == episodes.ParticipantStatusLeaving || episode.Status != episodes.EpisodeStatusActive {
			return nil
		}
		if input.ParticipantGeneration > 0 && participant.Generation != input.ParticipantGeneration {
			return episodes.ErrParticipantGenerationMismatch
		}
		operation, err := lockTenantExternalOperation(ctx, queries, input.TenantID, utilities.IDFromBytes(space.ID.Bytes), utilities.IDFromBytes(participant.EpisodeID.Bytes), episodes.OperationRemoveParticipant, input.Request)
		if err == nil {
			result.Removed = true
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		operation, updated, err := createParticipantRemovalOperation(ctx, queries, tx, tenantExternalOperationInput{TenantID: input.TenantID, SpaceID: utilities.IDFromBytes(space.ID.Bytes), EpisodeID: utilities.IDFromBytes(participant.EpisodeID.Bytes), OperationName: episodes.OperationRemoveParticipant, Request: input.Request, TargetParticipantID: mappedParticipant.ID, TargetParticipantGeneration: mappedParticipant.Generation, JourneyName: "participant.dashboard_leave_requested", Payload: input.Request.Payload()}, participant)
		if err != nil {
			return err
		}
		_ = operation
		result.Participant = mapLifecycleParticipant(updated)
		result.Removed = true
		return nil
	})
	return result, err
}

var _ episodes.SelfJoinRepository = EpisodeLifecycleRepository{}
