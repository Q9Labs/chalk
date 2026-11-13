package observability

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func (q operationQuerier) AuthorizeRecordingArtifactReplay(ctx context.Context, arg sqlc.AuthorizeRecordingArtifactReplayParams) (bool, error) {
	return observe(ctx, q, "AuthorizeRecordingArtifactReplay", func() (bool, error) { return q.next.AuthorizeRecordingArtifactReplay(ctx, arg) })
}

func (q operationQuerier) ClaimRecordingJob(ctx context.Context, arg sqlc.ClaimRecordingJobParams) (sqlc.ClaimRecordingJobRow, error) {
	return observe(ctx, q, "ClaimRecordingJob", func() (sqlc.ClaimRecordingJobRow, error) { return q.next.ClaimRecordingJob(ctx, arg) })
}

func (q operationQuerier) CommitRecordingArtifact(ctx context.Context, arg sqlc.CommitRecordingArtifactParams) (sqlc.CommitRecordingArtifactRow, error) {
	return observe(ctx, q, "CommitRecordingArtifact", func() (sqlc.CommitRecordingArtifactRow, error) { return q.next.CommitRecordingArtifact(ctx, arg) })
}

func (q operationQuerier) CompleteCaptureRecordingJob(ctx context.Context, arg sqlc.CompleteCaptureRecordingJobParams) (sqlc.CompleteCaptureRecordingJobRow, error) {
	return observe(ctx, q, "CompleteCaptureRecordingJob", func() (sqlc.CompleteCaptureRecordingJobRow, error) {
		return q.next.CompleteCaptureRecordingJob(ctx, arg)
	})
}

func (q operationQuerier) CompleteRecordingJob(ctx context.Context, arg sqlc.CompleteRecordingJobParams) (sqlc.RecordingJob, error) {
	return observe(ctx, q, "CompleteRecordingJob", func() (sqlc.RecordingJob, error) { return q.next.CompleteRecordingJob(ctx, arg) })
}

func (q operationQuerier) CreateRecordingReservation(ctx context.Context, arg sqlc.CreateRecordingReservationParams) (sqlc.CreateRecordingReservationRow, error) {
	return observe(ctx, q, "CreateRecordingReservation", func() (sqlc.CreateRecordingReservationRow, error) { return q.next.CreateRecordingReservation(ctx, arg) })
}

func (q operationQuerier) ExpireRecordingReservations(ctx context.Context, now pgtype.Timestamptz) ([]sqlc.ExpireRecordingReservationsRow, error) {
	return observe(ctx, q, "ExpireRecordingReservations", func() ([]sqlc.ExpireRecordingReservationsRow, error) {
		return q.next.ExpireRecordingReservations(ctx, now)
	})
}

func (q operationQuerier) ExtendRecordingReservation(ctx context.Context, arg sqlc.ExtendRecordingReservationParams) (sqlc.ExtendRecordingReservationRow, error) {
	return observe(ctx, q, "ExtendRecordingReservation", func() (sqlc.ExtendRecordingReservationRow, error) { return q.next.ExtendRecordingReservation(ctx, arg) })
}

func (q operationQuerier) FailRecordingJob(ctx context.Context, arg sqlc.FailRecordingJobParams) (sqlc.FailRecordingJobRow, error) {
	return observe(ctx, q, "FailRecordingJob", func() (sqlc.FailRecordingJobRow, error) { return q.next.FailRecordingJob(ctx, arg) })
}

func (q operationQuerier) GetRecordingArtifact(ctx context.Context, arg sqlc.GetRecordingArtifactParams) (sqlc.RecordingArtifact, error) {
	return observe(ctx, q, "GetRecordingArtifact", func() (sqlc.RecordingArtifact, error) { return q.next.GetRecordingArtifact(ctx, arg) })
}

