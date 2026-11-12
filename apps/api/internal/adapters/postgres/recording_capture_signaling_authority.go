package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func withRecordingCaptureSignalingTransaction[T any](
	ctx context.Context,
	repository RecordingCaptureSignalingRepository,
	operation func(recordingCaptureSignalingQuerier) (T, error),
) (T, error) {
	var zero T
	if repository.transactor == nil {
		return zero, capturesignaling.ErrUnavailable
	}
	transaction, err := repository.transactor.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return zero, fmt.Errorf("begin recording capture signaling transaction: %w", err)
	}
	defer transaction.Rollback(ctx)
	queries := sqlc.Querier(sqlc.New(transaction))
	if repository.decorate != nil {
		queries = repository.decorate(queries)
	}
	result, err := operation(queries)
	if err != nil {
		return zero, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return zero, fmt.Errorf("commit recording capture signaling transaction: %w", err)
	}
	return result, nil
}

func authorizeRecordingCaptureSignaling(
	ctx context.Context,
	queries recordingCaptureSignalingQuerier,
	handle capturesignaling.SignalingHandle,
	authority capturesignaling.CommandAuthority,
	lease capturesignaling.WorkerLease,
) (recordingCaptureSignalingAuthority, error) {
	row, err := queries.GetRecordingCaptureSignalingAuthority(ctx, sqlc.GetRecordingCaptureSignalingAuthorityParams{
		JobID: uuid(authority.JobID), AttemptCount: int32(authority.AttemptCount),
		FencingGeneration: authority.FencingGeneration, CaptureEpoch: int64(authority.CaptureEpoch),
		EnvelopeDigest: authority.EnvelopeDigest, LeaseToken: lease.Token, LeaseOwner: lease.Owner,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingCaptureSignalingAuthority{}, capturesignaling.ErrStaleAuthority
	}
	if err != nil {
		return recordingCaptureSignalingAuthority{}, fmt.Errorf("authorize recording capture signaling: %w", err)
	}
	return validateRecordingCaptureSignalingAuthority(mapRecordingCaptureSignalingAuthority(row), handle, authority, lease)
}

func lockRecordingCaptureSignalingAuthority(
	ctx context.Context,
	queries recordingCaptureSignalingQuerier,
	handle capturesignaling.SignalingHandle,
	authority capturesignaling.CommandAuthority,
	lease capturesignaling.WorkerLease,
) (recordingCaptureSignalingAuthority, error) {
	row, err := queries.LockRecordingCaptureSignalingAuthority(ctx, sqlc.LockRecordingCaptureSignalingAuthorityParams{
		JobID: uuid(authority.JobID), AttemptCount: int32(authority.AttemptCount),
		FencingGeneration: authority.FencingGeneration, CaptureEpoch: int64(authority.CaptureEpoch),
		EnvelopeDigest: authority.EnvelopeDigest, LeaseToken: lease.Token, LeaseOwner: lease.Owner,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return recordingCaptureSignalingAuthority{}, capturesignaling.ErrStaleAuthority
	}
	if err != nil {
		return recordingCaptureSignalingAuthority{}, fmt.Errorf("lock recording capture signaling authority: %w", err)
	}
	return validateRecordingCaptureSignalingAuthority(mapLockedRecordingCaptureSignalingAuthority(row), handle, authority, lease)
}

type recordingCaptureSignalingAuthority struct {
	MediaStopped      bool
	EnvelopeBytes     []byte
	EnvelopeDigest    []byte
	LeaseExpiresAt    pgtype.Timestamptz
	CheckedAt         pgtype.Timestamptz
	JobID             pgtype.UUID
	TenantID          pgtype.UUID
	SpaceID           pgtype.UUID
	EpisodeID         pgtype.UUID
	RecordingID       pgtype.UUID
	AttemptCount      int32
	FencingGeneration int64
	CaptureEpoch      int64
}

func mapRecordingCaptureSignalingAuthority(row sqlc.GetRecordingCaptureSignalingAuthorityRow) recordingCaptureSignalingAuthority {
	return recordingCaptureSignalingAuthority{
		EnvelopeBytes: row.EnvelopeBytes, EnvelopeDigest: row.EnvelopeDigest, MediaStopped: row.MediaStopped,
		LeaseExpiresAt: row.LeaseExpiresAt, CheckedAt: row.CheckedAt,
		JobID: row.JobID, TenantID: row.TenantID, SpaceID: row.SpaceID,
		EpisodeID: row.EpisodeID, RecordingID: row.RecordingID,
		AttemptCount: row.AttemptCount, FencingGeneration: row.FencingGeneration, CaptureEpoch: row.CaptureEpoch,
	}
}

func mapLockedRecordingCaptureSignalingAuthority(row sqlc.LockRecordingCaptureSignalingAuthorityRow) recordingCaptureSignalingAuthority {
	return recordingCaptureSignalingAuthority{
		EnvelopeBytes: row.EnvelopeBytes, EnvelopeDigest: row.EnvelopeDigest, MediaStopped: row.MediaStopped,
		LeaseExpiresAt: row.LeaseExpiresAt, CheckedAt: row.CheckedAt,
		JobID: row.JobID, TenantID: row.TenantID, SpaceID: row.SpaceID,
		EpisodeID: row.EpisodeID, RecordingID: row.RecordingID,
		AttemptCount: row.AttemptCount, FencingGeneration: row.FencingGeneration, CaptureEpoch: row.CaptureEpoch,
	}
}

func validateRecordingCaptureSignalingAuthority(
	row recordingCaptureSignalingAuthority,
	handle capturesignaling.SignalingHandle,
	authority capturesignaling.CommandAuthority,
	lease capturesignaling.WorkerLease,
) (recordingCaptureSignalingAuthority, error) {
	envelope, err := recordingpipeline.DecodeRecorderJobEnvelope(row.EnvelopeBytes, row.EnvelopeDigest)
	if err != nil || envelope.Kind != recordingpipeline.JobKindCapture || envelope.SignalingHandle != handle.String() ||
		envelope.TenantID != authority.TenantID.String() || envelope.SpaceID != authority.SpaceID.String() ||
		envelope.EpisodeID != authority.EpisodeID.String() || envelope.RecordingID != authority.RecordingID.String() ||
		envelope.JobID != authority.JobID.String() || envelope.AttemptCount != authority.AttemptCount ||
		envelope.FencingGeneration != authority.FencingGeneration || envelope.CaptureEpoch != int64(authority.CaptureEpoch) ||
		utilities.IDFromBytes(row.JobID.Bytes) != authority.JobID || utilities.IDFromBytes(row.TenantID.Bytes) != authority.TenantID ||
		utilities.IDFromBytes(row.SpaceID.Bytes) != authority.SpaceID || utilities.IDFromBytes(row.EpisodeID.Bytes) != authority.EpisodeID ||
		utilities.IDFromBytes(row.RecordingID.Bytes) != authority.RecordingID || !bytes.Equal(row.EnvelopeDigest, authority.EnvelopeDigest) ||
		!row.LeaseExpiresAt.Valid || !row.CheckedAt.Valid || !lease.ExpiresAt.After(row.CheckedAt.Time) ||
		lease.ExpiresAt.After(row.LeaseExpiresAt.Time) {
		return row, capturesignaling.ErrStaleAuthority
	}
	return row, nil
}

func validateRecordingCaptureCompletion(
	connection sqlc.RecordingCaptureConnection,
	key capturesignaling.CommandKey,
	authority capturesignaling.CommandAuthority,
	claimToken string,
	now time.Time,
	queries recordingCaptureSignalingQuerier,
	ctx context.Context,
) (sqlc.RecordingCaptureCommand, pgtype.UUID, error) {
	executionID, err := utilities.ParseID(claimToken)
	if err != nil {
		return sqlc.RecordingCaptureCommand{}, pgtype.UUID{}, capturesignaling.ErrStaleLease
	}
	executionToken := uuid(executionID)
	command, err := queries.GetRecordingCaptureCommand(ctx, captureCommandIdentity(key, authority.CaptureEpoch))
	if err != nil {
		return command, pgtype.UUID{}, capturesignaling.ErrStaleAuthority
	}
	if err := requireRecordingCaptureCommandKey(command, key, authority); err != nil {
		return command, pgtype.UUID{}, err
	}
	if command.State != "leased" || !command.ExecutionToken.Valid || command.ExecutionToken.Bytes != executionToken.Bytes ||
		!command.ExecutionExpiresAt.Valid || !command.ExecutionExpiresAt.Time.After(now) ||
		!connection.ActiveCommandID.Valid || connection.ActiveCommandID.Int64 != command.ID ||
		!connection.ActiveExecutionToken.Valid || connection.ActiveExecutionToken.Bytes != executionToken.Bytes {
		return command, pgtype.UUID{}, capturesignaling.ErrStaleLease
	}
	return command, executionToken, nil
}
