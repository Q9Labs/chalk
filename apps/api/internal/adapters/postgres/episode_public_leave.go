package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

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
		// Sync locks the control row before the Episode; lock in that order so the two cannot wait on each other.
		if _, err := lockLifecycleControlRow(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID); err != nil {
			return err
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
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "55P03" {
		return result, fmt.Errorf("%w: %w", publicinvites.ErrAccessUnavailable, err)
	}
	return result, err
}