func (q operationQuerier) GetCompletedCaptureRecordingJob(ctx context.Context, arg sqlc.GetCompletedCaptureRecordingJobParams) (sqlc.RecordingJob, error) {
	return observe(ctx, q, "GetCompletedCaptureRecordingJob", func() (sqlc.RecordingJob, error) { return q.next.GetCompletedCaptureRecordingJob(ctx, arg) })
}

func (q operationQuerier) GetLatestRecordingCapturePlan(ctx context.Context, planHandle pgtype.UUID) (sqlc.RecordingCapturePlan, error) {
	return observe(ctx, q, "GetLatestRecordingCapturePlan", func() (sqlc.RecordingCapturePlan, error) {
		return q.next.GetLatestRecordingCapturePlan(ctx, planHandle)
	})
}

func (q operationQuerier) GetRecordingCapturePlanSource(ctx context.Context, arg sqlc.GetRecordingCapturePlanSourceParams) (sqlc.GetRecordingCapturePlanSourceRow, error) {
	return observe(ctx, q, "GetRecordingCapturePlanSource", func() (sqlc.GetRecordingCapturePlanSourceRow, error) {
		return q.next.GetRecordingCapturePlanSource(ctx, arg)
	})
}

func (q operationQuerier) GetRecordingJobAttemptAuthorityByClaimRequest(ctx context.Context, claimRequestID pgtype.UUID) (sqlc.GetRecordingJobAttemptAuthorityByClaimRequestRow, error) {
	return observe(ctx, q, "GetRecordingJobAttemptAuthorityByClaimRequest", func() (sqlc.GetRecordingJobAttemptAuthorityByClaimRequestRow, error) {
		return q.next.GetRecordingJobAttemptAuthorityByClaimRequest(ctx, claimRequestID)
	})
}

func (q operationQuerier) GetRecordingPipeline(ctx context.Context, arg sqlc.GetRecordingPipelineParams) (sqlc.GetRecordingPipelineRow, error) {
	return observe(ctx, q, "GetRecordingPipeline", func() (sqlc.GetRecordingPipelineRow, error) { return q.next.GetRecordingPipeline(ctx, arg) })
}

func (q operationQuerier) GetRecordingPoolHealth(ctx context.Context, role string) (sqlc.GetRecordingPoolHealthRow, error) {
	return observe(ctx, q, "GetRecordingPoolHealth", func() (sqlc.GetRecordingPoolHealthRow, error) { return q.next.GetRecordingPoolHealth(ctx, role) })
}

func (q operationQuerier) GetRecordingReservation(ctx context.Context, arg sqlc.GetRecordingReservationParams) (sqlc.GetRecordingReservationRow, error) {
	return observe(ctx, q, "GetRecordingReservation", func() (sqlc.GetRecordingReservationRow, error) { return q.next.GetRecordingReservation(ctx, arg) })
}

func (q operationQuerier) GetRecordingReservationByKey(ctx context.Context, arg sqlc.GetRecordingReservationByKeyParams) (sqlc.GetRecordingReservationByKeyRow, error) {
	return observe(ctx, q, "GetRecordingReservationByKey", func() (sqlc.GetRecordingReservationByKeyRow, error) {
		return q.next.GetRecordingReservationByKey(ctx, arg)
	})
}

func (q operationQuerier) GetRecordingReservationFingerprint(ctx context.Context, arg sqlc.GetRecordingReservationFingerprintParams) ([]byte, error) {
	return observe(ctx, q, "GetRecordingReservationFingerprint", func() ([]byte, error) { return q.next.GetRecordingReservationFingerprint(ctx, arg) })
}

func (q operationQuerier) HeartbeatRecordingJob(ctx context.Context, arg sqlc.HeartbeatRecordingJobParams) (sqlc.RecordingJob, error) {
	return observe(ctx, q, "HeartbeatRecordingJob", func() (sqlc.RecordingJob, error) { return q.next.HeartbeatRecordingJob(ctx, arg) })
}

