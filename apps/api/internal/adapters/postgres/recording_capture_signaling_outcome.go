package postgres

import (
	"context"
	"crypto/sha256"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
)

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

func nullableCaptureProviderCode(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
