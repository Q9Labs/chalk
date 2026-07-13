package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/sessionlifecycle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type tenantExternalOperationInput struct {
	TenantID                    utilities.ID
	RoomID                      utilities.ID
	SessionID                   utilities.ID
	OperationName               string
	Request                     sessionlifecycle.Request
	TargetParticipantID         utilities.ID
	TargetParticipantGeneration int64
	DeadlineGeneration          int64
	RecordingID                 utilities.ID
	FenceActive                 bool
	JourneyName                 string
	Payload                     []byte
}

func (r SessionLifecycleRepository) TransferHost(ctx context.Context, input sessionlifecycle.TransferHostInput) (sessionlifecycle.ControlRequest, error) {
	var result sessionlifecycle.ControlRequest
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		operation, err := lockTenantExternalOperation(ctx, queries, input.TenantID, input.RoomID, input.SessionID, sessionlifecycle.OperationTenantTransferHost, input.Request)
		if err == nil {
			return resolveControlRetry(ctx, queries, input.TenantID, input.RoomID, input.SessionID, operation, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		control, err := lockLifecycleControlRow(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
		if err != nil {
			return err
		}
		session, err := lockLifecycleSession(ctx, queries, input.TenantID, input.RoomID, input.SessionID)
		if err != nil {
			return err
		}
		if session.Status != sessionlifecycle.SessionStatusActive {
			return sessionlifecycle.ErrSessionNotActive
		}
		target, err := queries.LockHostRecoveryTarget(ctx, sqlc.LockHostRecoveryTargetParams{
			TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
			ParticipantSessionID: uuid(input.ParticipantID), ParticipantGeneration: input.ParticipantGeneration,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionlifecycle.ErrHostRecoveryTargetIneligible
		} else if err != nil {
			return fmt.Errorf("lock host recovery target: %w", err)
		}
		if nullableID(control.HostParticipantSessionID) == nullableID(target.ID) {
			return sessionlifecycle.ErrHostRecoveryTargetIneligible
		}
		operation, err = createTenantExternalOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: input.TenantID, RoomID: input.RoomID, SessionID: input.SessionID,
			OperationName: sessionlifecycle.OperationTenantTransferHost, Request: input.Request,
			TargetParticipantID: input.ParticipantID, TargetParticipantGeneration: input.ParticipantGeneration,
			JourneyName: "session.tenant_host_recovery_requested", Payload: input.Request.Payload(),
		})
		if err != nil {
			return err
		}
		result = sessionlifecycle.ControlRequest{Session: mapLifecycleSession(session), Operation: mapExternalOperation(operation)}
		return nil
	})
	return result, err
}

func (r SessionLifecycleRepository) SetDeadline(ctx context.Context, input sessionlifecycle.SetDeadlineInput) (sessionlifecycle.ControlRequest, error) {
	var result sessionlifecycle.ControlRequest
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		operation, err := lockTenantExternalOperation(ctx, queries, input.TenantID, input.RoomID, input.SessionID, sessionlifecycle.OperationTenantSetDeadline, input.Request)
		if err == nil {
			return resolveControlRetry(ctx, queries, input.TenantID, input.RoomID, input.SessionID, operation, &result)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		session, err := queries.LockDeadlineSessionForUpdate(ctx, sqlc.LockDeadlineSessionForUpdateParams{
			TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return sessionlifecycle.ErrSessionNotFound
		}
		if err != nil {
			return fmt.Errorf("lock deadline session: %w", err)
		}
		if session.Status != sessionlifecycle.SessionStatusActive {
			return sessionlifecycle.ErrSessionNotActive
		}
		if _, err := queries.LockPendingDeadlineOperation(ctx, sqlc.LockPendingDeadlineOperationParams{
			TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
		}); err == nil {
			return sessionlifecycle.ErrDeadlineChangePending
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("lock pending deadline operation: %w", err)
		}
		createdAt := timestamp(session.CreatedAt)
		minimum := createdAt.Add(time.Duration(sessionlifecycle.MinimumSessionDurationSeconds) * time.Second)
		ceiling := createdAt.Add(time.Duration(session.MaximumDurationCeilingSeconds) * time.Second)
		if input.Deadline.Before(minimum) {
			return sessionlifecycle.ErrInvalidDeadline
		}
		if input.Deadline.After(ceiling) {
			return sessionlifecycle.ErrDeadlineExceedsCeiling
		}
		generation := session.DeadlineGeneration + 1
		payload, err := json.Marshal(struct {
			DeadlineAtMillis   int64 `json:"deadlineAtMs"`
			DeadlineGeneration int64 `json:"deadlineGeneration"`
		}{DeadlineAtMillis: input.Deadline.UnixMilli(), DeadlineGeneration: generation})
		if err != nil {
			return fmt.Errorf("encode deadline operation payload: %w", err)
		}
		operation, err = createTenantExternalOperation(ctx, queries, tx, tenantExternalOperationInput{
			TenantID: input.TenantID, RoomID: input.RoomID, SessionID: input.SessionID,
			OperationName: sessionlifecycle.OperationTenantSetDeadline, Request: input.Request,
			DeadlineGeneration: generation, JourneyName: "session.tenant_deadline_requested", Payload: payload,
		})
		if err != nil {
			return err
		}
		result = sessionlifecycle.ControlRequest{Session: mapLifecycleSession(session), Operation: mapExternalOperation(operation)}
		return nil
	})
	return result, err
}

