package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/publicinvites"
)

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
