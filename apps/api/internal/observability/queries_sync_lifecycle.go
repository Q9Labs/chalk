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

func (q operationQuerier) CreateLifecycleEpisode(ctx context.Context, arg sqlc.CreateLifecycleEpisodeParams) (sqlc.Episode, error) {
	startedAt := time.Now()
	episode, err := q.next.CreateLifecycleEpisode(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateLifecycleEpisode", startedAt, err)
	return episode, err
}

func (q operationQuerier) CreateSyncEpisodeControl(ctx context.Context, arg sqlc.CreateSyncEpisodeControlParams) (sqlc.SyncEpisodeControl, error) {
	startedAt := time.Now()
	control, err := q.next.CreateSyncEpisodeControl(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateSyncEpisodeControl", startedAt, err)
	return control, err
}

func (q operationQuerier) GetEpisodeCreateRequest(ctx context.Context, arg sqlc.GetEpisodeCreateRequestParams) (sqlc.EpisodeCreateRequest, error) {
	startedAt := time.Now()
	request, err := q.next.GetEpisodeCreateRequest(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetEpisodeCreateRequest", startedAt, err)
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

func (q operationQuerier) LockLifecycleEpisodeForUpdate(ctx context.Context, arg sqlc.LockLifecycleEpisodeForUpdateParams) (sqlc.Episode, error) {
	startedAt := time.Now()
	episode, err := q.next.LockLifecycleEpisodeForUpdate(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockLifecycleEpisodeForUpdate", startedAt, err)
	return episode, err
}

func (q operationQuerier) LockEpisodeEndLifecycleIntentForUpdate(ctx context.Context, arg sqlc.LockEpisodeEndLifecycleIntentForUpdateParams) (sqlc.SyncLifecycleIntent, error) {
	startedAt := time.Now()
	intent, err := q.next.LockEpisodeEndLifecycleIntentForUpdate(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockEpisodeEndLifecycleIntentForUpdate", startedAt, err)
	return intent, err
}

func (q operationQuerier) LockSyncEpisodeControlForUpdate(ctx context.Context, arg sqlc.LockSyncEpisodeControlForUpdateParams) (sqlc.SyncEpisodeControl, error) {
	startedAt := time.Now()
	control, err := q.next.LockSyncEpisodeControlForUpdate(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockSyncEpisodeControlForUpdate", startedAt, err)
	return control, err
}

func (q operationQuerier) MarkLifecycleParticipantLeaving(ctx context.Context, arg sqlc.MarkLifecycleParticipantLeavingParams) (sqlc.Participant, error) {
	startedAt := time.Now()
	participant, err := q.next.MarkLifecycleParticipantLeaving(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "MarkLifecycleParticipantLeaving", startedAt, err)
	return participant, err
}

func (q operationQuerier) MarkLifecycleEpisodeEnding(ctx context.Context, arg sqlc.MarkLifecycleEpisodeEndingParams) (sqlc.Episode, error) {
	startedAt := time.Now()
	episode, err := q.next.MarkLifecycleEpisodeEnding(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "MarkLifecycleEpisodeEnding", startedAt, err)
	return episode, err
}

func (q operationQuerier) ReserveParticipantAdmission(ctx context.Context, arg sqlc.ReserveParticipantAdmissionParams) (sqlc.SyncEpisodeControl, error) {
	startedAt := time.Now()
	control, err := q.next.ReserveParticipantAdmission(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReserveParticipantAdmission", startedAt, err)
	return control, err
}

func (q operationQuerier) ReserveParticipantRemoval(ctx context.Context, arg sqlc.ReserveParticipantRemovalParams) (sqlc.SyncEpisodeControl, error) {
	startedAt := time.Now()
	control, err := q.next.ReserveParticipantRemoval(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReserveParticipantRemoval", startedAt, err)
	return control, err
}

func (q operationQuerier) ReserveEpisodeEnd(ctx context.Context, arg sqlc.ReserveEpisodeEndParams) (sqlc.SyncEpisodeControl, error) {
	startedAt := time.Now()
	control, err := q.next.ReserveEpisodeEnd(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReserveEpisodeEnd", startedAt, err)
	return control, err
}

func (q operationQuerier) ReserveEpisodeCreateRequest(ctx context.Context, arg sqlc.ReserveEpisodeCreateRequestParams) (sqlc.EpisodeCreateRequest, error) {
	startedAt := time.Now()
	request, err := q.next.ReserveEpisodeCreateRequest(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReserveEpisodeCreateRequest", startedAt, err)
	return request, err
}
