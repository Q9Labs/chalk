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
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r RecordingCaptureSignalingRepository) ClaimCommand(ctx context.Context, request capturesignaling.ClaimRequest) (capturesignaling.ClaimResult, error) {
	return withRecordingCaptureSignalingTransaction(ctx, r, func(queries recordingCaptureSignalingQuerier) (capturesignaling.ClaimResult, error) {
		return r.claimCommand(ctx, queries, request)
	})
}

// captureClaimTarget is the locked connection, authority and command a claim works on.
type captureClaimTarget struct {
	identity   sqlc.LockRecordingCaptureConnectionParams
	connection sqlc.RecordingCaptureConnection
	authority  recordingCaptureSignalingAuthority
	command    sqlc.RecordingCaptureCommand
	projection *capturesignaling.ConnectionProjection
}

func (r RecordingCaptureSignalingRepository) claimCommand(ctx context.Context, queries recordingCaptureSignalingQuerier, request capturesignaling.ClaimRequest) (capturesignaling.ClaimResult, error) {
	target, err := loadCaptureClaimTarget(ctx, queries, request)
	if err != nil {
		return capturesignaling.ClaimResult{}, err
	}
	if result, done, err := target.storedResult(); err != nil || done {
		return result, err
	}
	prepared := capturesignaling.PreparedCommand{
		SignalingHandle: request.Key.SignalingHandle, Authority: request.Authority,
		Identity: capturesignaling.CommandIdentity{
			Operation: request.Key.Operation, PlanRevision: request.Key.PlanRevision,
			IdempotencyKey: request.Key.IdempotencyKey,
		},
		Input: request.Input,
	}
	if err := prepared.ValidateAgainst(target.projection); err != nil {
		return capturesignaling.ClaimResult{}, err
	}
	now := r.now().UTC()
	if result, done, err := target.settleActiveCommand(ctx, queries, now); err != nil || done {
		return result, err
	}
	first, err := queries.GetFirstOpenRecordingCaptureCommand(ctx, sqlc.GetFirstOpenRecordingCaptureCommandParams(target.identity))
	if err != nil {
		return capturesignaling.ClaimResult{}, fmt.Errorf("read first recording capture command: %w", err)
	}
	if first.ID != target.command.ID && !closesIdleMedia(request.Key.Operation, first.OperationKind) {
		return capturesignaling.ClaimResult{CurrentProjection: target.projection}, nil
	}
	return target.activate(ctx, queries, first, now)
}

// loadCaptureClaimTarget locks and validates everything a claim depends on, in the order the other
// signaling writers use.
func loadCaptureClaimTarget(ctx context.Context, queries recordingCaptureSignalingQuerier, request capturesignaling.ClaimRequest) (captureClaimTarget, error) {
	if request.Owner != request.Lease.Owner {
		return captureClaimTarget{}, capturesignaling.ErrStaleLease
	}
	if _, err := authorizeRecordingCaptureSignaling(ctx, queries, request.Key.SignalingHandle, request.Authority, request.Lease); err != nil {
		return captureClaimTarget{}, err
	}
	identity := captureConnectionIdentity(request.Key, request.Authority.CaptureEpoch)
	connection, err := queries.LockRecordingCaptureConnection(ctx, identity)
	if err != nil {
		return captureClaimTarget{}, capturesignaling.ErrStaleAuthority
	}
	authority, err := lockRecordingCaptureSignalingAuthority(ctx, queries, request.Key.SignalingHandle, request.Authority, request.Lease)
	if err != nil {
		return captureClaimTarget{}, err
	}
	if err := validateRecordingCaptureConnectionAuthority(connection, request.Key.SignalingHandle, request.Authority); err != nil {
		return captureClaimTarget{}, err
	}
	projection, err := mapRecordingCaptureConnectionProjection(connection)
	if err != nil {
		return captureClaimTarget{}, err
	}
	command, err := queries.GetRecordingCaptureCommand(ctx, captureCommandIdentity(request.Key, request.Authority.CaptureEpoch))
	if errors.Is(err, pgx.ErrNoRows) {
		return captureClaimTarget{}, capturesignaling.ErrStaleAuthority
	}
	if err != nil {
		return captureClaimTarget{}, fmt.Errorf("read recording capture command: %w", err)
	}
	if err := requireRecordingCaptureCommandKey(command, request.Key, request.Authority); err != nil {
		return captureClaimTarget{}, err
	}
	if !bytes.Equal(command.RequestFingerprint, request.Fingerprint[:]) || !bytes.Equal(command.RequestBytes, request.RequestBytes) {
		return captureClaimTarget{}, capturesignaling.ErrConflict
	}
	return captureClaimTarget{identity: identity, connection: connection, authority: authority, command: command, projection: projection}, nil
}

