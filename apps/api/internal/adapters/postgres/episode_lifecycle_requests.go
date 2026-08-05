package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

func (r EpisodeLifecycleRepository) RequestParticipantRemoval(ctx context.Context, input episodes.RequestParticipantRemovalInput) (episodes.Removal, error) {
	var result episodes.Removal

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		operation, err := lockTenantExternalOperation(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID, episodes.OperationRemoveParticipant, input.Request)
		if err == nil {
			episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID)
			if err != nil {
				return err
			}
			participant, err := lockLifecycleParticipant(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID, nullableID(operation.TargetParticipantID))
			if err != nil {
				return err
			}
			result = episodes.Removal{Episode: mapLifecycleEpisode(episode), Participant: mapLifecycleParticipant(participant), Intent: mapExternalOperationIntent(operation)}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
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
		if err := validateRemovalTarget(participant, input.ParticipantGeneration); err != nil {
			return err
		}

		operation, participant, err = createParticipantRemovalOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: input.EpisodeID,
			OperationName: episodes.OperationRemoveParticipant, Request: input.Request,
			TargetParticipantID: input.ParticipantID, TargetParticipantGeneration: input.ParticipantGeneration,
			JourneyName: "participant.removal_requested", Payload: input.Request.Payload(),
		}, participant)
		if err != nil {
			return err
		}

		result = episodes.Removal{
			Episode:     mapLifecycleEpisode(episode),
			Participant: mapLifecycleParticipant(participant),
			Intent:      mapExternalOperationIntent(operation),
		}
		return nil
	})
	if err != nil {
		return episodes.Removal{}, err
	}

	return result, nil
}

func (r EpisodeLifecycleRepository) RequestEpisodeEnd(ctx context.Context, input episodes.RequestEpisodeEndInput) (episodes.EndRequest, error) {
	var result episodes.EndRequest

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		operation, err := lockTenantExternalOperation(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID, episodes.OperationTenantEndEpisode, input.Request)
		if err == nil {
			episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID)
			if err != nil {
				return err
			}
			result = episodes.EndRequest{Episode: mapLifecycleEpisode(episode), Intent: mapExternalOperationIntent(operation)}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		episode, err := lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID)
		if err != nil {
			return err
		}
		if episode.Status != episodes.EpisodeStatusActive {
			return episodes.ErrEpisodeNotActive
		}

		operation, err = createEndReadyOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: input.TenantID, SpaceID: input.SpaceID, EpisodeID: input.EpisodeID,
			OperationName: episodes.OperationTenantEndEpisode, Request: input.Request,
			JourneyName: "episode.tenant_end_requested", Payload: input.Request.Payload(),
		})
		if err != nil {
			return err
		}
		episode, err = lockLifecycleEpisode(ctx, queries, input.TenantID, input.SpaceID, input.EpisodeID)
		if err != nil {
			return err
		}
		result = episodes.EndRequest{Episode: mapLifecycleEpisode(episode), Intent: mapExternalOperationIntent(operation)}
		return nil
	})
	if err != nil {
		return episodes.EndRequest{}, err
	}

	return result, nil
}

func validateRemovalTarget(participant sqlc.Participant, generation int64) error {
	if participant.Generation != generation {
		return episodes.ErrParticipantGenerationMismatch
	}
	if participant.Status != episodes.ParticipantStatusActive {
		return episodes.ErrParticipantNotActive
	}

	return nil
}
