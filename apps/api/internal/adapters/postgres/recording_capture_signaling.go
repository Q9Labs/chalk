package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
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

func NewRecordingCaptureSignalingRepositoryWithPool(pool *pgxpool.Pool) RecordingCaptureSignalingRepository {
	return RecordingCaptureSignalingRepository{transactor: pool, now: time.Now}
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

func (r RecordingCaptureSignalingRepository) ClaimCommand(ctx context.Context, request capturesignaling.ClaimRequest) (capturesignaling.ClaimResult, error) {
	return withRecordingCaptureSignalingTransaction(ctx, r, func(queries recordingCaptureSignalingQuerier) (capturesignaling.ClaimResult, error) {
		if request.Owner != request.Lease.Owner {
			return capturesignaling.ClaimResult{}, capturesignaling.ErrStaleLease
		}
		if _, err := authorizeRecordingCaptureSignaling(ctx, queries, request.Key.SignalingHandle, request.Authority, request.Lease); err != nil {
			return capturesignaling.ClaimResult{}, err
		}
		connectionIdentity := captureConnectionIdentity(request.Key, request.Authority.CaptureEpoch)
		connection, err := queries.LockRecordingCaptureConnection(ctx, connectionIdentity)
		if err != nil {
			return capturesignaling.ClaimResult{}, capturesignaling.ErrStaleAuthority
		}
		authority, err := lockRecordingCaptureSignalingAuthority(ctx, queries, request.Key.SignalingHandle, request.Authority, request.Lease)
		if err != nil {
			return capturesignaling.ClaimResult{}, err
		}
		if err := validateRecordingCaptureConnectionAuthority(connection, request.Key.SignalingHandle, request.Authority); err != nil {
			return capturesignaling.ClaimResult{}, err
		}
		projection, err := mapRecordingCaptureConnectionProjection(connection)
		if err != nil {
			return capturesignaling.ClaimResult{}, err
		}
		command, err := queries.GetRecordingCaptureCommand(ctx, captureCommandIdentity(request.Key, request.Authority.CaptureEpoch))
		if errors.Is(err, pgx.ErrNoRows) {
			return capturesignaling.ClaimResult{}, capturesignaling.ErrStaleAuthority
		}
		if err != nil {
			return capturesignaling.ClaimResult{}, fmt.Errorf("read recording capture command: %w", err)
		}
		if err := requireRecordingCaptureCommandKey(command, request.Key, request.Authority); err != nil {
			return capturesignaling.ClaimResult{}, err
		}
		if !bytes.Equal(command.RequestFingerprint, request.Fingerprint[:]) || !bytes.Equal(command.RequestBytes, request.RequestBytes) {
			return capturesignaling.ClaimResult{}, capturesignaling.ErrConflict
		}
		outcome, ambiguous, err := mapRecordingCaptureCommandOutcome(command)
		if err != nil {
			return capturesignaling.ClaimResult{}, err
		}
		if ambiguous {
			return capturesignaling.ClaimResult{Ambiguous: true, CurrentProjection: projection}, nil
		}
		if len(outcome.ResultBytes) > 0 || outcome.ProviderFailure != nil {
			return capturesignaling.ClaimResult{Outcome: outcome, CurrentProjection: projection}, nil
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
			return capturesignaling.ClaimResult{}, err
		}

		now := r.now().UTC()
		if command.State == "leased" && !connection.ActiveCommandID.Valid {
			if command.ExecutionExpiresAt.Valid && !command.ExecutionExpiresAt.Time.After(now) {
				if _, err := queries.MarkRecordingCaptureCommandAmbiguous(ctx, command.ID); err != nil {
					return capturesignaling.ClaimResult{}, fmt.Errorf("mark orphaned recording capture command ambiguous: %w", err)
				}
				return capturesignaling.ClaimResult{Ambiguous: true, CurrentProjection: projection}, nil
			}
			return capturesignaling.ClaimResult{}, capturesignaling.ErrCorruptStoredResult
		}
		if connection.ActiveCommandID.Valid {
			if connection.ActiveExecutionExpiresAt.Valid && !connection.ActiveExecutionExpiresAt.Time.After(now) {
				expired, err := queries.MarkRecordingCaptureCommandAmbiguous(ctx, connection.ActiveCommandID.Int64)
				if err != nil {
					return capturesignaling.ClaimResult{}, fmt.Errorf("mark expired recording capture command ambiguous: %w", err)
				}
				if err := clearRecordingCaptureConnectionCommand(ctx, queries, connection, expired.ID, pgtype.UUID{}); err != nil {
					return capturesignaling.ClaimResult{}, err
				}
				if expired.ID == command.ID {
					return capturesignaling.ClaimResult{Ambiguous: true, CurrentProjection: projection}, nil
				}
				connection.ActiveCommandID = pgtype.Int8{}
				connection.ActiveExecutionToken = pgtype.UUID{}
				connection.ActiveExecutionExpiresAt = pgtype.Timestamptz{}
			} else {
				return capturesignaling.ClaimResult{CurrentProjection: projection}, nil
			}
		}
		first, err := queries.GetFirstOpenRecordingCaptureCommand(ctx, sqlc.GetFirstOpenRecordingCaptureCommandParams(connectionIdentity))
		if err != nil {
			return capturesignaling.ClaimResult{}, fmt.Errorf("read first recording capture command: %w", err)
		}
		if first.ID != command.ID {
			return capturesignaling.ClaimResult{CurrentProjection: projection}, nil
		}
		if first.NotBefore.Valid && first.NotBefore.Time.After(now) {
			return capturesignaling.ClaimResult{NotBefore: first.NotBefore.Time.UTC(), CurrentProjection: projection}, nil
		}
		executionID, err := utilities.NewID()
		if err != nil {
			return capturesignaling.ClaimResult{}, fmt.Errorf("generate recording capture execution token: %w", err)
		}
		expiresAt := now.Add(recordingCaptureExecutionLease)
		if authority.LeaseExpiresAt.Valid && authority.LeaseExpiresAt.Time.Before(expiresAt) {
			expiresAt = authority.LeaseExpiresAt.Time.UTC()
		}
		claimed, err := queries.ClaimRecordingCaptureCommand(ctx, sqlc.ClaimRecordingCaptureCommandParams{
			ExecutionToken: uuid(executionID), ExecutionExpiresAt: timestamptzValue(expiresAt), CommandID: command.ID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return capturesignaling.ClaimResult{CurrentProjection: projection}, nil
		}
		if err != nil {
			return capturesignaling.ClaimResult{}, fmt.Errorf("claim recording capture command: %w", err)
		}
		rows, err := queries.SetRecordingCaptureConnectionActiveCommand(ctx, sqlc.SetRecordingCaptureConnectionActiveCommandParams{
			CommandID: pgtype.Int8{Int64: claimed.ID, Valid: true}, ExecutionToken: uuid(executionID),
			ExecutionExpiresAt: timestamptzValue(expiresAt), SignalingHandle: connectionIdentity.SignalingHandle,
			CaptureEpoch: connectionIdentity.CaptureEpoch,
		})
		if err != nil || rows != 1 {
			return capturesignaling.ClaimResult{}, fmt.Errorf("activate recording capture command: affected=%d: %w", rows, err)
		}
		notBefore, err := queries.ReserveRecordingCaptureProviderCall(ctx)
		if err != nil || !notBefore.Valid {
			return capturesignaling.ClaimResult{}, fmt.Errorf("reserve recording capture provider call: %w", err)
		}
		if !notBefore.Time.Before(expiresAt) {
			return capturesignaling.ClaimResult{}, capturesignaling.ErrStaleLease
		}
		return capturesignaling.ClaimResult{
			Claimed: true, ClaimToken: executionID.String(), NotBefore: notBefore.Time.UTC(), CurrentProjection: projection,
		}, nil
	})
}

func (r RecordingCaptureSignalingRepository) ReleaseCommand(ctx context.Context, release capturesignaling.Release) error {
	_, err := withRecordingCaptureSignalingTransaction(ctx, r, func(queries recordingCaptureSignalingQuerier) (struct{}, error) {
		if _, err := lockRecordingCaptureSignalingAuthority(ctx, queries, release.Key.SignalingHandle, release.Authority, release.Lease); err != nil {
			return struct{}{}, err
		}
		connectionIdentity := captureConnectionIdentity(release.Key, release.Authority.CaptureEpoch)
		connection, err := queries.LockRecordingCaptureConnection(ctx, connectionIdentity)
		if err != nil {
			return struct{}{}, capturesignaling.ErrStaleAuthority
		}
		if _, err := authorizeRecordingCaptureSignaling(ctx, queries, release.Key.SignalingHandle, release.Authority, release.Lease); err != nil {
			return struct{}{}, err
		}
		if err := validateRecordingCaptureConnectionAuthority(connection, release.Key.SignalingHandle, release.Authority); err != nil {
			return struct{}{}, err
		}
		command, executionToken, err := validateRecordingCaptureCompletion(
			connection, release.Key, release.Authority, release.ClaimToken, r.now().UTC(), queries, ctx,
		)
		if err != nil {
			return struct{}{}, err
		}
		if _, err := queries.ReleaseRecordingCaptureCommand(ctx, sqlc.ReleaseRecordingCaptureCommandParams{
			CommandID: command.ID, ExecutionToken: executionToken,
		}); err != nil {
			return struct{}{}, fmt.Errorf("release recording capture command: %w", err)
		}
		if err := clearRecordingCaptureConnectionCommand(ctx, queries, connection, command.ID, executionToken); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	})
	return err
}

func (r RecordingCaptureSignalingRepository) CompleteCommand(ctx context.Context, completion capturesignaling.Completion) error {
	_, err := withRecordingCaptureSignalingTransaction(ctx, r, func(queries recordingCaptureSignalingQuerier) (struct{}, error) {
		if _, err := lockRecordingCaptureSignalingAuthority(ctx, queries, completion.Key.SignalingHandle, completion.Authority, completion.Lease); err != nil {
			return struct{}{}, err
		}
		connectionIdentity := captureConnectionIdentity(completion.Key, completion.Authority.CaptureEpoch)
		connection, err := queries.LockRecordingCaptureConnection(ctx, connectionIdentity)
		if err != nil {
			return struct{}{}, capturesignaling.ErrStaleAuthority
		}
		if err := validateRecordingCaptureConnectionAuthority(connection, completion.Key.SignalingHandle, completion.Authority); err != nil {
			return struct{}{}, err
		}
		if _, err := authorizeRecordingCaptureSignaling(ctx, queries, completion.Key.SignalingHandle, completion.Authority, completion.Lease); err != nil {
			return struct{}{}, err
		}
		command, executionToken, err := validateRecordingCaptureCompletion(connection, completion.Key, completion.Authority, completion.ClaimToken, r.now().UTC(), queries, ctx)
		if err != nil {
			return struct{}{}, err
		}
		if err := validateRecordingCaptureResult(completion, connection); err != nil {
			return struct{}{}, err
		}
		projection := completion.Projection
		providerReference := projection.Connection.ConnectionReference.String()
		negotiationID := nullableProviderReference(projection.NegotiationID)
		if _, err := queries.ApplyRecordingCaptureConnectionProjection(ctx, sqlc.ApplyRecordingCaptureConnectionProjectionParams{
			ProviderConnectionReference: requiredTextValue(providerReference), ConnectionState: projection.State.String(),
			PlanRevision: int64(projection.PlanRevision), NegotiationID: negotiationID,
			NegotiationRequirement: projection.NegotiationRequirement.String(),
			SignalingHandle:        connectionIdentity.SignalingHandle, CaptureEpoch: connectionIdentity.CaptureEpoch,
			CommandID: pgtype.Int8{Int64: command.ID, Valid: true}, ExecutionToken: executionToken,
		}); err != nil {
			return struct{}{}, fmt.Errorf("apply recording capture connection projection: %w", err)
		}
		resultFingerprint := sha256.Sum256(completion.ResultBytes)
		if _, err := queries.CompleteRecordingCaptureCommand(ctx, sqlc.CompleteRecordingCaptureCommandParams{
			ResultBytes: completion.ResultBytes, ResultFingerprint: resultFingerprint[:],
			CommandID: command.ID, ExecutionToken: executionToken,
		}); err != nil {
			return struct{}{}, fmt.Errorf("complete recording capture command: %w", err)
		}
		if err := clearRecordingCaptureConnectionCommand(ctx, queries, connection, command.ID, executionToken); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	})
	return err
}

func (r RecordingCaptureSignalingRepository) FailCommand(ctx context.Context, failure capturesignaling.Failure) error {
	_, err := withRecordingCaptureSignalingTransaction(ctx, r, func(queries recordingCaptureSignalingQuerier) (struct{}, error) {
		if _, err := lockRecordingCaptureSignalingAuthority(ctx, queries, failure.Key.SignalingHandle, failure.Authority, failure.Lease); err != nil {
			return struct{}{}, err
		}
		connectionIdentity := captureConnectionIdentity(failure.Key, failure.Authority.CaptureEpoch)
		connection, err := queries.LockRecordingCaptureConnection(ctx, connectionIdentity)
		if err != nil {
			return struct{}{}, capturesignaling.ErrStaleAuthority
		}
		if err := validateRecordingCaptureConnectionAuthority(connection, failure.Key.SignalingHandle, failure.Authority); err != nil {
			return struct{}{}, err
		}
		if _, err := authorizeRecordingCaptureSignaling(ctx, queries, failure.Key.SignalingHandle, failure.Authority, failure.Lease); err != nil {
			return struct{}{}, err
		}
		command, executionToken, err := validateRecordingCaptureCompletion(connection, failure.Key, failure.Authority, failure.ClaimToken, r.now().UTC(), queries, ctx)
		if err != nil {
			return struct{}{}, err
		}
		state := "terminal"
		notBefore := r.now().UTC()
		if failure.ProviderError.Retryable {
			state = "retryable"
			notBefore = notBefore.Add(recordingCaptureRetryDelay(int(command.ExecutionAttempt)))
		}
		providerCode := nullableCaptureProviderCode(failure.ProviderError.Code)
		if _, err := queries.FailRecordingCaptureCommand(ctx, sqlc.FailRecordingCaptureCommandParams{
			State: state, NotBefore: timestamptzValue(notBefore),
			ProviderFailureClass: requiredTextValue(string(failure.ProviderError.Class)),
			ProviderFailureCode:  text(providerCode), ProviderFailureRetryable: pgtype.Bool{Bool: failure.ProviderError.Retryable, Valid: true},
			CommandID: command.ID, ExecutionToken: executionToken,
		}); err != nil {
			return struct{}{}, fmt.Errorf("fail recording capture command: %w", err)
		}
		if err := clearRecordingCaptureConnectionCommand(ctx, queries, connection, command.ID, executionToken); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	})
	return err
}

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
		EnvelopeBytes: row.EnvelopeBytes, EnvelopeDigest: row.EnvelopeDigest,
		LeaseExpiresAt: row.LeaseExpiresAt, CheckedAt: row.CheckedAt,
		JobID: row.JobID, TenantID: row.TenantID, SpaceID: row.SpaceID,
		EpisodeID: row.EpisodeID, RecordingID: row.RecordingID,
		AttemptCount: row.AttemptCount, FencingGeneration: row.FencingGeneration, CaptureEpoch: row.CaptureEpoch,
	}
}

