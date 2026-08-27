package capturesignaling

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

type canonicalRequest struct {
	SignalingHandle SignalingHandle  `json:"signaling_handle"`
	Authority       CommandAuthority `json:"authority"`
	Identity        CommandIdentity  `json:"identity"`
	Input           CommandInput     `json:"input"`
}

// CanonicalRequest returns the immutable request bytes and digest used by the
// persistence port. Lease credentials are excluded so renewal is replay-safe.
func CanonicalRequest(command Command) ([]byte, [32]byte, error) {
	_, _, requestBytes, fingerprint, _, err := canonicalCommandAt(command, timeNow())
	return requestBytes, fingerprint, err
}

func canonicalCommandAt(c Command, now time.Time) (Command, CommandKey, []byte, [32]byte, captureplane.OperationMetadata, error) {
	normalized, metadata, err := c.validate(now)
	if err != nil {
		return Command{}, CommandKey{}, nil, [32]byte{}, captureplane.OperationMetadata{}, err
	}
	operation, err := normalized.Identity.operation()
	if err != nil {
		return Command{}, CommandKey{}, nil, [32]byte{}, captureplane.OperationMetadata{}, err
	}
	normalized.Authority.EnvelopeDigest = append([]byte(nil), normalized.Authority.EnvelopeDigest...)
	request := canonicalRequest{
		SignalingHandle: normalized.SignalingHandle,
		Authority:       normalized.Authority,
		Identity:        normalized.Identity,
		Input:           normalized.Input,
	}
	requestBytes, err := json.Marshal(request)
	if err != nil {
		return Command{}, CommandKey{}, nil, [32]byte{}, captureplane.OperationMetadata{}, fmt.Errorf("%w: marshal request: %v", ErrInvalidCommand, err)
	}
	key := CommandKey{
		SignalingHandle: normalized.SignalingHandle,
		Operation:       operation,
		PlanRevision:    normalized.Identity.PlanRevision,
		IdempotencyKey:  normalized.Identity.IdempotencyKey,
	}
	return normalized, key, requestBytes, sha256.Sum256(requestBytes), metadata, nil
}

func timeNow() time.Time { return time.Now() }

// MarshalResult validates and encodes one typed provider result. The bytes are
// the exact bytes that persistence must retain for deterministic replay.
func MarshalResult(result CommandResult, metadata captureplane.OperationMetadata, operation captureplane.OperationKind) ([]byte, error) {
	if err := result.validateAgainst(metadata, operation); err != nil {
		return nil, err
	}
	bytes, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("%w: marshal result: %v", ErrProviderFailure, err)
	}
	return bytes, nil
}

// DecodeResult decodes exactly one operation-specific result and rejects
// trailing JSON or an operation union that does not match kind.
func DecodeResult(data []byte, kind captureplane.OperationKind, metadata captureplane.OperationMetadata) (CommandResult, error) {
	if len(data) == 0 {
		return CommandResult{}, CorruptResultError{Operation: kind}
	}
	var result CommandResult
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&result); err != nil {
		return CommandResult{}, CorruptResultError{Operation: kind}
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		return CommandResult{}, CorruptResultError{Operation: kind}
	}
	if err := result.validateAgainst(metadata, kind); err != nil {
		return CommandResult{}, CorruptResultError{Operation: kind}
	}
	return result, nil
}

func resultProjection(handle SignalingHandle, authority CommandAuthority, operation captureplane.OperationKind, result CommandResult, existing *ConnectionProjection) (*ConnectionProjection, error) {
	if operation != captureplane.OperationCreateCaptureConnection && existing == nil {
		return nil, FenceError{Kind: "connection"}
	}
	projection := ConnectionProjection{SignalingHandle: handle, CaptureEpoch: authority.CaptureEpoch, PlanRevision: 0}
	if existing != nil {
		copyProjection := *existing
		projection = copyProjection
		projection.SignalingHandle = handle
		projection.CaptureEpoch = authority.CaptureEpoch
	}
	setNegotiation := func(connection captureplane.CaptureConnection, negotiation captureplane.Negotiation) error {
		projection.Connection = connection
		projection.CaptureEpoch = connection.CaptureEpoch
		projection.PlanRevision = connection.PlanRevision
		// A provider answer is applied by the capture worker locally. It is a
		// terminal result for this command, so it must never become a durable
		// renegotiation fence.
		if negotiation.Requirement == captureplane.NegotiationRemoteAnswer {
			projection.NegotiationRequirement = captureplane.NegotiationNotRequired
			projection.NegotiationID = ""
		} else {
			projection.NegotiationRequirement = negotiation.Requirement
		}
		if projection.NegotiationRequirement == captureplane.NegotiationNotRequired {
			projection.NegotiationID = ""
		} else {
			projection.NegotiationID = negotiation.ID
		}
		return projection.Validate()
	}
	switch operation {
	case captureplane.OperationCreateCaptureConnection:
		if err := setNegotiation(result.CreateCaptureConnection.Connection, result.CreateCaptureConnection.Negotiation); err != nil {
			return nil, err
		}
		projection.State = captureplane.CaptureConnectionConnecting
		return &projection, nil
	case captureplane.OperationPullCaptureTracks:
		return &projection, setNegotiation(result.PullCaptureTracks.Connection, result.PullCaptureTracks.Negotiation)
	case captureplane.OperationRenegotiateCaptureConnection:
		return &projection, setNegotiation(result.RenegotiateCaptureConnection.Connection, result.RenegotiateCaptureConnection.Negotiation)
	case captureplane.OperationInspectCaptureConnection:
		if err := setNegotiation(result.InspectCaptureConnection.Connection, result.InspectCaptureConnection.Negotiation); err != nil {
			return nil, err
		}
		projection.State = result.InspectCaptureConnection.State
		return &projection, nil
	case captureplane.OperationCloseCaptureTracks:
		return &projection, setNegotiation(result.CloseCaptureTracks.Connection, result.CloseCaptureTracks.Negotiation)
	case captureplane.OperationCloseCaptureConnection:
		projection.Connection = result.CloseCaptureConnection.Connection
		projection.CaptureEpoch = result.CloseCaptureConnection.Connection.CaptureEpoch
		projection.PlanRevision = result.CloseCaptureConnection.Connection.PlanRevision
		if result.CloseCaptureConnection.Closed {
			projection.Closed = true
			projection.State = captureplane.CaptureConnectionClosed
			projection.NegotiationRequirement = captureplane.NegotiationNotRequired
			projection.NegotiationID = ""
		}
		return &projection, projection.Validate()
	default:
		return nil, fmt.Errorf("%w: unknown result operation", ErrProviderFailure)
	}
}
