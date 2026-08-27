package observability

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func (q operationQuerier) AuthorizeRecordingArtifactReplay(ctx context.Context, arg sqlc.AuthorizeRecordingArtifactReplayParams) (bool, error) {
	startedAt := time.Now()
	authorized, err := q.next.AuthorizeRecordingArtifactReplay(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "AuthorizeRecordingArtifactReplay", startedAt, err)
	return authorized, err
}

func (q operationQuerier) ClaimRecordingJob(ctx context.Context, arg sqlc.ClaimRecordingJobParams) (sqlc.ClaimRecordingJobRow, error) {
	startedAt := time.Now()
	job, err := q.next.ClaimRecordingJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ClaimRecordingJob", startedAt, err)
	return job, err
}

func (q operationQuerier) CommitRecordingArtifact(ctx context.Context, arg sqlc.CommitRecordingArtifactParams) (sqlc.CommitRecordingArtifactRow, error) {
	startedAt := time.Now()
	artifact, err := q.next.CommitRecordingArtifact(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CommitRecordingArtifact", startedAt, err)
	return artifact, err
}

func (q operationQuerier) CompleteCaptureRecordingJob(ctx context.Context, arg sqlc.CompleteCaptureRecordingJobParams) (sqlc.RecordingJob, error) {
	startedAt := time.Now()
	job, err := q.next.CompleteCaptureRecordingJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CompleteCaptureRecordingJob", startedAt, err)
	return job, err
}

func (q operationQuerier) CompleteRecordingJob(ctx context.Context, arg sqlc.CompleteRecordingJobParams) (sqlc.RecordingJob, error) {
	startedAt := time.Now()
	job, err := q.next.CompleteRecordingJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CompleteRecordingJob", startedAt, err)
	return job, err
}

func (q operationQuerier) CreateRecordingReservation(ctx context.Context, arg sqlc.CreateRecordingReservationParams) (sqlc.CreateRecordingReservationRow, error) {
	startedAt := time.Now()
	reservation, err := q.next.CreateRecordingReservation(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateRecordingReservation", startedAt, err)
	return reservation, err
}

func (q operationQuerier) ExpireRecordingReservations(ctx context.Context, now pgtype.Timestamptz) ([]sqlc.ExpireRecordingReservationsRow, error) {
	startedAt := time.Now()
	reservations, err := q.next.ExpireRecordingReservations(ctx, now)
	LogOperation(ctx, q.logger, "db.query", "ExpireRecordingReservations", startedAt, err)
	return reservations, err
}

func (q operationQuerier) ExtendRecordingReservation(ctx context.Context, arg sqlc.ExtendRecordingReservationParams) (sqlc.ExtendRecordingReservationRow, error) {
	startedAt := time.Now()
	reservation, err := q.next.ExtendRecordingReservation(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ExtendRecordingReservation", startedAt, err)
	return reservation, err
}

func (q operationQuerier) FailRecordingJob(ctx context.Context, arg sqlc.FailRecordingJobParams) (sqlc.FailRecordingJobRow, error) {
	startedAt := time.Now()
	job, err := q.next.FailRecordingJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "FailRecordingJob", startedAt, err)
	return job, err
}

func (q operationQuerier) GetRecordingArtifact(ctx context.Context, arg sqlc.GetRecordingArtifactParams) (sqlc.RecordingArtifact, error) {
	startedAt := time.Now()
	artifact, err := q.next.GetRecordingArtifact(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingArtifact", startedAt, err)
	return artifact, err
}

func (q operationQuerier) GetLatestRecordingCapturePlan(ctx context.Context, planHandle pgtype.UUID) (sqlc.RecordingCapturePlan, error) {
	startedAt := time.Now()
	plan, err := q.next.GetLatestRecordingCapturePlan(ctx, planHandle)
	LogOperation(ctx, q.logger, "db.query", "GetLatestRecordingCapturePlan", startedAt, err)
	return plan, err
}

func (q operationQuerier) GetRecordingCapturePlanSource(ctx context.Context, arg sqlc.GetRecordingCapturePlanSourceParams) (sqlc.GetRecordingCapturePlanSourceRow, error) {
	startedAt := time.Now()
	source, err := q.next.GetRecordingCapturePlanSource(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingCapturePlanSource", startedAt, err)
	return source, err
}

func (q operationQuerier) GetRecordingJobAttemptAuthorityByClaimRequest(ctx context.Context, claimRequestID pgtype.UUID) (sqlc.GetRecordingJobAttemptAuthorityByClaimRequestRow, error) {
	startedAt := time.Now()
	authority, err := q.next.GetRecordingJobAttemptAuthorityByClaimRequest(ctx, claimRequestID)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingJobAttemptAuthorityByClaimRequest", startedAt, err)
	return authority, err
}

func (q operationQuerier) GetRecordingPipeline(ctx context.Context, arg sqlc.GetRecordingPipelineParams) (sqlc.RecordingPipeline, error) {
	startedAt := time.Now()
	pipeline, err := q.next.GetRecordingPipeline(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingPipeline", startedAt, err)
	return pipeline, err
}

func (q operationQuerier) GetRecordingPoolHealth(ctx context.Context, role string) (sqlc.RecordingPoolHealth, error) {
	startedAt := time.Now()
	health, err := q.next.GetRecordingPoolHealth(ctx, role)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingPoolHealth", startedAt, err)
	return health, err
}

func (q operationQuerier) GetRecordingReservation(ctx context.Context, arg sqlc.GetRecordingReservationParams) (sqlc.GetRecordingReservationRow, error) {
	startedAt := time.Now()
	reservation, err := q.next.GetRecordingReservation(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingReservation", startedAt, err)
	return reservation, err
}

func (q operationQuerier) GetRecordingReservationByKey(ctx context.Context, arg sqlc.GetRecordingReservationByKeyParams) (sqlc.GetRecordingReservationByKeyRow, error) {
	startedAt := time.Now()
	reservation, err := q.next.GetRecordingReservationByKey(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingReservationByKey", startedAt, err)
	return reservation, err
}

func (q operationQuerier) GetRecordingReservationFingerprint(ctx context.Context, arg sqlc.GetRecordingReservationFingerprintParams) ([]byte, error) {
	startedAt := time.Now()
	fingerprint, err := q.next.GetRecordingReservationFingerprint(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingReservationFingerprint", startedAt, err)
	return fingerprint, err
}

func (q operationQuerier) HeartbeatRecordingJob(ctx context.Context, arg sqlc.HeartbeatRecordingJobParams) (sqlc.RecordingJob, error) {
	startedAt := time.Now()
	job, err := q.next.HeartbeatRecordingJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "HeartbeatRecordingJob", startedAt, err)
	return job, err
}

func (q operationQuerier) InsertRecordingBundle(ctx context.Context, arg sqlc.InsertRecordingBundleParams) (sqlc.InsertRecordingBundleRow, error) {
	startedAt := time.Now()
	bundle, err := q.next.InsertRecordingBundle(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "InsertRecordingBundle", startedAt, err)
	return bundle, err
}

func (q operationQuerier) InsertRecordingCapturePlan(ctx context.Context, arg sqlc.InsertRecordingCapturePlanParams) (sqlc.RecordingCapturePlan, error) {
	startedAt := time.Now()
	plan, err := q.next.InsertRecordingCapturePlan(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "InsertRecordingCapturePlan", startedAt, err)
	return plan, err
}

func (q operationQuerier) InsertRecordingJobAttemptAuthority(ctx context.Context, arg sqlc.InsertRecordingJobAttemptAuthorityParams) (sqlc.RecordingJobAttemptAuthority, error) {
	startedAt := time.Now()
	authority, err := q.next.InsertRecordingJobAttemptAuthority(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "InsertRecordingJobAttemptAuthority", startedAt, err)
	return authority, err
}

func (q operationQuerier) ListRecordingDeadLetters(ctx context.Context, arg sqlc.ListRecordingDeadLettersParams) ([]sqlc.RecordingJob, error) {
	startedAt := time.Now()
	jobs, err := q.next.ListRecordingDeadLetters(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListRecordingDeadLetters", startedAt, err)
	return jobs, err
}

func (q operationQuerier) ListRecordingJobsForReconciliation(ctx context.Context, arg sqlc.ListRecordingJobsForReconciliationParams) ([]sqlc.RecordingJob, error) {
	startedAt := time.Now()
	jobs, err := q.next.ListRecordingJobsForReconciliation(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListRecordingJobsForReconciliation", startedAt, err)
	return jobs, err
}

func (q operationQuerier) LockRecordingJobClaimRequest(ctx context.Context, claimRequestID string) error {
	startedAt := time.Now()
	err := q.next.LockRecordingJobClaimRequest(ctx, claimRequestID)
	LogOperation(ctx, q.logger, "db.query", "LockRecordingJobClaimRequest", startedAt, err)
	return err
}

func (q operationQuerier) LockRecordingCapturePlanHandle(ctx context.Context, planHandle string) error {
	startedAt := time.Now()
	err := q.next.LockRecordingCapturePlanHandle(ctx, planHandle)
	LogOperation(ctx, q.logger, "db.query", "LockRecordingCapturePlanHandle", startedAt, err)
	return err
}

func (q operationQuerier) RecoverExpiredRecordingJobs(ctx context.Context) ([]sqlc.RecoverExpiredRecordingJobsRow, error) {
	startedAt := time.Now()
	jobs, err := q.next.RecoverExpiredRecordingJobs(ctx)
	LogOperation(ctx, q.logger, "db.query", "RecoverExpiredRecordingJobs", startedAt, err)
	return jobs, err
}

func (q operationQuerier) ReleaseRecordingReservation(ctx context.Context, arg sqlc.ReleaseRecordingReservationParams) (sqlc.ReleaseRecordingReservationRow, error) {
	startedAt := time.Now()
	reservation, err := q.next.ReleaseRecordingReservation(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReleaseRecordingReservation", startedAt, err)
	return reservation, err
}

func (q operationQuerier) UpsertRecordingPoolHealth(ctx context.Context, arg sqlc.UpsertRecordingPoolHealthParams) (sqlc.RecordingPoolHealth, error) {
	startedAt := time.Now()
	health, err := q.next.UpsertRecordingPoolHealth(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "UpsertRecordingPoolHealth", startedAt, err)
	return health, err
}

func (q operationQuerier) AdvanceRecordingCaptureCommandSequence(ctx context.Context, arg sqlc.AdvanceRecordingCaptureCommandSequenceParams) (int64, error) {
	startedAt := time.Now()
	sequence, err := q.next.AdvanceRecordingCaptureCommandSequence(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "AdvanceRecordingCaptureCommandSequence", startedAt, err)
	return sequence, err
}

func (q operationQuerier) ApplyRecordingCaptureConnectionProjection(ctx context.Context, arg sqlc.ApplyRecordingCaptureConnectionProjectionParams) (sqlc.RecordingCaptureConnection, error) {
	startedAt := time.Now()
	connection, err := q.next.ApplyRecordingCaptureConnectionProjection(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ApplyRecordingCaptureConnectionProjection", startedAt, err)
	return connection, err
}

func (q operationQuerier) ClaimRecordingCaptureCommand(ctx context.Context, arg sqlc.ClaimRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	startedAt := time.Now()
	command, err := q.next.ClaimRecordingCaptureCommand(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ClaimRecordingCaptureCommand", startedAt, err)
	return command, err
}

func (q operationQuerier) ClearRecordingCaptureConnectionActiveCommand(ctx context.Context, arg sqlc.ClearRecordingCaptureConnectionActiveCommandParams) (int64, error) {
	startedAt := time.Now()
	rows, err := q.next.ClearRecordingCaptureConnectionActiveCommand(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ClearRecordingCaptureConnectionActiveCommand", startedAt, err)
	return rows, err
}

func (q operationQuerier) CompleteRecordingCaptureCommand(ctx context.Context, arg sqlc.CompleteRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	startedAt := time.Now()
	command, err := q.next.CompleteRecordingCaptureCommand(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CompleteRecordingCaptureCommand", startedAt, err)
	return command, err
}

func (q operationQuerier) FailRecordingCaptureCommand(ctx context.Context, arg sqlc.FailRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	startedAt := time.Now()
	command, err := q.next.FailRecordingCaptureCommand(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "FailRecordingCaptureCommand", startedAt, err)
	return command, err
}

func (q operationQuerier) GetFirstOpenRecordingCaptureCommand(ctx context.Context, arg sqlc.GetFirstOpenRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	startedAt := time.Now()
	command, err := q.next.GetFirstOpenRecordingCaptureCommand(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetFirstOpenRecordingCaptureCommand", startedAt, err)
	return command, err
}

func (q operationQuerier) GetRecordingCaptureCommand(ctx context.Context, arg sqlc.GetRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	startedAt := time.Now()
	command, err := q.next.GetRecordingCaptureCommand(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingCaptureCommand", startedAt, err)
	return command, err
}

func (q operationQuerier) GetRecordingCaptureConnection(ctx context.Context, arg sqlc.GetRecordingCaptureConnectionParams) (sqlc.RecordingCaptureConnection, error) {
	startedAt := time.Now()
	connection, err := q.next.GetRecordingCaptureConnection(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingCaptureConnection", startedAt, err)
	return connection, err
}

func (q operationQuerier) GetRecordingCaptureSignalingAuthority(ctx context.Context, arg sqlc.GetRecordingCaptureSignalingAuthorityParams) (sqlc.GetRecordingCaptureSignalingAuthorityRow, error) {
	startedAt := time.Now()
	authority, err := q.next.GetRecordingCaptureSignalingAuthority(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingCaptureSignalingAuthority", startedAt, err)
	return authority, err
}

func (q operationQuerier) LockRecordingCaptureSignalingAuthority(ctx context.Context, arg sqlc.LockRecordingCaptureSignalingAuthorityParams) (sqlc.LockRecordingCaptureSignalingAuthorityRow, error) {
	startedAt := time.Now()
	authority, err := q.next.LockRecordingCaptureSignalingAuthority(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockRecordingCaptureSignalingAuthority", startedAt, err)
	return authority, err
}

func (q operationQuerier) InsertRecordingCaptureCommand(ctx context.Context, arg sqlc.InsertRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	startedAt := time.Now()
	command, err := q.next.InsertRecordingCaptureCommand(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "InsertRecordingCaptureCommand", startedAt, err)
	return command, err
}

func (q operationQuerier) InsertRecordingCaptureConnection(ctx context.Context, arg sqlc.InsertRecordingCaptureConnectionParams) (sqlc.RecordingCaptureConnection, error) {
	startedAt := time.Now()
	connection, err := q.next.InsertRecordingCaptureConnection(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "InsertRecordingCaptureConnection", startedAt, err)
	return connection, err
}

func (q operationQuerier) LockRecordingCaptureConnection(ctx context.Context, arg sqlc.LockRecordingCaptureConnectionParams) (sqlc.RecordingCaptureConnection, error) {
	startedAt := time.Now()
	connection, err := q.next.LockRecordingCaptureConnection(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockRecordingCaptureConnection", startedAt, err)
	return connection, err
}

func (q operationQuerier) MarkRecordingCaptureCommandAmbiguous(ctx context.Context, commandID int64) (sqlc.RecordingCaptureCommand, error) {
	startedAt := time.Now()
	command, err := q.next.MarkRecordingCaptureCommandAmbiguous(ctx, commandID)
	LogOperation(ctx, q.logger, "db.query", "MarkRecordingCaptureCommandAmbiguous", startedAt, err)
	return command, err
}

func (q operationQuerier) ReleaseRecordingCaptureCommand(ctx context.Context, arg sqlc.ReleaseRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error) {
	startedAt := time.Now()
	command, err := q.next.ReleaseRecordingCaptureCommand(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReleaseRecordingCaptureCommand", startedAt, err)
	return command, err
}

func (q operationQuerier) ReserveRecordingCaptureProviderCall(ctx context.Context) (pgtype.Timestamptz, error) {
	startedAt := time.Now()
	notBefore, err := q.next.ReserveRecordingCaptureProviderCall(ctx)
	LogOperation(ctx, q.logger, "db.query", "ReserveRecordingCaptureProviderCall", startedAt, err)
	return notBefore, err
}

func (q operationQuerier) SetRecordingCaptureConnectionActiveCommand(ctx context.Context, arg sqlc.SetRecordingCaptureConnectionActiveCommandParams) (int64, error) {
	startedAt := time.Now()
	rows, err := q.next.SetRecordingCaptureConnectionActiveCommand(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "SetRecordingCaptureConnectionActiveCommand", startedAt, err)
	return rows, err
}