func (r SessionLifecycleRepository) EnqueueDueSessionDeadlines(ctx context.Context, batch int32) (int, error) {
	count := 0
	err := r.transaction(ctx, func(queries *sqlc.Queries, tx pgx.Tx) error {
		due, err := queries.ClaimDueSessionDeadlines(ctx, batch)
		if err != nil {
			return fmt.Errorf("claim due session deadlines: %w", err)
		}
		for _, row := range due {
			tenantID := utilities.IDFromBytes(row.TenantID.Bytes)
			roomID := utilities.IDFromBytes(row.RoomID.Bytes)
			sessionID := utilities.IDFromBytes(row.SessionID.Bytes)
			request, err := sessionlifecycle.NewMaximumDurationRequest(tenantID, roomID, sessionID, row.DeadlineGeneration)
			if err != nil {
				return err
			}
			if _, err := createEndReadyOperation(ctx, queries, tx, tenantExternalOperationInput{
				TenantID: tenantID, RoomID: roomID, SessionID: sessionID,
				OperationName: sessionlifecycle.OperationMaximumDurationExpired, Request: request,
				DeadlineGeneration: row.DeadlineGeneration, JourneyName: "session.maximum_duration_expired",
				Payload: request.Payload(),
			}); err != nil {
				return err
			}
			count++
		}
		return nil
	})
	return count, err
}

func lockTenantExternalOperation(ctx context.Context, queries *sqlc.Queries, tenantID, roomID, sessionID utilities.ID, operationName string, request sessionlifecycle.Request) (sqlc.SyncExternalOperation, error) {
	operation, err := queries.LockTenantExternalOperationForRequest(ctx, sqlc.LockTenantExternalOperationForRequestParams{
		TenantID: uuid(tenantID), RoomID: uuid(roomID), SessionID: uuid(sessionID), OperationName: operationName, RequestKey: request.Key,
	})
	if err != nil {
		return sqlc.SyncExternalOperation{}, err
	}
	if !bytes.Equal(operation.RequestFingerprint, request.Fingerprint[:]) {
		return sqlc.SyncExternalOperation{}, sessionlifecycle.ErrIdempotencyConflict
	}
	return operation, nil
}

func createTenantExternalOperation(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input tenantExternalOperationInput) (sqlc.SyncExternalOperation, error) {
	operationID, err := utilities.NewID()
	if err != nil {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("create tenant external operation id: %w", err)
	}
	journey, err := lifecycleJourneyFromContext(ctx)
	if err != nil {
		return sqlc.SyncExternalOperation{}, err
	}
	if err := persistLifecycleJourneyRoot(ctx, tx, journey, input.JourneyName); err != nil {
		return sqlc.SyncExternalOperation{}, err
	}
	operation, err := queries.CreateTenantExternalOperation(ctx, sqlc.CreateTenantExternalOperationParams{
		TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
		ExternalOperationID: uuid(operationID), RequestKey: input.Request.Key, RequestFingerprint: input.Request.Fingerprint[:],
		OperationName: input.OperationName, TargetParticipantSessionID: uuid(input.TargetParticipantID),
		TargetParticipantGeneration: optionalInt8(input.TargetParticipantGeneration), DeadlineGeneration: optionalInt8(input.DeadlineGeneration),
		RecordingID: uuid(input.RecordingID), FenceActive: input.FenceActive,
		JourneyID: uuid(journey.JourneyID), ParentJourneyEventID: uuid(journey.ParentEventID),
		ProducingTraceID: optionalText(journey.TraceID), ProducingSpanID: optionalText(journey.SpanID), Payload: jsonBytes(input.Payload),
	})
	if err != nil {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("create %s external operation: %w", input.OperationName, err)
	}
	return operation, nil
}

