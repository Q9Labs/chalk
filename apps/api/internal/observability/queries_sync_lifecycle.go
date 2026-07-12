package observability

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func (q operationQuerier) CreateLifecycleIntent(ctx context.Context, arg sqlc.CreateLifecycleIntentParams) (sqlc.SyncLifecycleIntent, error) {
	startedAt := time.Now()
	intent, err := q.next.CreateLifecycleIntent(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateLifecycleIntent", startedAt, err)
	return intent, err
}

func (q operationQuerier) CreateLifecycleParticipant(ctx context.Context, arg sqlc.CreateLifecycleParticipantParams) (sqlc.Participant, error) {
	startedAt := time.Now()
	participant, err := q.next.CreateLifecycleParticipant(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateLifecycleParticipant", startedAt, err)
	return participant, err
}

func (q operationQuerier) CreateLifecycleRoomSession(ctx context.Context, arg sqlc.CreateLifecycleRoomSessionParams) (sqlc.RoomSession, error) {
	startedAt := time.Now()
	session, err := q.next.CreateLifecycleRoomSession(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateLifecycleRoomSession", startedAt, err)
	return session, err
}

func (q operationQuerier) CreateSyncSessionControl(ctx context.Context, arg sqlc.CreateSyncSessionControlParams) (sqlc.SyncSessionControl, error) {
	startedAt := time.Now()
	control, err := q.next.CreateSyncSessionControl(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateSyncSessionControl", startedAt, err)
	return control, err
}

func (q operationQuerier) GetSessionCreateRequest(ctx context.Context, arg sqlc.GetSessionCreateRequestParams) (sqlc.SessionCreateRequest, error) {
	startedAt := time.Now()
	request, err := q.next.GetSessionCreateRequest(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetSessionCreateRequest", startedAt, err)
	return request, err
}

func (q operationQuerier) LockLifecycleIntentForParticipantTransitionForUpdate(ctx context.Context, arg sqlc.LockLifecycleIntentForParticipantTransitionForUpdateParams) (sqlc.SyncLifecycleIntent, error) {
	startedAt := time.Now()
	intent, err := q.next.LockLifecycleIntentForParticipantTransitionForUpdate(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockLifecycleIntentForParticipantTransitionForUpdate", startedAt, err)
	return intent, err
}

func (q operationQuerier) LockLifecycleIntentForRequestForUpdate(ctx context.Context, arg sqlc.LockLifecycleIntentForRequestForUpdateParams) (sqlc.SyncLifecycleIntent, error) {
	startedAt := time.Now()
	intent, err := q.next.LockLifecycleIntentForRequestForUpdate(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockLifecycleIntentForRequestForUpdate", startedAt, err)
	return intent, err
}

func (q operationQuerier) LockLifecycleParticipantForUpdate(ctx context.Context, arg sqlc.LockLifecycleParticipantForUpdateParams) (sqlc.Participant, error) {
	startedAt := time.Now()
	participant, err := q.next.LockLifecycleParticipantForUpdate(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockLifecycleParticipantForUpdate", startedAt, err)
	return participant, err
}

func (q operationQuerier) LockLifecycleRoomSessionForUpdate(ctx context.Context, arg sqlc.LockLifecycleRoomSessionForUpdateParams) (sqlc.RoomSession, error) {
	startedAt := time.Now()
	session, err := q.next.LockLifecycleRoomSessionForUpdate(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockLifecycleRoomSessionForUpdate", startedAt, err)
	return session, err
}

func (q operationQuerier) LockSessionEndLifecycleIntentForUpdate(ctx context.Context, arg sqlc.LockSessionEndLifecycleIntentForUpdateParams) (sqlc.SyncLifecycleIntent, error) {
	startedAt := time.Now()
	intent, err := q.next.LockSessionEndLifecycleIntentForUpdate(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockSessionEndLifecycleIntentForUpdate", startedAt, err)
	return intent, err
}

func (q operationQuerier) LockSyncSessionControlForUpdate(ctx context.Context, arg sqlc.LockSyncSessionControlForUpdateParams) (sqlc.SyncSessionControl, error) {
	startedAt := time.Now()
	control, err := q.next.LockSyncSessionControlForUpdate(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockSyncSessionControlForUpdate", startedAt, err)
	return control, err
}

func (q operationQuerier) MarkLifecycleParticipantLeaving(ctx context.Context, arg sqlc.MarkLifecycleParticipantLeavingParams) (sqlc.Participant, error) {
	startedAt := time.Now()
	participant, err := q.next.MarkLifecycleParticipantLeaving(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "MarkLifecycleParticipantLeaving", startedAt, err)
	return participant, err
}

func (q operationQuerier) MarkLifecycleSessionEnding(ctx context.Context, arg sqlc.MarkLifecycleSessionEndingParams) (sqlc.RoomSession, error) {
	startedAt := time.Now()
	session, err := q.next.MarkLifecycleSessionEnding(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "MarkLifecycleSessionEnding", startedAt, err)
	return session, err
}

func (q operationQuerier) ReserveParticipantAdmission(ctx context.Context, arg sqlc.ReserveParticipantAdmissionParams) (sqlc.SyncSessionControl, error) {
	startedAt := time.Now()
	control, err := q.next.ReserveParticipantAdmission(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReserveParticipantAdmission", startedAt, err)
	return control, err
}

func (q operationQuerier) ReserveParticipantRemoval(ctx context.Context, arg sqlc.ReserveParticipantRemovalParams) (sqlc.SyncSessionControl, error) {
	startedAt := time.Now()
	control, err := q.next.ReserveParticipantRemoval(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReserveParticipantRemoval", startedAt, err)
	return control, err
}

func (q operationQuerier) ReserveSessionEnd(ctx context.Context, arg sqlc.ReserveSessionEndParams) (sqlc.SyncSessionControl, error) {
	startedAt := time.Now()
	control, err := q.next.ReserveSessionEnd(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReserveSessionEnd", startedAt, err)
	return control, err
}

func (q operationQuerier) ReserveSessionCreateRequest(ctx context.Context, arg sqlc.ReserveSessionCreateRequestParams) (sqlc.SessionCreateRequest, error) {
	startedAt := time.Now()
	request, err := q.next.ReserveSessionCreateRequest(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReserveSessionCreateRequest", startedAt, err)
	return request, err
}
