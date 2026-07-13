package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func (r SessionLifecycleRepository) CreateSession(ctx context.Context, input sessionlifecycle.CreateSessionInput) (sessionlifecycle.Session, error) {
	var result sessionlifecycle.Session
	var commitMetric webhookCommitMetric

	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		request, err := queries.ReserveSessionCreateRequest(ctx, sqlc.ReserveSessionCreateRequestParams{
			TenantID:           uuid(input.TenantID),
			RoomID:             uuid(input.RoomID),
			RequestKey:         input.Request.Key,
			RequestFingerprint: input.Request.Fingerprint[:],
			SessionID:          uuid(input.ID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			request, err = queries.GetSessionCreateRequest(ctx, sqlc.GetSessionCreateRequestParams{
				TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), RequestKey: input.Request.Key,
			})
			if err != nil {
				return fmt.Errorf("read session create request: %w", err)
			}
			if !bytes.Equal(request.RequestFingerprint, input.Request.Fingerprint[:]) {
				return sessionlifecycle.ErrIdempotencyConflict
			}
			session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, utilities.IDFromBytes(request.SessionID.Bytes))
			if err != nil {
				return err
			}
			result = mapLifecycleSession(session)
			return nil
		}
		if err != nil {
			return fmt.Errorf("reserve session create request: %w", err)
		}

		session, err := queries.CreateLifecycleRoomSession(ctx, sqlc.CreateLifecycleRoomSessionParams{
			ID:              uuid(input.ID),
			Metadata:        jsonBytes(input.Metadata),
			CreatedByUserID: uuid(input.CreatedByUserID),
			StartedAt:       timestamptz(input.StartedAt),
			TenantID:        uuid(input.TenantID),
			RoomID:          uuid(input.RoomID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionlifecycle.ErrRoomNotFound
		}
		if uniqueConstraintViolation(err, "room_sessions_pkey") {
			return sessionlifecycle.ErrSessionAlreadyExists
		}
		if err != nil {
			return fmt.Errorf("create lifecycle room session: %w", err)
		}

		if _, err := queries.CreateSyncSessionControl(ctx, sqlc.CreateSyncSessionControlParams{
			TenantID:           uuid(input.TenantID),
			RoomID:             uuid(input.RoomID),
			SessionID:          uuid(input.ID),
			FoldedState:        jsonBytes(input.InitialControl.FoldedState),
			StateSchemaVersion: input.InitialControl.SchemaVersion,
			StateDigest:        input.InitialControl.Digest[:],
			SnapshotBytes:      input.InitialControl.SnapshotBytes,
		}); err != nil {
			return fmt.Errorf("create lifecycle control: %w", err)
		}
		snapshot := webhooks.SessionSnapshot{ID: input.ID.String(), RoomID: input.RoomID.String(), Status: session.Status, StartedAt: nullableTimestamp(session.StartedAt), EndedAt: nullableTimestamp(session.EndedAt), CreatedAt: timestamp(session.CreatedAt), UpdatedAt: timestamp(session.UpdatedAt)}
		occurredAt := timestamp(session.CreatedAt)
		if session.StartedAt.Valid {
			occurredAt = timestamp(session.StartedAt)
		}
		commitMetric, err = fanoutWebhookEvent(ctx, tx, webhookProduction{TenantID: input.TenantID, EventName: "session.started", SemanticKey: "session:" + input.ID.String() + ":started", ResourceType: "session", ResourceID: input.ID, OccurredAt: occurredAt, Body: func(metadata webhooks.EventMetadata) ([]byte, [32]byte, error) {
			return webhooks.EncodeSessionEvent(metadata, snapshot)
		}})
		if err != nil {
			return fmt.Errorf("produce session.started webhook: %w", err)
		}

		result = mapLifecycleSession(session)
		return nil
	})
	if err != nil {
		return sessionlifecycle.Session{}, err
	}

	commitMetric.Record(ctx)
	return result, nil
}

