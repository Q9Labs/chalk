package postgres

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func validateRecordingCaptureConnectionAuthority(
	connection sqlc.RecordingCaptureConnection,
	handle capturesignaling.SignalingHandle,
	authority capturesignaling.CommandAuthority,
) error {
	if !connection.SignalingHandle.Valid || utilities.IDFromBytes(connection.SignalingHandle.Bytes).String() != handle.String() ||
		connection.CaptureEpoch != int64(authority.CaptureEpoch) || utilities.IDFromBytes(connection.TenantID.Bytes) != authority.TenantID ||
		utilities.IDFromBytes(connection.SpaceID.Bytes) != authority.SpaceID || utilities.IDFromBytes(connection.EpisodeID.Bytes) != authority.EpisodeID ||
		utilities.IDFromBytes(connection.RecordingID.Bytes) != authority.RecordingID || utilities.IDFromBytes(connection.JobID.Bytes) != authority.JobID ||
		int(connection.AttemptCount) != authority.AttemptCount || connection.FencingGeneration != authority.FencingGeneration ||
		!bytes.Equal(connection.EnvelopeDigest, authority.EnvelopeDigest) {
		return capturesignaling.ErrStaleAuthority
	}
	return nil
}

func mapRecordingCaptureConnectionProjection(connection sqlc.RecordingCaptureConnection) (*capturesignaling.ConnectionProjection, error) {
	if !connection.ProviderConnectionReference.Valid {
		if connection.State != "pending" || connection.LatestPlanRevision != 0 || connection.NegotiationID.Valid || connection.NegotiationRequirement != captureplane.NegotiationNotRequired.String() {
			return nil, capturesignaling.ErrCorruptStoredResult
		}
		return nil, nil
	}
	providerReference, err := captureplane.NewProviderReference(connection.ProviderConnectionReference.String)
	if err != nil || connection.LatestPlanRevision <= 0 {
		return nil, capturesignaling.ErrCorruptStoredResult
	}
	handle, err := capturesignaling.NewSignalingHandle(utilities.IDFromBytes(connection.SignalingHandle.Bytes).String())
	if err != nil {
		return nil, capturesignaling.ErrCorruptStoredResult
	}
	projection := &capturesignaling.ConnectionProjection{
		SignalingHandle: handle,
		Connection: captureplane.CaptureConnection{
			ConnectionReference: providerReference, CaptureEpoch: captureplane.CaptureEpoch(connection.CaptureEpoch),
			PlanRevision: captureplane.PlanRevision(connection.LatestPlanRevision),
		},
		CaptureEpoch: captureplane.CaptureEpoch(connection.CaptureEpoch), PlanRevision: captureplane.PlanRevision(connection.LatestPlanRevision),
		NegotiationRequirement: captureplane.NegotiationRequirement(connection.NegotiationRequirement),
		State:                  captureplane.CaptureConnectionState(connection.State), Closed: connection.State == captureplane.CaptureConnectionClosed.String(),
	}
	if connection.NegotiationID.Valid {
		if !connection.NegotiationPlanRevision.Valid || connection.NegotiationPlanRevision.Int64 != connection.LatestPlanRevision {
			return nil, capturesignaling.ErrCorruptStoredResult
		}
		negotiationID, err := captureplane.NewProviderReference(connection.NegotiationID.String)
		if err != nil {
			return nil, capturesignaling.ErrCorruptStoredResult
		}
		projection.NegotiationID = negotiationID
	}
	if err := projection.Validate(); err != nil {
		return nil, capturesignaling.ErrCorruptStoredResult
	}
	return projection, nil
}

func mapRecordingCaptureCommandOutcome(command sqlc.RecordingCaptureCommand) (capturesignaling.StoredOutcome, bool, error) {
	switch command.State {
	case "queued", "leased", "retryable":
		return capturesignaling.StoredOutcome{}, false, nil
	case "ambiguous":
		return capturesignaling.StoredOutcome{}, true, nil
	case "completed":
		fingerprint := sha256.Sum256(command.ResultBytes)
		if len(command.ResultBytes) == 0 || !bytes.Equal(fingerprint[:], command.ResultFingerprint) {
			return capturesignaling.StoredOutcome{}, false, capturesignaling.ErrCorruptStoredResult
		}
		return capturesignaling.StoredOutcome{ResultBytes: append([]byte(nil), command.ResultBytes...)}, false, nil
	case "terminal":
		if !command.ProviderFailureClass.Valid || !command.ProviderFailureRetryable.Valid || command.ProviderFailureRetryable.Bool {
			return capturesignaling.StoredOutcome{}, false, capturesignaling.ErrCorruptStoredResult
		}
		failure := captureplane.ProviderError{
			Class: captureplane.ProviderFailureClass(command.ProviderFailureClass.String),
			Code:  command.ProviderFailureCode.String, Retryable: false,
		}
		return capturesignaling.StoredOutcome{ProviderFailure: &failure}, false, nil
	default:
		return capturesignaling.StoredOutcome{}, false, capturesignaling.ErrCorruptStoredResult
	}
}

