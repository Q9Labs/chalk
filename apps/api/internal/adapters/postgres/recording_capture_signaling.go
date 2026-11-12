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
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
)

const (
	recordingCaptureExecutionLease = 30 * time.Second
	recordingCaptureRetryBase      = 250 * time.Millisecond
	recordingCaptureRetryMaximum   = 5 * time.Second
)

type recordingCaptureSignalingQuerier interface {
	AdvanceRecordingCaptureCommandSequence(context.Context, sqlc.AdvanceRecordingCaptureCommandSequenceParams) (int64, error)
	ApplyRecordingCaptureConnectionProjection(context.Context, sqlc.ApplyRecordingCaptureConnectionProjectionParams) (sqlc.RecordingCaptureConnection, error)
	ClaimRecordingCaptureCommand(context.Context, sqlc.ClaimRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error)
	ClearRecordingCaptureConnectionActiveCommand(context.Context, sqlc.ClearRecordingCaptureConnectionActiveCommandParams) (int64, error)
	CompleteRecordingCaptureCommand(context.Context, sqlc.CompleteRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error)
	FailRecordingCaptureCommand(context.Context, sqlc.FailRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error)
	GetFirstOpenRecordingCaptureCommand(context.Context, sqlc.GetFirstOpenRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error)
	GetRecordingCaptureCommand(context.Context, sqlc.GetRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error)
	GetRecordingCaptureSignalingAuthority(context.Context, sqlc.GetRecordingCaptureSignalingAuthorityParams) (sqlc.GetRecordingCaptureSignalingAuthorityRow, error)
	InsertRecordingCaptureCommand(context.Context, sqlc.InsertRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error)
	InsertRecordingCaptureConnection(context.Context, sqlc.InsertRecordingCaptureConnectionParams) (sqlc.RecordingCaptureConnection, error)
	LockRecordingCaptureConnection(context.Context, sqlc.LockRecordingCaptureConnectionParams) (sqlc.RecordingCaptureConnection, error)
	LockRecordingCaptureSignalingAuthority(context.Context, sqlc.LockRecordingCaptureSignalingAuthorityParams) (sqlc.LockRecordingCaptureSignalingAuthorityRow, error)
	MarkRecordingCaptureCommandAmbiguous(context.Context, int64) (sqlc.RecordingCaptureCommand, error)
	ReleaseRecordingCaptureCommand(context.Context, sqlc.ReleaseRecordingCaptureCommandParams) (sqlc.RecordingCaptureCommand, error)
	ReserveRecordingCaptureProviderCall(context.Context) (pgtype.Timestamptz, error)
	SetRecordingCaptureConnectionActiveCommand(context.Context, sqlc.SetRecordingCaptureConnectionActiveCommandParams) (int64, error)
}

type RecordingCaptureSignalingRepository struct {
	transactor recordingPipelineTransactor
	decorate   func(sqlc.Querier) sqlc.Querier
	now        func() time.Time
}

func NewRecordingCaptureSignalingRepositoryWithTransactor(
	transactor recordingPipelineTransactor,
	decorate func(sqlc.Querier) sqlc.Querier,
) RecordingCaptureSignalingRepository {
	return RecordingCaptureSignalingRepository{transactor: transactor, decorate: decorate, now: time.Now}
}

func (r RecordingCaptureSignalingRepository) CheckDispatch(ctx context.Context, command capturesignaling.Command) error {
	_, err := withRecordingCaptureSignalingTransaction(ctx, r, func(queries recordingCaptureSignalingQuerier) (struct{}, error) {
		row, err := authorizeRecordingCaptureSignaling(ctx, queries, command.SignalingHandle, command.Authority, command.Lease)
		if err != nil {
			return struct{}{}, err
		}
		switch command.Identity.Operation {
		case captureplane.OperationCreateCaptureConnection, captureplane.OperationPullCaptureTracks, captureplane.OperationRenegotiateCaptureConnection:
			if row.MediaStopped {
				return struct{}{}, capturesignaling.ErrMediaStopped
			}
		}
		return struct{}{}, nil
	})
	return err
}