func (q operationQuerier) InsertRecordingBundle(ctx context.Context, arg sqlc.InsertRecordingBundleParams) (sqlc.InsertRecordingBundleRow, error) {
	return observe(ctx, q, "InsertRecordingBundle", func() (sqlc.InsertRecordingBundleRow, error) { return q.next.InsertRecordingBundle(ctx, arg) })
}

func (q operationQuerier) InsertRecordingCapturePlan(ctx context.Context, arg sqlc.InsertRecordingCapturePlanParams) (sqlc.RecordingCapturePlan, error) {
	return observe(ctx, q, "InsertRecordingCapturePlan", func() (sqlc.RecordingCapturePlan, error) { return q.next.InsertRecordingCapturePlan(ctx, arg) })
}

func (q operationQuerier) InsertRecordingJobAttemptAuthority(ctx context.Context, arg sqlc.InsertRecordingJobAttemptAuthorityParams) (sqlc.RecordingJobAttemptAuthority, error) {
	return observe(ctx, q, "InsertRecordingJobAttemptAuthority", func() (sqlc.RecordingJobAttemptAuthority, error) {
		return q.next.InsertRecordingJobAttemptAuthority(ctx, arg)
	})
}

func (q operationQuerier) ListRecordingDeadLetters(ctx context.Context, arg sqlc.ListRecordingDeadLettersParams) ([]sqlc.RecordingJob, error) {
	return observe(ctx, q, "ListRecordingDeadLetters", func() ([]sqlc.RecordingJob, error) { return q.next.ListRecordingDeadLetters(ctx, arg) })
}

func (q operationQuerier) ListRecordingJobsForReconciliation(ctx context.Context, arg sqlc.ListRecordingJobsForReconciliationParams) ([]sqlc.RecordingJob, error) {
	return observe(ctx, q, "ListRecordingJobsForReconciliation", func() ([]sqlc.RecordingJob, error) { return q.next.ListRecordingJobsForReconciliation(ctx, arg) })
}

func (q operationQuerier) LockRecordingJobClaimRequest(ctx context.Context, claimRequestID string) error {
	return observeErr(ctx, q, "LockRecordingJobClaimRequest", func() error { return q.next.LockRecordingJobClaimRequest(ctx, claimRequestID) })
}

func (q operationQuerier) LockRecordingCapturePlanHandle(ctx context.Context, planHandle string) error {
	return observeErr(ctx, q, "LockRecordingCapturePlanHandle", func() error { return q.next.LockRecordingCapturePlanHandle(ctx, planHandle) })
}

func (q operationQuerier) RecoverExpiredRecordingJobs(ctx context.Context, maximumRenderSeconds int32) ([]sqlc.RecoverExpiredRecordingJobsRow, error) {
	return observe(ctx, q, "RecoverExpiredRecordingJobs", func() ([]sqlc.RecoverExpiredRecordingJobsRow, error) {
		return q.next.RecoverExpiredRecordingJobs(ctx, maximumRenderSeconds)
	})
}

func (q operationQuerier) DrainCaptureStopPublications(ctx context.Context, observedAt pgtype.Timestamptz) error {
	return observeErr(ctx, q, "DrainCaptureStopPublications", func() error { return q.next.DrainCaptureStopPublications(ctx, observedAt) })
}

func (q operationQuerier) ReleaseRecordingReservation(ctx context.Context, arg sqlc.ReleaseRecordingReservationParams) (sqlc.ReleaseRecordingReservationRow, error) {
	return observe(ctx, q, "ReleaseRecordingReservation", func() (sqlc.ReleaseRecordingReservationRow, error) {
		return q.next.ReleaseRecordingReservation(ctx, arg)
	})
}

func (q operationQuerier) UpsertRecordingPoolHealth(ctx context.Context, arg sqlc.UpsertRecordingPoolHealthParams) (sqlc.UpsertRecordingPoolHealthRow, error) {
	return observe(ctx, q, "UpsertRecordingPoolHealth", func() (sqlc.UpsertRecordingPoolHealthRow, error) { return q.next.UpsertRecordingPoolHealth(ctx, arg) })
}

