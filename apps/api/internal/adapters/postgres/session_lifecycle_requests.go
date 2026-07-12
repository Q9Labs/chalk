package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r SessionLifecycleRepository) RequestParticipantRemoval(ctx context.Context, input sessionlifecycle.RequestParticipantRemovalInput) (sessionlifecycle.Removal, error) {
	var result sessionlifecycle.Removal

	err := r.transaction(ctx, func(queries *sqlc.Queries) error {
		if err := lockLifecycleControl(ctx, queries, input.TenantID, input.RoomID, input.SessionID); err != nil {
			return err
		}

		intent, err := queries.LockLifecycleIntentForRequestForUpdate(ctx, removalIntentRequestParams(input))
		if err == nil {
			return resolveRemovalRetry(ctx, queries, input, intent, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock participant removal intent: %w", err)
		}

		intent, err = queries.LockLifecycleIntentForParticipantTransitionForUpdate(ctx, sqlc.LockLifecycleIntentForParticipantTransitionForUpdateParams{
			TenantID:                     uuid(input.TenantID),
			RoomID:                       uuid(input.RoomID),
			SessionID:                    uuid(input.SessionID),
			IntentName:                   sessionlifecycle.IntentParticipantLeft,
			ParticipantSessionID:         uuid(input.ParticipantID),
			ParticipantSessionGeneration: pgtype.Int8{Int64: input.ParticipantGeneration, Valid: true},
		})
		if err == nil {
			return resolveRemovalRetry(ctx, queries, input, intent, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock participant removal transition: %w", err)
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

		payload := input.Request.Payload()
		if _, err := queries.ReserveParticipantRemoval(ctx, sqlc.ReserveParticipantRemovalParams{
			IntentPayloadBytes: int64(len(payload)),
			ReservationBytes:   sessionlifecycle.LifecycleReservationBytes,
			TenantID:           uuid(input.TenantID),
			RoomID:             uuid(input.RoomID),
			SessionID:          uuid(input.SessionID),
		}); errors.Is(err, pgx.ErrNoRows) {
			return sessionlifecycle.ErrCapacityExceeded
		} else if err != nil {
			return fmt.Errorf("reserve participant removal capacity: %w", err)
		}

		participant, err = queries.MarkLifecycleParticipantLeaving(ctx, sqlc.MarkLifecycleParticipantLeavingParams{
			TenantID:                     uuid(input.TenantID),
			RoomID:                       uuid(input.RoomID),
			SessionID:                    uuid(input.SessionID),
			ParticipantSessionID:         uuid(input.ParticipantID),
			ParticipantSessionGeneration: input.ParticipantGeneration,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionlifecycle.ErrParticipantNotActive
		}
		if err != nil {
			return fmt.Errorf("mark lifecycle participant leaving: %w", err)
		}

		intentID, err := utilities.NewID()
		if err != nil {
			return fmt.Errorf("create lifecycle intent id: %w", err)
		}
		intent, err = queries.CreateLifecycleIntent(ctx, sqlc.CreateLifecycleIntentParams{
			TenantID:                     uuid(input.TenantID),
			RoomID:                       uuid(input.RoomID),
			SessionID:                    uuid(input.SessionID),
			LifecycleIntentID:            uuid(intentID),
			RequestKey:                   input.Request.Key,
			RequestFingerprint:           input.Request.Fingerprint[:],
			IntentName:                   sessionlifecycle.IntentParticipantLeft,
			ParticipantSessionID:         uuid(input.ParticipantID),
			ParticipantSessionGeneration: pgtype.Int8{Int64: input.ParticipantGeneration, Valid: true},
			Payload:                      jsonBytes(payload),
		})
		if err != nil {
			return fmt.Errorf("create participant removal intent: %w", err)
		}

		result = sessionlifecycle.Removal{
			Session:     mapLifecycleSession(session),
			Participant: mapLifecycleParticipant(participant),
			Intent:      mapLifecycleIntent(intent),
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

	err := r.transaction(ctx, func(queries *sqlc.Queries) error {
		if err := lockLifecycleControl(ctx, queries, input.TenantID, input.RoomID, input.SessionID); err != nil {
			return err
		}

		intent, err := queries.LockLifecycleIntentForRequestForUpdate(ctx, sessionEndIntentRequestParams(input))
		if err == nil {
			return resolveSessionEndRetry(ctx, queries, input, intent, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock session end intent: %w", err)
		}

		intent, err = queries.LockSessionEndLifecycleIntentForUpdate(ctx, sqlc.LockSessionEndLifecycleIntentForUpdateParams{
			TenantID:  uuid(input.TenantID),
			RoomID:    uuid(input.RoomID),
			SessionID: uuid(input.SessionID),
		})
		if err == nil {
			return resolveSessionEndRetry(ctx, queries, input, intent, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock session end transition: %w", err)
		}

		session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
		if err != nil {
			return err
		}
		if session.Status != sessionlifecycle.SessionStatusActive {
			return sessionlifecycle.ErrSessionNotActive
		}

		payload := input.Request.Payload()
		if _, err := queries.ReserveSessionEnd(ctx, sqlc.ReserveSessionEndParams{
			IntentPayloadBytes: int64(len(payload)),
			ReservationBytes:   sessionlifecycle.LifecycleReservationBytes,
			TenantID:           uuid(input.TenantID),
			RoomID:             uuid(input.RoomID),
			SessionID:          uuid(input.SessionID),
		}); errors.Is(err, pgx.ErrNoRows) {
			return sessionlifecycle.ErrCapacityExceeded
		} else if err != nil {
			return fmt.Errorf("reserve session end capacity: %w", err)
		}

		session, err = queries.MarkLifecycleSessionEnding(ctx, sqlc.MarkLifecycleSessionEndingParams{
			TenantID:  uuid(input.TenantID),
			RoomID:    uuid(input.RoomID),
			SessionID: uuid(input.SessionID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionlifecycle.ErrSessionNotActive
		}
		if err != nil {
			return fmt.Errorf("mark lifecycle session ending: %w", err)
		}

		intentID, err := utilities.NewID()
		if err != nil {
			return fmt.Errorf("create lifecycle intent id: %w", err)
		}
		intent, err = queries.CreateLifecycleIntent(ctx, sqlc.CreateLifecycleIntentParams{
			TenantID:           uuid(input.TenantID),
			RoomID:             uuid(input.RoomID),
			SessionID:          uuid(input.SessionID),
			LifecycleIntentID:  uuid(intentID),
			RequestKey:         input.Request.Key,
			RequestFingerprint: input.Request.Fingerprint[:],
			IntentName:         sessionlifecycle.IntentSessionEnded,
			Payload:            jsonBytes(payload),
		})
		if err != nil {
			return fmt.Errorf("create session end intent: %w", err)
		}

		result = sessionlifecycle.EndRequest{
			Session: mapLifecycleSession(session),
			Intent:  mapLifecycleIntent(intent),
		}
		return nil
	})
	if err != nil {
		return sessionlifecycle.EndRequest{}, err
	}

	return result, nil
}

func resolveRemovalRetry(ctx context.Context, queries *sqlc.Queries, input sessionlifecycle.RequestParticipantRemovalInput, intent sqlc.SyncLifecycleIntent, result *sessionlifecycle.Removal) error {
	if intent.RequestKey == input.Request.Key {
		if err := idempotencyConflict(intent, input.Request); err != nil {
			return err
		}
	}

	session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
	if err != nil {
		return err
	}
	participant, err := lockLifecycleParticipant(ctx, queries, input.TenantID, input.RoomID, input.SessionID, nullableID(intent.ParticipantSessionID))
	if err != nil {
		return err
	}

	*result = sessionlifecycle.Removal{
		Session:     mapLifecycleSession(session),
		Participant: mapLifecycleParticipant(participant),
		Intent:      mapLifecycleIntent(intent),
	}
	return nil
}

func resolveSessionEndRetry(ctx context.Context, queries *sqlc.Queries, input sessionlifecycle.RequestSessionEndInput, intent sqlc.SyncLifecycleIntent, result *sessionlifecycle.EndRequest) error {
	if intent.RequestKey == input.Request.Key {
		if err := idempotencyConflict(intent, input.Request); err != nil {
			return err
		}
	}

	session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
	if err != nil {
		return err
	}

	*result = sessionlifecycle.EndRequest{
		Session: mapLifecycleSession(session),
		Intent:  mapLifecycleIntent(intent),
	}
	return nil
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

func removalIntentRequestParams(input sessionlifecycle.RequestParticipantRemovalInput) sqlc.LockLifecycleIntentForRequestForUpdateParams {
	return sqlc.LockLifecycleIntentForRequestForUpdateParams{
		TenantID:   uuid(input.TenantID),
		RoomID:     uuid(input.RoomID),
		SessionID:  uuid(input.SessionID),
		IntentName: sessionlifecycle.IntentParticipantLeft,
		RequestKey: input.Request.Key,
	}
}

func sessionEndIntentRequestParams(input sessionlifecycle.RequestSessionEndInput) sqlc.LockLifecycleIntentForRequestForUpdateParams {
	return sqlc.LockLifecycleIntentForRequestForUpdateParams{
		TenantID:   uuid(input.TenantID),
		RoomID:     uuid(input.RoomID),
		SessionID:  uuid(input.SessionID),
		IntentName: sessionlifecycle.IntentSessionEnded,
		RequestKey: input.Request.Key,
	}
}
