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
			// Retiring a quiescent session must not wait behind an abandoned
			// media command. The active-command fence above still blocks I/O.
			closingMedia := request.Key.Operation == captureplane.OperationCloseCaptureConnection &&
				(first.OperationKind == captureplane.OperationCreateCaptureConnection.String() ||
					first.OperationKind == captureplane.OperationPullCaptureTracks.String() ||
					first.OperationKind == captureplane.OperationRenegotiateCaptureConnection.String())
			if !closingMedia {
				return capturesignaling.ClaimResult{CurrentProjection: projection}, nil
			}
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
			return capturesignaling.ClaimResult{NotBefore: timestamp(first.NotBefore), CurrentProjection: projection}, nil
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