func createEndReadyOperation(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input tenantExternalOperationInput) (sqlc.SyncExternalOperation, error) {
	participants, err := queries.LockActiveParticipantsForTenantEnd(ctx, sqlc.LockActiveParticipantsForTenantEndParams{
		TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
	})
	if err != nil {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("lock active participants for tenant end: %w", err)
	}
	recordingID, err := queries.LockActiveRecordingForTenantEnd(ctx, sqlc.LockActiveRecordingForTenantEndParams{
		TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
	})
	if err == nil {
		input.RecordingID = nullableID(recordingID)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("lock active recording for tenant end: %w", err)
	}
	input.FenceActive = true
	operation, err := createTenantExternalOperation(ctx, queries, tx, input)
	if err != nil {
		return sqlc.SyncExternalOperation{}, err
	}
	for _, participant := range participants {
		for _, source := range []string{"microphone", "camera", "screen"} {
			owner, err := queries.CreateTenantEndPublicationFence(ctx, sqlc.CreateTenantEndPublicationFenceParams{
				TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
				ParticipantSessionID: participant.ID, ParticipantGeneration: participant.Generation,
				Source: source, ExternalOperationID: operation.ExternalOperationID,
			})
			if err != nil || owner != operation.ExternalOperationID {
				if err == nil {
					err = sessionlifecycle.ErrSessionControlBusy
				}
				return sqlc.SyncExternalOperation{}, fmt.Errorf("install tenant end publication fence: %w", err)
			}
		}
	}
	if _, err := queries.FailPendingTenantControlOperationsForEnd(ctx, sqlc.FailPendingTenantControlOperationsForEndParams{
		TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
	}); err != nil {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("settle pending tenant control operations: %w", err)
	}
	if _, err := queries.MarkTenantExternalSessionEnding(ctx, sqlc.MarkTenantExternalSessionEndingParams{
		TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
	}); errors.Is(err, pgx.ErrNoRows) {
		return sqlc.SyncExternalOperation{}, sessionlifecycle.ErrSessionNotActive
	} else if err != nil {
		return sqlc.SyncExternalOperation{}, fmt.Errorf("mark tenant external session ending: %w", err)
	}
	return operation, nil
}

func createParticipantRemovalOperation(ctx context.Context, queries *sqlc.Queries, tx pgx.Tx, input tenantExternalOperationInput, participant sqlc.Participant) (sqlc.SyncExternalOperation, sqlc.Participant, error) {
	input.FenceActive = true
	operation, err := createTenantExternalOperation(ctx, queries, tx, input)
	if err != nil {
		return sqlc.SyncExternalOperation{}, sqlc.Participant{}, err
	}
	for _, source := range []string{"microphone", "camera", "screen"} {
		owner, err := queries.CreateTenantEndPublicationFence(ctx, sqlc.CreateTenantEndPublicationFenceParams{
			TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
			ParticipantSessionID: participant.ID, ParticipantGeneration: participant.Generation,
			Source: source, ExternalOperationID: operation.ExternalOperationID,
		})
		if err != nil || owner != operation.ExternalOperationID {
			if err == nil {
				err = sessionlifecycle.ErrSessionControlBusy
			}
			return sqlc.SyncExternalOperation{}, sqlc.Participant{}, fmt.Errorf("install participant removal publication fence: %w", err)
		}
	}
	participant, err = queries.MarkLifecycleParticipantLeaving(ctx, sqlc.MarkLifecycleParticipantLeavingParams{
		TenantID: uuid(input.TenantID), RoomID: uuid(input.RoomID), SessionID: uuid(input.SessionID),
		ParticipantSessionID: participant.ID, ParticipantSessionGeneration: participant.Generation,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return sqlc.SyncExternalOperation{}, sqlc.Participant{}, sessionlifecycle.ErrParticipantNotActive
	}
	if err != nil {
		return sqlc.SyncExternalOperation{}, sqlc.Participant{}, fmt.Errorf("mark removal participant leaving: %w", err)
	}
	return operation, participant, nil
}

func resolveControlRetry(ctx context.Context, queries *sqlc.Queries, tenantID, roomID, sessionID utilities.ID, operation sqlc.SyncExternalOperation, result *sessionlifecycle.ControlRequest) error {
	session, err := lockLifecycleSession(ctx, queries, tenantID, roomID, sessionID)
	if err != nil {
		return err
	}
	*result = sessionlifecycle.ControlRequest{Session: mapLifecycleSession(session), Operation: mapExternalOperation(operation)}
	return nil
}

func mapExternalOperation(row sqlc.SyncExternalOperation) sessionlifecycle.ExternalOperation {
	return sessionlifecycle.ExternalOperation{
		ID: utilities.IDFromBytes(row.ExternalOperationID.Bytes), RequestKey: row.RequestKey, OperationName: row.OperationName,
		TargetParticipantID: nullableID(row.TargetParticipantSessionID), TargetGeneration: nullableInt64(row.TargetParticipantGeneration),
		DeadlineGeneration: nullableInt64(row.DeadlineGeneration), Status: row.Status, CreatedAt: timestamp(row.CreatedAt),
	}
}

func mapExternalOperationIntent(row sqlc.SyncExternalOperation) sessionlifecycle.Intent {
	operation := mapExternalOperation(row)
	return sessionlifecycle.Intent{
		ID: operation.ID, TenantID: utilities.IDFromBytes(row.TenantID.Bytes), RoomID: utilities.IDFromBytes(row.RoomID.Bytes),
		SessionID: utilities.IDFromBytes(row.SessionID.Bytes), RequestKey: operation.RequestKey, IntentName: operation.OperationName,
		ParticipantID: operation.TargetParticipantID, ParticipantGeneration: operation.TargetGeneration,
		Status: operation.Status, CreatedAt: operation.CreatedAt,
	}
}

func optionalInt8(value int64) pgtype.Int8 {
	if value <= 0 {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: value, Valid: true}
}

var _ sessionlifecycle.ControlRepository = SessionLifecycleRepository{}
var _ sessionlifecycle.DeadlineSchedulerRepository = SessionLifecycleRepository{}
