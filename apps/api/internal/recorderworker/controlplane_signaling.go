package recorderworker

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
)

// Execute sends one typed CapturePlane command through one of the six private
// signaling routes. The command identity is copied into the body unchanged,
// which makes retries use the same durable idempotency key.
func (c *ControlPlaneClient) Execute(ctx context.Context, request capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	return c.ExecuteCapture(ctx, request.Command)
}

func (c *ControlPlaneClient) ExecuteCapture(ctx context.Context, command capturesignaling.Command) (capturesignaling.Execution, error) {
	requestBody, operation, err := signalingRequest(command)
	if err != nil {
		return capturesignaling.Execution{}, err
	}
	path := recorderprotocol.CaptureSignalingRoutes[operation].Path()
	body, _, err := c.do(ctx, http.MethodPost, path, requestBody, ControlPlaneResponseLimit)
	if err != nil {
		var responseError HTTPError
		if errors.As(err, &responseError) && responseError.Status == http.StatusConflict && responseError.Code == recorderprotocol.CodeCaptureMediaStopped {
			return capturesignaling.Execution{}, capturesignaling.ErrMediaStopped
		}
		return capturesignaling.Execution{}, err
	}
	var response recorderprotocol.CaptureSignalingResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return capturesignaling.Execution{}, ProtocolError{Err: err}
	}
	resultBytes, err := json.Marshal(response.Result)
	if err != nil {
		return capturesignaling.Execution{}, ProtocolError{Err: err}
	}
	metadata := captureplane.OperationMetadata{
		Identity:     captureplane.CaptureIdentity{TenantID: command.Authority.TenantID, SpaceID: command.Authority.SpaceID, EpisodeID: command.Authority.EpisodeID, RecordingID: command.Authority.RecordingID},
		CaptureEpoch: command.Authority.CaptureEpoch, PlanRevision: command.Identity.PlanRevision, IdempotencyKey: command.Identity.IdempotencyKey,
	}
	result, err := capturesignaling.DecodeResult(resultBytes, operation, metadata)
	if err != nil {
		return capturesignaling.Execution{}, ProtocolError{Err: err}
	}
	return capturesignaling.Execution{
		Key:    capturesignaling.CommandKey{SignalingHandle: command.SignalingHandle, Operation: operation, PlanRevision: command.Identity.PlanRevision, IdempotencyKey: command.Identity.IdempotencyKey},
		Result: result, ResultBytes: resultBytes, Replayed: response.Replayed,
	}, nil
}

func signalingRequest(command capturesignaling.Command) (any, captureplane.OperationKind, error) {
	if _, _, err := capturesignaling.CanonicalRequest(command); err != nil {
		return nil, "", fmt.Errorf("%w: capture signaling: %v", ErrInvalidControlPlaneRequest, err)
	}
	base := recorderprotocol.CaptureAuthority{
		SignalingHandle: command.SignalingHandle.String(), TenantID: command.Authority.TenantID.String(), SpaceID: command.Authority.SpaceID.String(),
		EpisodeID: command.Authority.EpisodeID.String(), RecordingID: command.Authority.RecordingID.String(), JobID: command.Authority.JobID.String(),
		AttemptCount: command.Authority.AttemptCount, FencingGeneration: command.Authority.FencingGeneration,
		CaptureEpoch: int64(command.Authority.CaptureEpoch), EnvelopeDigest: hex.EncodeToString(command.Authority.EnvelopeDigest),
		LeaseToken: command.Lease.Token, LeaseExpiresAt: command.Lease.ExpiresAt.UTC().Format(time.RFC3339Nano),
		PlanRevision: int64(command.Identity.PlanRevision), IdempotencyKey: command.Identity.IdempotencyKey,
	}
	switch command.Identity.Operation {
	case captureplane.OperationCreateCaptureConnection:
		if command.Input.CreateCaptureConnection == nil {
			return nil, "", fmt.Errorf("%w: create input", ErrInvalidControlPlaneRequest)
		}
		return base, command.Identity.Operation, nil
	case captureplane.OperationPullCaptureTracks:
		value := command.Input.PullCaptureTracks
		if value == nil {
			return nil, "", fmt.Errorf("%w: pull input", ErrInvalidControlPlaneRequest)
		}
		return recorderprotocol.CapturePullRequest{CaptureAuthority: base, Connection: value.Connection.String(), Tracks: captureTrackRequests(value.Tracks), LocalDescription: value.LocalDescription}, command.Identity.Operation, nil
	case captureplane.OperationRenegotiateCaptureConnection:
		value := command.Input.RenegotiateCaptureConnection
		if value == nil {
			return nil, "", fmt.Errorf("%w: renegotiate input", ErrInvalidControlPlaneRequest)
		}
		return recorderprotocol.CaptureRenegotiateRequest{CaptureAuthority: base, Connection: value.Connection.String(), NegotiationID: value.NegotiationID.String(), Description: value.Description}, command.Identity.Operation, nil
	case captureplane.OperationInspectCaptureConnection:
		value := command.Input.InspectCaptureConnection
		if value == nil {
			return nil, "", fmt.Errorf("%w: inspect input", ErrInvalidControlPlaneRequest)
		}
		return recorderprotocol.CaptureInspectRequest{CaptureAuthority: base, Connection: value.Connection.String(), Tracks: pulledTrackRequests(value.Tracks)}, command.Identity.Operation, nil
	case captureplane.OperationCloseCaptureTracks:
		value := command.Input.CloseCaptureTracks
		if value == nil {
			return nil, "", fmt.Errorf("%w: close tracks input", ErrInvalidControlPlaneRequest)
		}
		return recorderprotocol.CaptureCloseTracksRequest{CaptureAuthority: base, Connection: value.Connection.String(), Tracks: pulledTrackRequests(value.Tracks)}, command.Identity.Operation, nil
	case captureplane.OperationCloseCaptureConnection:
		value := command.Input.CloseCaptureConnection
		if value == nil {
			return nil, "", fmt.Errorf("%w: close connection input", ErrInvalidControlPlaneRequest)
		}
		return recorderprotocol.CaptureCloseConnectionRequest{CaptureAuthority: base, Connection: value.Connection.String(), Tracks: pulledTrackRequests(value.Tracks), Force: value.Force}, command.Identity.Operation, nil
	default:
		return nil, "", fmt.Errorf("%w: operation", ErrInvalidControlPlaneRequest)
	}
}

func captureTrackRequests(values []captureplane.CaptureTrack) []recorderprotocol.CaptureTrack {
	result := make([]recorderprotocol.CaptureTrack, len(values))
	for index, value := range values {
		result[index] = recorderprotocol.CaptureTrack{OwnerReference: value.OwnerReference.String(), TrackReference: value.TrackReference.String(), ParticipantID: value.ParticipantID.String(), ParticipantGeneration: value.ParticipantGeneration, Source: value.Source.String(), Kind: value.Kind.String(), RequestedLayer: value.RequestedLayer.String()}
	}
	return result
}

func pulledTrackRequests(values []captureplane.PulledCaptureTrack) []recorderprotocol.CapturePulledTrack {
	result := make([]recorderprotocol.CapturePulledTrack, len(values))
	for index, value := range values {
		result[index] = recorderprotocol.CapturePulledTrack{OwnerReference: value.OwnerReference.String(), TrackReference: value.TrackReference.String(), ParticipantID: value.ParticipantID.String(), ParticipantGeneration: value.ParticipantGeneration, Source: value.Source.String(), Kind: value.Kind.String(), RequestedLayer: value.RequestedLayer.String(), MID: value.MID.String()}
	}
	return result
}
