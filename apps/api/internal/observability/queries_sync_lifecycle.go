package observability

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func (q operationQuerier) CreateLifecycleIntent(ctx context.Context, arg sqlc.CreateLifecycleIntentParams) (sqlc.SyncLifecycleIntent, error) {
	return observe(ctx, q, "CreateLifecycleIntent", func() (sqlc.SyncLifecycleIntent, error) { return q.next.CreateLifecycleIntent(ctx, arg) })
}

func (q operationQuerier) CreateLifecycleParticipant(ctx context.Context, arg sqlc.CreateLifecycleParticipantParams) (sqlc.Participant, error) {
	return observe(ctx, q, "CreateLifecycleParticipant", func() (sqlc.Participant, error) { return q.next.CreateLifecycleParticipant(ctx, arg) })
}

func (q operationQuerier) CreateLifecycleEpisode(ctx context.Context, arg sqlc.CreateLifecycleEpisodeParams) (sqlc.Episode, error) {
	return observe(ctx, q, "CreateLifecycleEpisode", func() (sqlc.Episode, error) { return q.next.CreateLifecycleEpisode(ctx, arg) })
}

func (q operationQuerier) CreateSyncEpisodeControl(ctx context.Context, arg sqlc.CreateSyncEpisodeControlParams) (sqlc.SyncEpisodeControl, error) {
	return observe(ctx, q, "CreateSyncEpisodeControl", func() (sqlc.SyncEpisodeControl, error) { return q.next.CreateSyncEpisodeControl(ctx, arg) })
}

func (q operationQuerier) GetEpisodeCreateRequest(ctx context.Context, arg sqlc.GetEpisodeCreateRequestParams) (sqlc.EpisodeCreateRequest, error) {
	return observe(ctx, q, "GetEpisodeCreateRequest", func() (sqlc.EpisodeCreateRequest, error) { return q.next.GetEpisodeCreateRequest(ctx, arg) })
}

func (q operationQuerier) LockLifecycleIntentForParticipantTransitionForUpdate(ctx context.Context, arg sqlc.LockLifecycleIntentForParticipantTransitionForUpdateParams) (sqlc.SyncLifecycleIntent, error) {
	return observe(ctx, q, "LockLifecycleIntentForParticipantTransitionForUpdate", func() (sqlc.SyncLifecycleIntent, error) {
		return q.next.LockLifecycleIntentForParticipantTransitionForUpdate(ctx, arg)
	})
}

func (q operationQuerier) LockLifecycleIntentForRequestForUpdate(ctx context.Context, arg sqlc.LockLifecycleIntentForRequestForUpdateParams) (sqlc.SyncLifecycleIntent, error) {
	return observe(ctx, q, "LockLifecycleIntentForRequestForUpdate", func() (sqlc.SyncLifecycleIntent, error) {
		return q.next.LockLifecycleIntentForRequestForUpdate(ctx, arg)
	})
}

func (q operationQuerier) LockLifecycleParticipantForUpdate(ctx context.Context, arg sqlc.LockLifecycleParticipantForUpdateParams) (sqlc.Participant, error) {
	return observe(ctx, q, "LockLifecycleParticipantForUpdate", func() (sqlc.Participant, error) { return q.next.LockLifecycleParticipantForUpdate(ctx, arg) })
}

func (q operationQuerier) LockLifecycleEpisodeForUpdate(ctx context.Context, arg sqlc.LockLifecycleEpisodeForUpdateParams) (sqlc.Episode, error) {
	return observe(ctx, q, "LockLifecycleEpisodeForUpdate", func() (sqlc.Episode, error) { return q.next.LockLifecycleEpisodeForUpdate(ctx, arg) })
}

func (q operationQuerier) LockEpisodeEndLifecycleIntentForUpdate(ctx context.Context, arg sqlc.LockEpisodeEndLifecycleIntentForUpdateParams) (sqlc.SyncLifecycleIntent, error) {
	return observe(ctx, q, "LockEpisodeEndLifecycleIntentForUpdate", func() (sqlc.SyncLifecycleIntent, error) {
		return q.next.LockEpisodeEndLifecycleIntentForUpdate(ctx, arg)
	})
}

func (q operationQuerier) LockSyncEpisodeControlForUpdate(ctx context.Context, arg sqlc.LockSyncEpisodeControlForUpdateParams) (sqlc.SyncEpisodeControl, error) {
	return observe(ctx, q, "LockSyncEpisodeControlForUpdate", func() (sqlc.SyncEpisodeControl, error) { return q.next.LockSyncEpisodeControlForUpdate(ctx, arg) })
}

func (q operationQuerier) MarkLifecycleParticipantLeaving(ctx context.Context, arg sqlc.MarkLifecycleParticipantLeavingParams) (sqlc.Participant, error) {
	return observe(ctx, q, "MarkLifecycleParticipantLeaving", func() (sqlc.Participant, error) { return q.next.MarkLifecycleParticipantLeaving(ctx, arg) })
}

func (q operationQuerier) MarkLifecycleEpisodeEnding(ctx context.Context, arg sqlc.MarkLifecycleEpisodeEndingParams) (sqlc.Episode, error) {
	return observe(ctx, q, "MarkLifecycleEpisodeEnding", func() (sqlc.Episode, error) { return q.next.MarkLifecycleEpisodeEnding(ctx, arg) })
}

func (q operationQuerier) ReserveParticipantAdmission(ctx context.Context, arg sqlc.ReserveParticipantAdmissionParams) (sqlc.SyncEpisodeControl, error) {
	return observe(ctx, q, "ReserveParticipantAdmission", func() (sqlc.SyncEpisodeControl, error) { return q.next.ReserveParticipantAdmission(ctx, arg) })
}

func (q operationQuerier) ReserveParticipantRemoval(ctx context.Context, arg sqlc.ReserveParticipantRemovalParams) (sqlc.SyncEpisodeControl, error) {
	return observe(ctx, q, "ReserveParticipantRemoval", func() (sqlc.SyncEpisodeControl, error) { return q.next.ReserveParticipantRemoval(ctx, arg) })
}

func (q operationQuerier) ReserveEpisodeEnd(ctx context.Context, arg sqlc.ReserveEpisodeEndParams) (sqlc.SyncEpisodeControl, error) {
	return observe(ctx, q, "ReserveEpisodeEnd", func() (sqlc.SyncEpisodeControl, error) { return q.next.ReserveEpisodeEnd(ctx, arg) })
}

func (q operationQuerier) ReserveEpisodeCreateRequest(ctx context.Context, arg sqlc.ReserveEpisodeCreateRequestParams) (sqlc.EpisodeCreateRequest, error) {
	return observe(ctx, q, "ReserveEpisodeCreateRequest", func() (sqlc.EpisodeCreateRequest, error) { return q.next.ReserveEpisodeCreateRequest(ctx, arg) })
}