func validateRecordingCaptureResult(completion capturesignaling.Completion, currentConnection sqlc.RecordingCaptureConnection) error {
	if completion.Projection == nil {
		return capturesignaling.ErrCorruptStoredResult
	}
	metadata := captureplane.OperationMetadata{
		Identity: captureplane.CaptureIdentity{
			TenantID: completion.Authority.TenantID, SpaceID: completion.Authority.SpaceID,
			EpisodeID: completion.Authority.EpisodeID, RecordingID: completion.Authority.RecordingID,
		},
		CaptureEpoch: completion.Authority.CaptureEpoch, PlanRevision: completion.Key.PlanRevision,
		IdempotencyKey: completion.Key.IdempotencyKey,
	}
	result, err := capturesignaling.DecodeResult(completion.ResultBytes, completion.Key.Operation, metadata)
	if err != nil {
		return capturesignaling.ErrCorruptStoredResult
	}
	if err := completion.Projection.Validate(); err != nil || completion.Projection.SignalingHandle != completion.Key.SignalingHandle ||
		completion.Projection.CaptureEpoch != completion.Authority.CaptureEpoch || completion.Projection.PlanRevision != completion.Key.PlanRevision {
		return capturesignaling.ErrCorruptStoredResult
	}
	connection, negotiation, state, closed, err := recordingCaptureResultProjection(result, completion.Key.Operation, currentConnection)
	if err != nil || completion.Projection.Connection != connection || completion.Projection.NegotiationID != negotiation.ID ||
		completion.Projection.NegotiationRequirement != negotiation.Requirement || completion.Projection.State != state ||
		completion.Projection.Closed != closed {
		return capturesignaling.ErrCorruptStoredResult
	}
	if completion.Key.Operation == captureplane.OperationCreateCaptureConnection {
		if currentConnection.ProviderConnectionReference.Valid {
			return capturesignaling.ErrStaleConnection
		}
	} else if !currentConnection.ProviderConnectionReference.Valid || completion.Projection.Connection.ConnectionReference.String() != currentConnection.ProviderConnectionReference.String {
		return capturesignaling.ErrStaleConnection
	}
	return nil
}

func recordingCaptureResultProjection(
	result capturesignaling.CommandResult,
	operation captureplane.OperationKind,
	currentConnection sqlc.RecordingCaptureConnection,
) (captureplane.CaptureConnection, captureplane.Negotiation, captureplane.CaptureConnectionState, bool, error) {
	currentState := captureplane.CaptureConnectionState(currentConnection.State)
	currentNegotiation := captureplane.Negotiation{Requirement: captureplane.NegotiationRequirement(currentConnection.NegotiationRequirement)}
	if currentConnection.NegotiationID.Valid {
		currentNegotiation.ID = captureplane.ProviderReference(currentConnection.NegotiationID.String)
	}
	switch operation {
	case captureplane.OperationCreateCaptureConnection:
		return result.CreateCaptureConnection.Connection, result.CreateCaptureConnection.Negotiation, captureplane.CaptureConnectionConnecting, false, nil
	case captureplane.OperationPullCaptureTracks:
		return result.PullCaptureTracks.Connection, result.PullCaptureTracks.Negotiation, currentState, currentState == captureplane.CaptureConnectionClosed, nil
	case captureplane.OperationRenegotiateCaptureConnection:
		return result.RenegotiateCaptureConnection.Connection, result.RenegotiateCaptureConnection.Negotiation, currentState, currentState == captureplane.CaptureConnectionClosed, nil
	case captureplane.OperationInspectCaptureConnection:
		return result.InspectCaptureConnection.Connection, result.InspectCaptureConnection.Negotiation, result.InspectCaptureConnection.State, result.InspectCaptureConnection.State == captureplane.CaptureConnectionClosed, nil
	case captureplane.OperationCloseCaptureTracks:
		return result.CloseCaptureTracks.Connection, result.CloseCaptureTracks.Negotiation, currentState, currentState == captureplane.CaptureConnectionClosed, nil
	case captureplane.OperationCloseCaptureConnection:
		if result.CloseCaptureConnection.Closed {
			return result.CloseCaptureConnection.Connection, captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}, captureplane.CaptureConnectionClosed, true, nil
		}
		return result.CloseCaptureConnection.Connection, currentNegotiation, currentState, currentState == captureplane.CaptureConnectionClosed, nil
	default:
		return captureplane.CaptureConnection{}, captureplane.Negotiation{}, "", false, errors.New("unknown recording capture operation")
	}
}

func nullableProviderReference(reference captureplane.ProviderReference) pgtype.Text {
	if reference.IsZero() {
		return pgtype.Text{}
	}
	return requiredTextValue(reference.String())
}

func requireRecordingCaptureCommandKey(command sqlc.RecordingCaptureCommand, key capturesignaling.CommandKey, authority capturesignaling.CommandAuthority) error {
	if !command.SignalingHandle.Valid || utilities.IDFromBytes(command.SignalingHandle.Bytes).String() != key.SignalingHandle.String() ||
		command.CaptureEpoch != int64(authority.CaptureEpoch) || !command.RecordingID.Valid || utilities.IDFromBytes(command.RecordingID.Bytes) != authority.RecordingID ||
		command.PlanRevision != int64(key.PlanRevision) || command.OperationKind != key.Operation.String() || command.IdempotencyKey != key.IdempotencyKey {
		return fmt.Errorf("recording capture command key mismatch: %w", capturesignaling.ErrStaleAuthority)
	}
	return nil
}