func (q operationQuerier) AdvanceRecordingCaptureCommandSequence(ctx context.Context, arg sqlc.AdvanceRecordingCaptureCommandSequenceParams) (int64, error) {
	return observe(ctx, q, "AdvanceRecordingCaptureCommandSequence", func() (int64, error) { return q.next.AdvanceRecordingCaptureCommandSequence(ctx, arg) })
}

func (q operationQuerier) ApplyRecordingCaptureConnectionProjection(ctx context.Context, arg sqlc.ApplyRecordingCaptureConnectionProjectionParams) (sqlc.RecordingCaptureConnection, error) {
	return observe(ctx, q, "ApplyRecordingCaptureConnectionProjection", func() (sqlc.RecordingCaptureConnection, error) {
		return q.next.ApplyRecordingCaptureConnectionProjection(ctx, arg)
	})
}

func (q operationQuerier) ClaimRecordingCaptureCommand(ctx context.Context, arg sqlc.ClaimRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	return observe(ctx, q, "ClaimRecordingCaptureCommand", func() (sqlc.RecordingCaptureCommand, error) { return q.next.ClaimRecordingCaptureCommand(ctx, arg) })
}

func (q operationQuerier) ClearRecordingCaptureConnectionActiveCommand(ctx context.Context, arg sqlc.ClearRecordingCaptureConnectionActiveCommandParams) (int64, error) {
	return observe(ctx, q, "ClearRecordingCaptureConnectionActiveCommand", func() (int64, error) { return q.next.ClearRecordingCaptureConnectionActiveCommand(ctx, arg) })
}

func (q operationQuerier) CompleteRecordingCaptureCommand(ctx context.Context, arg sqlc.CompleteRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	return observe(ctx, q, "CompleteRecordingCaptureCommand", func() (sqlc.RecordingCaptureCommand, error) { return q.next.CompleteRecordingCaptureCommand(ctx, arg) })
}

func (q operationQuerier) FailRecordingCaptureCommand(ctx context.Context, arg sqlc.FailRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	return observe(ctx, q, "FailRecordingCaptureCommand", func() (sqlc.RecordingCaptureCommand, error) { return q.next.FailRecordingCaptureCommand(ctx, arg) })
}

func (q operationQuerier) GetFirstOpenRecordingCaptureCommand(ctx context.Context, arg sqlc.GetFirstOpenRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	return observe(ctx, q, "GetFirstOpenRecordingCaptureCommand", func() (sqlc.RecordingCaptureCommand, error) {
		return q.next.GetFirstOpenRecordingCaptureCommand(ctx, arg)
	})
}

func (q operationQuerier) GetRecordingCaptureCommand(ctx context.Context, arg sqlc.GetRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	return observe(ctx, q, "GetRecordingCaptureCommand", func() (sqlc.RecordingCaptureCommand, error) { return q.next.GetRecordingCaptureCommand(ctx, arg) })
}

func (q operationQuerier) GetRecordingCaptureConnection(ctx context.Context, arg sqlc.GetRecordingCaptureConnectionParams) (sqlc.RecordingCaptureConnection, error) {
	return observe(ctx, q, "GetRecordingCaptureConnection", func() (sqlc.RecordingCaptureConnection, error) { return q.next.GetRecordingCaptureConnection(ctx, arg) })
}

func (q operationQuerier) GetRecordingCaptureSignalingAuthority(ctx context.Context, arg sqlc.GetRecordingCaptureSignalingAuthorityParams) (sqlc.GetRecordingCaptureSignalingAuthorityRow, error) {
	return observe(ctx, q, "GetRecordingCaptureSignalingAuthority", func() (sqlc.GetRecordingCaptureSignalingAuthorityRow, error) {
		return q.next.GetRecordingCaptureSignalingAuthority(ctx, arg)
	})
}