func (r RecordingCaptureSignalingRepository) PrepareCommand(ctx context.Context, request capturesignaling.PrepareRequest) (capturesignaling.PrepareResult, error) {
	return withRecordingCaptureSignalingTransaction(ctx, r, func(queries recordingCaptureSignalingQuerier) (capturesignaling.PrepareResult, error) {
		if _, err := lockRecordingCaptureSignalingAuthority(ctx, queries, request.Key.SignalingHandle, request.Authority, request.Lease); err != nil {
			return capturesignaling.PrepareResult{}, err
		}
		connectionIdentity := captureConnectionIdentity(request.Key, request.Authority.CaptureEpoch)
		_, insertErr := queries.InsertRecordingCaptureConnection(ctx, sqlc.InsertRecordingCaptureConnectionParams{
			SignalingHandle: uuidString(request.Key.SignalingHandle.String()), CaptureEpoch: int64(request.Authority.CaptureEpoch),
			TenantID: uuid(request.Authority.TenantID), SpaceID: uuid(request.Authority.SpaceID),
			EpisodeID: uuid(request.Authority.EpisodeID), RecordingID: uuid(request.Authority.RecordingID),
			JobID: uuid(request.Authority.JobID), AttemptCount: int32(request.Authority.AttemptCount),
			FencingGeneration: request.Authority.FencingGeneration, EnvelopeDigest: request.Authority.EnvelopeDigest,
		})
		if insertErr != nil && !errors.Is(insertErr, pgx.ErrNoRows) {
			return capturesignaling.PrepareResult{}, fmt.Errorf("insert recording capture connection: %w", insertErr)
		}
		connection, err := queries.LockRecordingCaptureConnection(ctx, connectionIdentity)
		if err != nil {
			return capturesignaling.PrepareResult{}, fmt.Errorf("lock recording capture connection: %w", err)
		}
		if err := validateRecordingCaptureConnectionAuthority(connection, request.Key.SignalingHandle, request.Authority); err != nil {
			return capturesignaling.PrepareResult{}, err
		}
		if _, err := authorizeRecordingCaptureSignaling(ctx, queries, request.Key.SignalingHandle, request.Authority, request.Lease); err != nil {
			return capturesignaling.PrepareResult{}, err
		}
		projection, err := mapRecordingCaptureConnectionProjection(connection)
		if err != nil {
			return capturesignaling.PrepareResult{}, err
		}

		stored, storedErr := queries.GetRecordingCaptureCommand(ctx, captureCommandIdentity(request.Key, request.Authority.CaptureEpoch))
		if storedErr == nil {
			if !bytes.Equal(stored.RequestFingerprint, request.Fingerprint[:]) || !bytes.Equal(stored.RequestBytes, request.RequestBytes) {
				return capturesignaling.PrepareResult{}, capturesignaling.ErrConflict
			}
			outcome, ambiguous, err := mapRecordingCaptureCommandOutcome(stored)
			if err != nil {
				return capturesignaling.PrepareResult{}, err
			}
			if ambiguous {
				return capturesignaling.PrepareResult{}, capturesignaling.ErrAmbiguousOutcome
			}
			return capturesignaling.PrepareResult{Outcome: outcome, CurrentProjection: projection}, nil
		}
		if !errors.Is(storedErr, pgx.ErrNoRows) {
			return capturesignaling.PrepareResult{}, fmt.Errorf("read recording capture command: %w", storedErr)
		}

		prepared := capturesignaling.PreparedCommand{
			SignalingHandle: request.Key.SignalingHandle, Authority: request.Authority,
			Identity: capturesignaling.CommandIdentity{
				Operation: request.Key.Operation, PlanRevision: request.Key.PlanRevision,
				IdempotencyKey: request.Key.IdempotencyKey,
			},
			Input: request.Input,
		}
		if err := prepared.ValidateAgainst(projection); err != nil {
			return capturesignaling.PrepareResult{}, err
		}
		sequence, err := queries.AdvanceRecordingCaptureCommandSequence(ctx, sqlc.AdvanceRecordingCaptureCommandSequenceParams(connectionIdentity))
		if err != nil {
			return capturesignaling.PrepareResult{}, fmt.Errorf("allocate recording capture command sequence: %w", err)
		}
		if _, err := queries.InsertRecordingCaptureCommand(ctx, sqlc.InsertRecordingCaptureCommandParams{
			SignalingHandle: connectionIdentity.SignalingHandle, CaptureEpoch: connectionIdentity.CaptureEpoch,
			Sequence: sequence, RecordingID: uuid(request.Authority.RecordingID),
			PlanRevision: int64(request.Key.PlanRevision), OperationKind: request.Key.Operation.String(),
			IdempotencyKey: request.Key.IdempotencyKey, RequestBytes: request.RequestBytes,
			RequestFingerprint: request.Fingerprint[:],
		}); err != nil {
			return capturesignaling.PrepareResult{}, fmt.Errorf("insert recording capture command: %w", err)
		}
		return capturesignaling.PrepareResult{Prepared: true, CurrentProjection: projection}, nil
	})
}

var _ capturesignaling.Port = RecordingCaptureSignalingRepository{}