// storedResult answers a claim whose command already has an outcome or is ambiguous.
func (t captureClaimTarget) storedResult() (capturesignaling.ClaimResult, bool, error) {
	outcome, ambiguous, err := mapRecordingCaptureCommandOutcome(t.command)
	if err != nil {
		return capturesignaling.ClaimResult{}, false, err
	}
	if ambiguous {
		return capturesignaling.ClaimResult{Ambiguous: true, CurrentProjection: t.projection}, true, nil
	}
	if len(outcome.ResultBytes) > 0 || outcome.ProviderFailure != nil {
		return capturesignaling.ClaimResult{Outcome: outcome, CurrentProjection: t.projection}, true, nil
	}
	return capturesignaling.ClaimResult{}, false, nil
}

// settleActiveCommand resolves the command that holds the connection. An expired one becomes ambiguous
// and frees the connection; a live one makes this claim wait.
func (t captureClaimTarget) settleActiveCommand(ctx context.Context, queries recordingCaptureSignalingQuerier, now time.Time) (capturesignaling.ClaimResult, bool, error) {
	connection, command := t.connection, t.command
	ambiguous := capturesignaling.ClaimResult{Ambiguous: true, CurrentProjection: t.projection}
	if command.State == "leased" && !connection.ActiveCommandID.Valid {
		if command.ExecutionExpiresAt.Valid && !command.ExecutionExpiresAt.Time.After(now) {
			if _, err := queries.MarkRecordingCaptureCommandAmbiguous(ctx, command.ID); err != nil {
				return capturesignaling.ClaimResult{}, true, fmt.Errorf("mark orphaned recording capture command ambiguous: %w", err)
			}
			return ambiguous, true, nil
		}
		return capturesignaling.ClaimResult{}, true, capturesignaling.ErrCorruptStoredResult
	}
	if !connection.ActiveCommandID.Valid {
		return capturesignaling.ClaimResult{}, false, nil
	}
	if !connection.ActiveExecutionExpiresAt.Valid || connection.ActiveExecutionExpiresAt.Time.After(now) {
		return capturesignaling.ClaimResult{CurrentProjection: t.projection}, true, nil
	}
	expired, err := queries.MarkRecordingCaptureCommandAmbiguous(ctx, connection.ActiveCommandID.Int64)
	if err != nil {
		return capturesignaling.ClaimResult{}, true, fmt.Errorf("mark expired recording capture command ambiguous: %w", err)
	}
	if err := clearRecordingCaptureConnectionCommand(ctx, queries, connection, expired.ID, pgtype.UUID{}); err != nil {
		return capturesignaling.ClaimResult{}, true, err
	}
	return ambiguous, expired.ID == command.ID, nil
}

// closesIdleMedia reports whether a close may overtake the media command ahead of it. Retiring a
// quiescent session must not wait behind an abandoned media command; the active-command fence still
// blocks I/O.
func closesIdleMedia(operation captureplane.OperationKind, firstKind string) bool {
	return operation == captureplane.OperationCloseCaptureConnection &&
		(firstKind == captureplane.OperationCreateCaptureConnection.String() ||
			firstKind == captureplane.OperationPullCaptureTracks.String() ||
			firstKind == captureplane.OperationRenegotiateCaptureConnection.String())
}

func (t captureClaimTarget) activate(ctx context.Context, queries recordingCaptureSignalingQuerier, first sqlc.RecordingCaptureCommand, now time.Time) (capturesignaling.ClaimResult, error) {
	executionID, err := utilities.NewID()
	if err != nil {
		return capturesignaling.ClaimResult{}, fmt.Errorf("generate recording capture execution token: %w", err)
	}
	expiresAt := now.Add(recordingCaptureExecutionLease)
	if t.authority.LeaseExpiresAt.Valid && t.authority.LeaseExpiresAt.Time.Before(expiresAt) {
		expiresAt = t.authority.LeaseExpiresAt.Time.UTC()
	}
	claimed, err := queries.ClaimRecordingCaptureCommand(ctx, sqlc.ClaimRecordingCaptureCommandParams{
		ExecutionToken: uuid(executionID), ExecutionExpiresAt: timestamptzValue(expiresAt), CommandID: t.command.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return capturesignaling.ClaimResult{NotBefore: timestamp(first.NotBefore), CurrentProjection: t.projection}, nil
	}
	if err != nil {
		return capturesignaling.ClaimResult{}, fmt.Errorf("claim recording capture command: %w", err)
	}
	rows, err := queries.SetRecordingCaptureConnectionActiveCommand(ctx, sqlc.SetRecordingCaptureConnectionActiveCommandParams{
		CommandID: pgtype.Int8{Int64: claimed.ID, Valid: true}, ExecutionToken: uuid(executionID),
		ExecutionExpiresAt: timestamptzValue(expiresAt), SignalingHandle: t.identity.SignalingHandle,
		CaptureEpoch: t.identity.CaptureEpoch,
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
		Claimed: true, ClaimToken: executionID.String(), NotBefore: notBefore.Time.UTC(), CurrentProjection: t.projection,
	}, nil
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