func (q operationQuerier) LockRecordingCaptureSignalingAuthority(ctx context.Context, arg sqlc.LockRecordingCaptureSignalingAuthorityParams) (sqlc.LockRecordingCaptureSignalingAuthorityRow, error) {
	return observe(ctx, q, "LockRecordingCaptureSignalingAuthority", func() (sqlc.LockRecordingCaptureSignalingAuthorityRow, error) {
		return q.next.LockRecordingCaptureSignalingAuthority(ctx, arg)
	})
}

func (q operationQuerier) InsertRecordingCaptureCommand(ctx context.Context, arg sqlc.InsertRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	return observe(ctx, q, "InsertRecordingCaptureCommand", func() (sqlc.RecordingCaptureCommand, error) { return q.next.InsertRecordingCaptureCommand(ctx, arg) })
}

func (q operationQuerier) InsertRecordingCaptureConnection(ctx context.Context, arg sqlc.InsertRecordingCaptureConnectionParams) (sqlc.RecordingCaptureConnection, error) {
	return observe(ctx, q, "InsertRecordingCaptureConnection", func() (sqlc.RecordingCaptureConnection, error) {
		return q.next.InsertRecordingCaptureConnection(ctx, arg)
	})
}

func (q operationQuerier) LockRecordingCaptureConnection(ctx context.Context, arg sqlc.LockRecordingCaptureConnectionParams) (sqlc.RecordingCaptureConnection, error) {
	return observe(ctx, q, "LockRecordingCaptureConnection", func() (sqlc.RecordingCaptureConnection, error) {
		return q.next.LockRecordingCaptureConnection(ctx, arg)
	})
}

func (q operationQuerier) MarkRecordingCaptureCommandAmbiguous(ctx context.Context, commandID int64) (sqlc.RecordingCaptureCommand, error) {
	return observe(ctx, q, "MarkRecordingCaptureCommandAmbiguous", func() (sqlc.RecordingCaptureCommand, error) {
		return q.next.MarkRecordingCaptureCommandAmbiguous(ctx, commandID)
	})
}

func (q operationQuerier) ReleaseRecordingCaptureCommand(ctx context.Context, arg sqlc.ReleaseRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	return observe(ctx, q, "ReleaseRecordingCaptureCommand", func() (sqlc.RecordingCaptureCommand, error) { return q.next.ReleaseRecordingCaptureCommand(ctx, arg) })
}

func (q operationQuerier) ReserveRecordingCaptureProviderCall(ctx context.Context) (pgtype.Timestamptz, error) {
	return observe(ctx, q, "ReserveRecordingCaptureProviderCall", func() (pgtype.Timestamptz, error) { return q.next.ReserveRecordingCaptureProviderCall(ctx) })
}

func (q operationQuerier) SetRecordingCaptureConnectionActiveCommand(ctx context.Context, arg sqlc.SetRecordingCaptureConnectionActiveCommandParams) (int64, error) {
	return observe(ctx, q, "SetRecordingCaptureConnectionActiveCommand", func() (int64, error) { return q.next.SetRecordingCaptureConnectionActiveCommand(ctx, arg) })
}

func (q operationQuerier) ListRecordingDeferredArtifactStates(ctx context.Context, arg sqlc.ListRecordingDeferredArtifactStatesParams) ([]sqlc.ListRecordingDeferredArtifactStatesRow, error) {
	return observe(ctx, q, "ListRecordingDeferredArtifactStates", func() ([]sqlc.ListRecordingDeferredArtifactStatesRow, error) {
		return q.next.ListRecordingDeferredArtifactStates(ctx, arg)
	})
}

func (q operationQuerier) RequestDeferredRecordingRender(ctx context.Context, arg sqlc.RequestDeferredRecordingRenderParams) (sqlc.RequestDeferredRecordingRenderRow, error) {
	return observe(ctx, q, "RequestDeferredRecordingRender", func() (sqlc.RequestDeferredRecordingRenderRow, error) {
		return q.next.RequestDeferredRecordingRender(ctx, arg)
	})
}
