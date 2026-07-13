package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
)

func (r SessionLifecycleRepository) RequestParticipantRemoval(ctx context.Context, input sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error) {
	var result sessionlifecycle.Removal

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		operation, err := lockTenantExternalOperation(ctx, queries, input.TenantID, input.RoomID, input.SessionID, sessionlifecycle.OperationRemoveParticipant, input.Request)
		if err == nil {
			session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
			if err != nil {
				return err
			}
			participant, err := lockLifecycleParticipant(ctx, queries, input.TenantID, input.RoomID, input.SessionID, nullableID(operation.TargetParticipantSessionID))
			if err != nil {
				return err
			}
			result = sessionlifecycle.Removal{Session: mapLifecycleSession(session), Participant: mapLifecycleParticipant(participant), Intent: mapExternalOperationIntent(operation)}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
		if err != nil {
			return err
		}
		if session.Status != sessionlifecycle.SessionStatusActive {
			return sessionlifecycle.ErrSessionNotActive
		}

		participant, err := lockLifecycleParticipant(ctx, queries, input.TenantID, input.RoomID, input.SessionID, input.ParticipantID)
		if err != nil {
			return err
		}
		if err := validateRemovalTarget(participant, input.ParticipantGeneration); err != nil {
			return err
		}

		operation, participant, err = createParticipantRemovalOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: input.TenantID, RoomID: input.RoomID, SessionID: input.SessionID,
			OperationName: sessionlifecycle.OperationRemoveParticipant, Request: input.Request,
			TargetParticipantID: input.ParticipantID, TargetParticipantGeneration: input.ParticipantGeneration,
			JourneyName: "participant.removal_requested", Payload: input.Request.Payload(),
		}, participant)
		if err != nil {
			return err
		}

		result = sessionlifecycle.Removal{
			Session:     mapLifecycleSession(session),
			Participant: mapLifecycleParticipant(participant),
			Intent:      mapExternalOperationIntent(operation),
		}
		return nil
	})
	if err != nil {
		return sessionlifecycle.Removal{}, err
	}

	return result, nil
}

func (r SessionLifecycleRepository) RequestSessionEnd(ctx context.Context, input sessionlifecycle.RequestSessionEndInput) (sessionlifecycle.EndRequest, error) {
	var result sessionlifecycle.EndRequest

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		operation, err := lockTenantExternalOperation(ctx, queries, input.TenantID, input.RoomID, input.SessionID, sessionlifecycle.OperationTenantEndSession, input.Request)
		if err == nil {
			session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
			if err != nil {
				return err
			}
			result = sessionlifecycle.EndRequest{Session: mapLifecycleSession(session), Intent: mapExternalOperationIntent(operation)}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}

		session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
		if err != nil {
			return err
		}
		if session.Status != sessionlifecycle.SessionStatusActive {
			return sessionlifecycle.ErrSessionNotActive
		}

		operation, err = createEndReadyOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: input.TenantID, RoomID: input.RoomID, SessionID: input.SessionID,
			OperationName: sessionlifecycle.OperationTenantEndSession, Request: input.Request,
			JourneyName: "session.tenant_end_requested", Payload: input.Request.Payload(),
		})
		if err != nil {
			return err
		}
		session, err = lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
		if err != nil {
			return err
		}
		result = sessionlifecycle.EndRequest{Session: mapLifecycleSession(session), Intent: mapExternalOperationIntent(operation)}
		return nil
	})
	if err != nil {
		return sessionlifecycle.EndRequest{}, err
	}

	return result, nil
}

func validateRemovalTarget(participant sqlc.Participant, generation int64) error {
	if participant.Generation != generation {
		return sessionlifecycle.ErrParticipantGenerationMismatch
	}
	if participant.Status != sessionlifecycle.ParticipantStatusActive {
		return sessionlifecycle.ErrParticipantNotActive
	}

	return nil
}
