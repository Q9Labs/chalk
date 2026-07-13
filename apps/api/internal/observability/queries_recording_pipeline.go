package observability

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

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

func (q operationQuerier) InsertRecordingBundle(ctx context.Context, arg sqlc.InsertRecordingBundleParams) (sqlc.RecordingBundle, error) {
	startedAt := time.Now()
	bundle, err := q.next.InsertRecordingBundle(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "InsertRecordingBundle", startedAt, err)
	return bundle, err
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
