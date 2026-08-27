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
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r EpisodeLifecycleRepository) JoinPublic(ctx context.Context, input episodes.PublicJoinInput) (episodes.PublicJoinResult, error) {
	var result episodes.PublicJoinResult
	var commitMetric webhookCommitMetric
	var episodeCreated bool

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		space, err := queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(input.TenantID), ID: uuid(input.SpaceID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrSpaceNotFound
		}
		if err != nil {
			return fmt.Errorf("lock public invite Space: %w", err)
		}
		if space.ArchivedAt.Valid {
			return episodes.ErrAdmissionClosed
		}

		episode, created, metric, err := ensurePublicLiveEpisode(ctx, queries, tx, input.TenantID, input.SpaceID, space)
		if err != nil {
			return err
		}
		episodeCreated = created
		commitMetric = metric
		if episode.Status != episodes.EpisodeStatusActive {
			return episodes.ErrEpisodeNotActive
		}
		if _, err := lockLifecycleControlRow(ctx, queries, input.TenantID, input.SpaceID, utilities.IDFromBytes(episode.ID.Bytes)); err != nil {
			return err
		}

		intent, err := queries.LockLifecycleIntentForRequestForUpdate(ctx, sqlc.LockLifecycleIntentForRequestForUpdateParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID,
			IntentName: episodes.IntentParticipantJoined, RequestKey: input.Request.Key,
		})
		if err == nil {
			if err := idempotencyConflict(intent, input.Request); err != nil {
				return err
			}
			participant, participantErr := lockLifecycleParticipant(ctx, queries, input.TenantID, input.SpaceID, utilities.IDFromBytes(episode.ID.Bytes), nullableID(intent.ParticipantID))
			if participantErr != nil {
				return participantErr
			}
			if participant.Status == episodes.ParticipantStatusLeft || participant.Status == episodes.ParticipantStatusLeaving {
				return episodes.ErrParticipantNotActive
			}
			result = episodes.PublicJoinResult{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent), EpisodeCreated: episodeCreated}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock public join intent: %w", err)
		}

		var participant sqlc.Participant
		if input.IdentityMode == "account" {
			participant, err = queries.LockDashboardParticipantForUpdate(ctx, sqlc.LockDashboardParticipantForUpdateParams{
				TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID, AccountID: uuid(input.AccountID),
			})
			if err == nil {
				if participant.Status == episodes.ParticipantStatusLeft || participant.Status == episodes.ParticipantStatusLeaving {
					return episodes.ErrParticipantNotActive
				}
				existingIntent, intentErr := queries.LockDashboardJoinIntentForUpdate(ctx, sqlc.LockDashboardJoinIntentForUpdateParams{
					TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID, ParticipantID: participant.ID,
				})
				if intentErr == nil {
					result = episodes.PublicJoinResult{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(existingIntent), EpisodeCreated: episodeCreated}
					return nil
				}
				if !errors.Is(intentErr, pgx.ErrNoRows) {
					return fmt.Errorf("lock existing public account join intent: %w", intentErr)
				}
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("lock public account participant: %w", err)
			}
		}

		config, err := episodeConfig(episode.ConfigSnapshot)
		if err != nil {
			return err
		}
		capabilities, ok := config.Roles[input.Role]
		if !ok {
			return episodes.ErrInvalidRole
		}
		participantID, err := utilities.NewID()
		if err != nil {
			return fmt.Errorf("create public participant id: %w", err)
		}
		payload := episodes.ParticipantJoinedPayload(participantID, input.DisplayName, input.Role)
		if _, err := queries.ReserveParticipantAdmission(ctx, sqlc.ReserveParticipantAdmissionParams{
			SnapshotReservationBytes: episodes.ParticipantSnapshotReservationBytes,
			ReservationBytes:         episodes.LifecycleReservationBytes,
			IntentPayloadBytes:       int64(len(payload)),
			MaxActiveParticipants:    episodes.MaximumActiveParticipants,
			TenantID:                 uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID,
		}); errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrCapacityExceeded
		} else if err != nil {
			return fmt.Errorf("reserve public participant capacity: %w", err)
		}
		if input.IdentityMode == "account" {
			participant, err = queries.CreateDashboardLifecycleParticipant(ctx, sqlc.CreateDashboardLifecycleParticipantParams{
				ID: uuid(participantID), Name: pgtype.Text{String: input.DisplayName, Valid: true},
				Capabilities: append([]string(nil), capabilities...), Role: input.Role,
				TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID, AccountID: uuid(input.AccountID),
			})
		} else {
			participant, err = queries.CreateLifecycleParticipant(ctx, sqlc.CreateLifecycleParticipantParams{
				ID: uuid(participantID), Name: pgtype.Text{String: input.DisplayName, Valid: true},
				Capabilities: append([]string(nil), capabilities...), Role: input.Role,
				TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID,
			})
		}
		if err != nil {
			return fmt.Errorf("create public participant: %w", err)
		}
		intentID, err := utilities.NewID()
		if err != nil {
			return fmt.Errorf("create public participant intent id: %w", err)
		}
		journey, err := lifecycleJourneyFromContext(ctx)
		if err != nil {
			return err
		}
		if err := persistLifecycleJourneyRoot(ctx, tx, journey, "participant.public_joined"); err != nil {
			return err
		}
		intent, err = queries.CreateLifecycleIntent(ctx, sqlc.CreateLifecycleIntentParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: episode.ID,
			LifecycleIntentID: uuid(intentID), RequestKey: input.Request.Key, RequestFingerprint: input.Request.Fingerprint[:],
			IntentName: episodes.IntentParticipantJoined, ParticipantID: uuid(participantID),
			ParticipantGeneration: pgtype.Int8{Int64: participant.Generation, Valid: true}, Payload: jsonBytes(payload),
			JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID),
			ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID),
		})
		if err != nil {
			return fmt.Errorf("create public participant intent: %w", err)
		}
		result = episodes.PublicJoinResult{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent), EpisodeCreated: episodeCreated}
		return nil
	})
	if err != nil {
		return episodes.PublicJoinResult{}, err
	}
	commitMetric.Record(ctx)
	return result, nil
}