func (r SessionLifecycleRepository) AdmitParticipant(ctx context.Context, input sessionlifecycle.AdmitParticipantInput) (sessionlifecycle.Admission, error) {
	var result sessionlifecycle.Admission

		if err := lockLifecycleControl(ctx, queries, input.TenantID, input.RoomID, input.SessionID); err != nil {
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
			return err
		}
		intent, err := queries.LockLifecycleIntentForRequestForUpdate(ctx, lifecycleIntentRequestParams(input, sessionlifecycle.IntentParticipantJoined))
		if err == nil {
			return resolveAdmissionRetry(ctx, queries, input, intent, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock participant admission intent: %w", err)
		}

		session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
		if err != nil {
			return err
		}
		if session.Status != sessionlifecycle.SessionStatusActive {
			return sessionlifecycle.ErrSessionNotActive
		}

		payload := input.Request.Payload()
		if _, err := queries.ReserveParticipantAdmission(ctx, sqlc.ReserveParticipantAdmissionParams{
			SnapshotReservationBytes: sessionlifecycle.ParticipantSnapshotReservationBytes,
			ReservationBytes:         sessionlifecycle.LifecycleReservationBytes,
			IntentPayloadBytes:       int64(len(payload)),
			MaxActiveParticipants:    sessionlifecycle.MaximumActiveParticipantSessions,
			TenantID:                 uuid(input.TenantID),
			RoomID:                   uuid(input.RoomID),
			SessionID:                uuid(input.SessionID),
		}); errors.Is(err, pgx.ErrNoRows) {
			return sessionlifecycle.ErrCapacityExceeded
		} else if err != nil {
			return fmt.Errorf("reserve participant admission capacity: %w", err)
		}

		participant, err := queries.CreateLifecycleParticipant(ctx, sqlc.CreateLifecycleParticipantParams{
			ID:           uuid(input.ParticipantID),
			Name:         pgtype.Text{String: input.Name, Valid: true},
			Metadata:     jsonBytes(input.Metadata),
			Capabilities: input.Capabilities,
			TenantID:     uuid(input.TenantID),
			RoomID:       uuid(input.RoomID),
			SessionID:    uuid(input.SessionID),
			UserID:       uuid(input.UserID),
		})
		if err != nil {
			return fmt.Errorf("create lifecycle participant: %w", err)
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
			IntentName:                   sessionlifecycle.IntentParticipantJoined,
			ParticipantSessionID:         uuid(input.ParticipantID),
			ParticipantSessionGeneration: pgtype.Int8{Int64: participant.Generation, Valid: true},
			Payload:                      jsonBytes(payload),
		})
		if err != nil {
			return fmt.Errorf("create participant admission intent: %w", err)
		}

		result = sessionlifecycle.Admission{
			Session:     mapLifecycleSession(session),
			Participant: mapLifecycleParticipant(participant),
			Intent:      mapLifecycleIntent(intent),
		}
		return nil
	})
	if err != nil {
		return sessionlifecycle.Admission{}, err
	}

	return result, nil
}

func resolveAdmissionRetry(ctx context.Context, queries *sqlc.Queries, input sessionlifecycle.AdmitParticipantInput, intent sqlc.SyncLifecycleIntent, result *sessionlifecycle.Admission) error {
	if err := idempotencyConflict(intent, input.Request); err != nil {
		return err
	}

	session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
	if err != nil {
		return err
	}
	participant, err := lockLifecycleParticipant(ctx, queries, input.TenantID, input.RoomID, input.SessionID, nullableID(intent.ParticipantSessionID))
	if err != nil {
		return err
	}

	*result = sessionlifecycle.Admission{
		Session:     mapLifecycleSession(session),
		Participant: mapLifecycleParticipant(participant),
		Intent:      mapLifecycleIntent(intent),
	}
	return nil
}

func lifecycleIntentRequestParams(input sessionlifecycle.AdmitParticipantInput, intentName string) sqlc.LockLifecycleIntentForRequestForUpdateParams {
	return sqlc.LockLifecycleIntentForRequestForUpdateParams{
		TenantID:   uuid(input.TenantID),
		RoomID:     uuid(input.RoomID),
		SessionID:  uuid(input.SessionID),
		IntentName: intentName,
		RequestKey: input.Request.Key,
	}
}