func mapLockedRecordingCaptureSignalingAuthority(row sqlc.LockRecordingCaptureSignalingAuthorityRow) recordingCaptureSignalingAuthority {
	return recordingCaptureSignalingAuthority{
		EnvelopeBytes: row.EnvelopeBytes, EnvelopeDigest: row.EnvelopeDigest,
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

func clearRecordingCaptureConnectionCommand(
	ctx context.Context,
	queries recordingCaptureSignalingQuerier,
	connection sqlc.RecordingCaptureConnection,
	commandID int64,
	executionToken pgtype.UUID,
) error {
	rows, err := queries.ClearRecordingCaptureConnectionActiveCommand(ctx, sqlc.ClearRecordingCaptureConnectionActiveCommandParams{
		SignalingHandle: connection.SignalingHandle, CaptureEpoch: connection.CaptureEpoch,
		CommandID: pgtype.Int8{Int64: commandID, Valid: true}, ExecutionToken: executionToken,
	})
	if err != nil || rows != 1 {
		return fmt.Errorf("clear recording capture active command: affected=%d: %w", rows, err)
	}
	return nil
}

func captureConnectionIdentity(key capturesignaling.CommandKey, captureEpoch captureplane.CaptureEpoch) sqlc.LockRecordingCaptureConnectionParams {
	return sqlc.LockRecordingCaptureConnectionParams{
		SignalingHandle: uuidString(key.SignalingHandle.String()),
		CaptureEpoch:    int64(captureEpoch),
	}
}

func captureCommandIdentity(key capturesignaling.CommandKey, captureEpoch captureplane.CaptureEpoch) sqlc.GetRecordingCaptureCommandParams {
	return sqlc.GetRecordingCaptureCommandParams{
		SignalingHandle: uuidString(key.SignalingHandle.String()),
		CaptureEpoch:    int64(captureEpoch),
		PlanRevision:    int64(key.PlanRevision),
		OperationKind:   key.Operation.String(),
		IdempotencyKey:  key.IdempotencyKey,
	}
}

func recordingCaptureRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := recordingCaptureRetryBase
	for index := 1; index < attempt && delay < recordingCaptureRetryMaximum; index++ {
		delay *= 2
	}
	if delay > recordingCaptureRetryMaximum {
		return recordingCaptureRetryMaximum
	}
	return delay
}

func nullableCaptureProviderCode(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

var _ capturesignaling.Port = RecordingCaptureSignalingRepository{}