func (r EpisodeLifecycleRepository) FindPublic(ctx context.Context, input episodes.PublicAccessInput) (episodes.PublicJoinResult, error) {
	var result episodes.PublicJoinResult
	err := r.transaction(ctx, func(queries *sqlc.Queries, _ pgx.Tx) error {
		_, err := queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(input.TenantID), ID: uuid(input.SpaceID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrSpaceNotFound
		}
		if err != nil {
			return fmt.Errorf("lock public access Space: %w", err)
		}
		episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID)
		if err != nil {
			return err
		}
		if episode.Status != episodes.EpisodeStatusActive {
			return episodes.ErrEpisodeNotActive
		}
		participant, err := lockLifecycleParticipant(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID, input.ParticipantID)
		if err != nil {
			return err
		}
		if participant.Generation != input.ParticipantGeneration {
			return episodes.ErrParticipantGenerationMismatch
		}
		if input.IdentityMode == "account" && nullableID(participant.AccountID) != input.AccountID {
			return episodes.ErrParticipantNotFound
		}
		if input.IdentityMode == "guest" && participant.AccountID.Valid {
			return episodes.ErrParticipantNotFound
		}
		if participant.Status == episodes.ParticipantStatusLeft || participant.Status == episodes.ParticipantStatusLeaving {
			return episodes.ErrParticipantNotActive
		}
		intent, err := queries.LockLifecycleIntentForParticipantTransitionForUpdate(ctx, sqlc.LockLifecycleIntentForParticipantTransitionForUpdateParams{
			TenantID: uuid(input.TenantID), SpaceID: uuid(input.SpaceID), EpisodeID: uuid(input.EpisodeID),
			IntentName: episodes.IntentParticipantJoined, ParticipantID: uuid(input.ParticipantID), ParticipantGeneration: pgtype.Int8{Int64: input.ParticipantGeneration, Valid: true},
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrPublicParticipantNotReady
		}
		if err != nil {
			return fmt.Errorf("lock public participant intent: %w", err)
		}
		result = episodes.PublicJoinResult{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent)}
		return nil
	})
	return result, err
}

func (r EpisodeLifecycleRepository) WaitPublicParticipantReady(ctx context.Context, key episodes.PublicParticipantKey) (episodes.PublicJoinResult, error) {
	var result episodes.PublicJoinResult
	err := r.transaction(ctx, func(queries *sqlc.Queries, _ pgx.Tx) error {
		_, err := queries.GetSyncTokenSubject(ctx, sqlc.GetSyncTokenSubjectParams{
			TenantID: uuid(key.TenantID), SpaceID: uuid(key.SpaceID), EpisodeID: uuid(key.EpisodeID), ParticipantID: uuid(key.ParticipantID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrPublicParticipantNotReady
		}
		if err != nil {
			return fmt.Errorf("read public participant readiness: %w", err)
		}
		episode, err := lockLifecycleEpisode(ctx, queries, key.TenantID, key.SpaceID, key.EpisodeID)
		if err != nil {
			return err
		}
		participant, err := lockLifecycleParticipant(ctx, queries, key.TenantID, key.SpaceID, key.EpisodeID, key.ParticipantID)
		if err != nil {
			return err
		}
		if participant.Generation != key.ParticipantGeneration {
			return episodes.ErrParticipantGenerationMismatch
		}
		intent, err := queries.LockLifecycleIntentForParticipantTransitionForUpdate(ctx, sqlc.LockLifecycleIntentForParticipantTransitionForUpdateParams{
			TenantID: uuid(key.TenantID), SpaceID: uuid(key.SpaceID), EpisodeID: uuid(key.EpisodeID), IntentName: episodes.IntentParticipantJoined,
			ParticipantID: uuid(key.ParticipantID), ParticipantGeneration: pgtype.Int8{Int64: key.ParticipantGeneration, Valid: true},
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrPublicParticipantNotReady
		}
		if err != nil {
			return fmt.Errorf("lock public readiness intent: %w", err)
		}
		result = episodes.PublicJoinResult{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapLifecycleIntent(intent)}
		return nil
	})
	return result, err
}

func (r EpisodeLifecycleRepository) LeavePublic(ctx context.Context, input episodes.PublicLeaveInput) (episodes.PublicLeaveResult, error) {
	var result episodes.PublicLeaveResult
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		_, err := queries.LockTenantSpaceForUpdate(ctx, sqlc.LockTenantSpaceForUpdateParams{TenantID: uuid(input.TenantID), ID: uuid(input.SpaceID)})
		if errors.Is(err, pgx.ErrNoRows) {
			return episodes.ErrSpaceNotFound
		}
		if err != nil {
			return fmt.Errorf("lock public leave Space: %w", err)
		}
		episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID)
		if err != nil {
			return err
		}
		participant, err := lockLifecycleParticipant(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID, input.ParticipantID)
		if err != nil {
			return err
		}
		if participant.Generation != input.ParticipantGeneration {
			return episodes.ErrParticipantGenerationMismatch
		}
		result = episodes.PublicLeaveResult{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant)}
		if participant.Status == episodes.ParticipantStatusLeft || participant.Status == episodes.ParticipantStatusLeaving {
			return nil
		}
		if episode.Status != episodes.EpisodeStatusActive {
			return episodes.ErrEpisodeNotActive
		}
		operation, updated, err := createParticipantRemovalOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: input.EpisodeID, OperationName: episodes.OperationRemoveParticipant,
			Request: input.Request, TargetParticipantID: input.ParticipantID, TargetParticipantGeneration: input.ParticipantGeneration,
			JourneyName: "participant.public_leave_requested", Payload: input.Request.Payload(),
		}, participant)
		if err != nil {
			return err
		}
		result.Participant = mapLifecycleParticipant(updated)
		result.Intent = mapExternalOperationIntent(operation)
		result.Removed = true
		return nil
	})
	return result, err
}

func ensurePublicLiveEpisode(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, tenantID, spaceID utilities.ID, space sqlc.Space) (sqlc.Episode, bool, webhookCommitMetric, error) {
	episode, err := queries.LockLiveEpisodeForUpdate(ctx, sqlc.LockLiveEpisodeForUpdateParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID)})
	if err == nil {
		return episode, false, webhookCommitMetric{}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return sqlc.Episode{}, false, webhookCommitMetric{}, fmt.Errorf("lock public live Episode: %w", err)
	}
	id, err := utilities.NewID()
	if err != nil {
		return sqlc.Episode{}, false, webhookCommitMetric{}, fmt.Errorf("create public Episode id: %w", err)
	}
	deadline := time.Now().UTC().Truncate(time.Millisecond).Add(time.Duration(space.DefaultEpisodeDurationSeconds) * time.Second)
	episode, err = queries.CreateLifecycleEpisode(ctx, sqlc.CreateLifecycleEpisodeParams{ID: uuid(id), TenantID: uuid(tenantID), SpaceID: uuid(spaceID), DeadlineAt: timestamptz(&deadline)})
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
	metric, err := fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: tenantID, EventName: "episode.started", SemanticKey: "episode:" + id.String() + ":started", ResourceType: "episode", ResourceID: id, OccurredAt: timestamp(episode.CreatedAt), Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
		return webhooks.EncodeEpisodeEvent(metadata, snapshot)
	}})
	if err != nil {
		return sqlc.Episode{}, false, webhookCommitMetric{}, fmt.Errorf("produce public Episode started webhook: %w", err)
	}
	return episode, true, metric, nil
}

var _ episodes.PublicJoinRepository = EpisodeLifecycleRepository{}
