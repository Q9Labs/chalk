package chalksfu

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// A recorder reaches the node through a capture session: receive-only, with no Participant
// slot. Its scope names the Episode the recorder captures, the Recording as the session's
// participant, and the capture epoch as its generation, so the node fences an older epoch.
const (
	captureReplayCapacity = 1024
	captureSessionKind    = "capture"
	captureTrackNotFound  = "track_not_found"
)

var _ captureplane.CapturePlane = (*Adapter)(nil)

func captureScope(metadata captureplane.OperationMetadata) wireScope {
	identity := metadata.Identity
	return wireScope{
		TenantID:      identity.TenantID.String(),
		EpisodeID:     identity.EpisodeID.String(),
		ParticipantID: "capture:" + identity.RecordingID.String(),
		Generation:    int64(metadata.CaptureEpoch),
	}
}

// captureOperationID derives the node's operation ID from the idempotency key, so a retry
// after an API restart repeats the same operation and the node answers it once.
func captureOperationID(metadata captureplane.OperationMetadata, operation captureplane.OperationKind) (string, error) {
	scope, err := metadata.IdempotencyScope(operation)
	if err != nil {
		return "", err
	}
	return "cap-" + hex.EncodeToString(scope[:16]), nil
}

// captureFailure maps a node failure to the port's bounded errors. A retry of a failed
// operation repeats its operation ID, which the node answers once, so transient failures retry.
func captureFailure(operation captureplane.OperationKind, metadata captureplane.OperationMetadata, err error) error {
	switch {
	case errors.Is(err, errStaleGeneration):
		return captureplane.NewFencedError(operation, captureplane.FencedByCaptureEpoch, 0, metadata.CaptureEpoch, 0, 0)
	case errors.Is(err, mediaplane.ErrConnectionNotFound):
		return captureplane.ProviderError{Class: captureplane.ProviderFailureNotFound, Code: "connection_not_found"}
	case errors.Is(err, mediaplane.ErrProviderRateLimited):
		return captureplane.ProviderError{Class: captureplane.ProviderFailureRateLimited, Code: "rate_limited", Retryable: true}
	case errors.Is(err, mediaplane.ErrProviderUnauthorized):
		return captureplane.ProviderError{Class: captureplane.ProviderFailureUnauthorized, Code: "unauthorized"}
	case errors.Is(err, mediaplane.ErrInvalidSignalRequest), errors.Is(err, mediaplane.ErrInvalidConnectionRef):
		return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_request"}
	case errors.Is(err, mediaplane.ErrUnsupportedOperation):
		return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "unsupported_operation"}
	case errors.Is(err, mediaplane.ErrPlaneUnavailable), errors.Is(err, mediaplane.ErrProviderFailed):
		return captureplane.ProviderError{Class: captureplane.ProviderFailureUnavailable, Code: "sfu_unavailable", Retryable: true}
	}
	return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "adapter_error"}
}

// captureOffer is the node's offer for a pull. The recorder must answer it through
// RenegotiateCaptureConnection before media flows.
func captureOffer(metadata captureplane.OperationMetadata, connection captureplane.ProviderReference, description *wireDescription) (captureplane.Negotiation, error) {
	if description == nil {
		return captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}, nil
	}
	if description.Type != "offer" || description.SDP == "" {
		return captureplane.Negotiation{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract"}
	}
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d\x00%s", connection, metadata.CaptureEpoch, metadata.PlanRevision, description.SDP)))
	return captureplane.Negotiation{
		ID:          captureplane.ProviderReference("sfu-neg-" + hex.EncodeToString(digest[:16])),
		Requirement: captureplane.NegotiationAnswerNeeded,
		Description: &captureplane.Description{Type: description.Type, SDP: description.SDP},
	}, nil
}

func (a *Adapter) CreateCaptureConnection(ctx context.Context, input captureplane.CreateCaptureConnectionInput) (captureplane.CreateCaptureConnectionResult, error) {
	const operation = captureplane.OperationCreateCaptureConnection
	if err := input.Validate(); err != nil {
		return captureplane.CreateCaptureConnectionResult{}, err
	}
	if result, replayed, err := captureplane.ReplayLookup[captureplane.CreateCaptureConnectionResult](a.captureReplay, input.Metadata, operation, input); err != nil || replayed {
		return result, err
	}
	operationID, err := captureOperationID(input.Metadata, operation)
	if err != nil {
		return captureplane.CreateCaptureConnectionResult{}, err
	}
	var created wireCreateResponse
	request := wireCreateRequest{OperationID: operationID, Scope: captureScope(input.Metadata), Kind: captureSessionKind, AllocationGeneration: a.allocation}
	if err := a.call(ctx, "/v1/sessions", request, &created); err != nil {
		return captureplane.CreateCaptureConnectionResult{}, captureFailure(operation, input.Metadata, err)
	}
	if err := a.checkIncarnation(created.NodeIncarnation); err != nil {
		return captureplane.CreateCaptureConnectionResult{}, captureFailure(operation, input.Metadata, a.discardStaleSession(ctx, created.ConnectionID, request.Scope, err))
	}
	reference, err := captureplane.NewProviderReference(strings.TrimSpace(created.ConnectionID))
	if err != nil {
		return captureplane.CreateCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract"}
	}
	result := captureplane.CreateCaptureConnectionResult{
		Connection:  input.Metadata.Connection(reference),
		Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired},
	}
	return result, captureplane.ReplayStore(a.captureReplay, input.Metadata, operation, input, result)
}

func (a *Adapter) PullCaptureTracks(ctx context.Context, input captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, error) {
	const operation = captureplane.OperationPullCaptureTracks
	if err := input.Validate(); err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	tracks, err := captureplane.CanonicalizeCaptureTracks(input.Tracks)
	if err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	input.Tracks = tracks
	if result, replayed, err := captureplane.ReplayLookup[captureplane.PullCaptureTracksResult](a.captureReplay, input.Metadata, operation, input); err != nil || replayed {
		return result, err
	}
	path, err := sessionPath(input.Connection.String(), "tracks")
	if err != nil {
		return captureplane.PullCaptureTracksResult{}, captureFailure(operation, input.Metadata, err)
	}
	operationID, err := captureOperationID(input.Metadata, operation)
	if err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	request := wireTracksRequest{OperationID: operationID, Scope: captureScope(input.Metadata), Tracks: make([]wireTrack, 0, len(tracks))}
	if input.LocalDescription != nil {
		request.SessionDescription = &wireDescription{SDP: input.LocalDescription.SDP, Type: input.LocalDescription.Type}
	}
	for _, track := range tracks {
		wired := wireTrack{Location: "remote", SessionID: track.OwnerReference.String(), TrackName: track.TrackReference.String()}
		if rid := track.RequestedLayer.RID(); rid != "" {
			wired.Simulcast = &wireSimulcast{PreferredRID: rid, PriorityOrdering: "none", RIDNotAvailable: "none"}
		}
		request.Tracks = append(request.Tracks, wired)
	}
	var response wireTracksResponse
	if err := a.call(ctx, path, request, &response); err != nil {
		return captureplane.PullCaptureTracksResult{}, captureFailure(operation, input.Metadata, err)
	}
	result, err := capturePullResult(input, response)
	if err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	return result, captureplane.ReplayStore(a.captureReplay, input.Metadata, operation, input, result)
}

type captureTrackKey struct{ owner, track string }

// capturePullResult pairs the node's answer with the requested tracks. A track the node
// reports as not published is Unavailable, which the caller retries. Any other per-track
// error, a missing answer, or an answer for a track nobody asked for breaks the contract.
func capturePullResult(input captureplane.PullCaptureTracksInput, response wireTracksResponse) (captureplane.PullCaptureTracksResult, error) {
	protocol := captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract"}
	mids := make(map[captureTrackKey]string, len(response.Tracks))
	for _, track := range response.Tracks {
		mids[captureTrackKey{track.SessionID, track.TrackName}] = track.Mid
	}
	missing := make(map[captureTrackKey]bool, len(response.TrackErrors))
	for _, failed := range response.TrackErrors {
		if failed.Code != captureTrackNotFound {
			return captureplane.PullCaptureTracksResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "track_error"}
		}
		missing[captureTrackKey{failed.SessionID, failed.TrackName}] = true
	}
	result := captureplane.PullCaptureTracksResult{Connection: input.Metadata.Connection(input.Connection)}
	for _, track := range input.Tracks {
		key := captureTrackKey{track.OwnerReference.String(), track.TrackReference.String()}
		if missing[key] {
			result.Unavailable = append(result.Unavailable, track)
			continue
		}
		mid, err := captureplane.NewProviderReference(strings.TrimSpace(mids[key]))
		if err != nil {
			return captureplane.PullCaptureTracksResult{}, protocol
		}
		result.Tracks = append(result.Tracks, captureplane.PulledCaptureTrack{CaptureTrack: track, MID: mid})
	}
	if len(result.Tracks) == 0 {
		result.Negotiation = captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}
		return result, nil
	}
	negotiation, err := captureOffer(input.Metadata, input.Connection, response.SessionDescription)
	result.Negotiation = negotiation
	return result, err
}

func (a *Adapter) RenegotiateCaptureConnection(ctx context.Context, input captureplane.RenegotiateCaptureConnectionInput) (captureplane.RenegotiateCaptureConnectionResult, error) {
	const operation = captureplane.OperationRenegotiateCaptureConnection
	if err := input.Validate(); err != nil {
		return captureplane.RenegotiateCaptureConnectionResult{}, err
	}
	if result, replayed, err := captureplane.ReplayLookup[captureplane.RenegotiateCaptureConnectionResult](a.captureReplay, input.Metadata, operation, input); err != nil || replayed {
		return result, err
	}
	path, err := sessionPath(input.Connection.String(), "renegotiate")
	if err != nil {
		return captureplane.RenegotiateCaptureConnectionResult{}, captureFailure(operation, input.Metadata, err)
	}
	operationID, err := captureOperationID(input.Metadata, operation)
	if err != nil {
		return captureplane.RenegotiateCaptureConnectionResult{}, err
	}
	request := wireRenegotiateRequest{
		OperationID:        operationID,
		Scope:              captureScope(input.Metadata),
		SessionDescription: wireDescription{SDP: input.Description.SDP, Type: input.Description.Type},
	}
	if err := a.call(ctx, path, request, nil); err != nil {
		return captureplane.RenegotiateCaptureConnectionResult{}, captureFailure(operation, input.Metadata, err)
	}
	result := captureplane.RenegotiateCaptureConnectionResult{
		Connection:  input.Metadata.Connection(input.Connection),
		Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired},
	}
	return result, captureplane.ReplayStore(a.captureReplay, input.Metadata, operation, input, result)
}

// InspectCaptureConnection reports each requested track as active or not. The node lists the
// tracks it still holds, so a requested track it no longer holds is inactive, not an error.
func (a *Adapter) InspectCaptureConnection(ctx context.Context, input captureplane.InspectCaptureConnectionInput) (captureplane.InspectCaptureConnectionResult, error) {
	const operation = captureplane.OperationInspectCaptureConnection
	if err := input.Validate(); err != nil {
		return captureplane.InspectCaptureConnectionResult{}, err
	}
	canonical, err := captureplane.CanonicalizeInspectCaptureConnectionInput(input)
	if err != nil {
		return captureplane.InspectCaptureConnectionResult{}, err
	}
	input = canonical
	if result, replayed, err := captureplane.ReplayLookup[captureplane.InspectCaptureConnectionResult](a.captureReplay, input.Metadata, operation, input); err != nil || replayed {
		return result, err
	}
	path, err := sessionPath(input.Connection.String(), "inspect")
	if err != nil {
		return captureplane.InspectCaptureConnectionResult{}, captureFailure(operation, input.Metadata, err)
	}
	var response wireInspectResponse
	if err := a.call(ctx, path, wireInspectRequest{Scope: captureScope(input.Metadata)}, &response); err != nil {
		return captureplane.InspectCaptureConnectionResult{}, captureFailure(operation, input.Metadata, err)
	}
	activeByMID := make(map[string]bool, len(response.Tracks))
	for _, track := range response.Tracks {
		activeByMID[track.Mid] = track.Active
	}
	state := captureplane.CaptureConnectionConnecting
	observed := make([]captureplane.ObservedCaptureTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		active := activeByMID[track.MID.String()]
		if active {
			state = captureplane.CaptureConnectionConnected
		}
		observed = append(observed, captureplane.ObservedCaptureTrack{PulledCaptureTrack: track, Active: active})
	}
	result := captureplane.InspectCaptureConnectionResult{
		Connection:  input.Metadata.Connection(input.Connection),
		State:       state,
		Tracks:      observed,
		Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired},
	}
	return result, captureplane.ReplayStore(a.captureReplay, input.Metadata, operation, input, result)
}

// CloseCaptureTracks drops the recorder's subscriptions by MID. A capture only receives, so the
// node closes them without an SDP exchange. A session the node no longer holds has no tracks left.
func (a *Adapter) CloseCaptureTracks(ctx context.Context, input captureplane.CloseCaptureTracksInput) (captureplane.CloseCaptureTracksResult, error) {
	const operation = captureplane.OperationCloseCaptureTracks
	if err := input.Validate(); err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	if result, replayed, err := captureplane.ReplayLookup[captureplane.CloseCaptureTracksResult](a.captureReplay, input.Metadata, operation, input); err != nil || replayed {
		return result, err
	}
	path, err := sessionPath(input.Connection.String(), "tracks/close")
	if err != nil {
		return captureplane.CloseCaptureTracksResult{}, captureFailure(operation, input.Metadata, err)
	}
	operationID, err := captureOperationID(input.Metadata, operation)
	if err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	closing := make([]wireCloseTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		closing = append(closing, wireCloseTrack{Mid: track.MID.String()})
	}
	request := wireCloseRequest{OperationID: operationID, Scope: captureScope(input.Metadata), Tracks: closing, Force: true, ReceiveOnly: true}
	if err := a.call(ctx, path, request, nil); err != nil && !errors.Is(err, mediaplane.ErrConnectionNotFound) {
		return captureplane.CloseCaptureTracksResult{}, captureFailure(operation, input.Metadata, err)
	}
	result := captureplane.CloseCaptureTracksResult{
		Connection:  input.Metadata.Connection(input.Connection),
		Tracks:      input.Tracks,
		Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired},
	}
	return result, captureplane.ReplayStore(a.captureReplay, input.Metadata, operation, input, result)
}

// CloseCaptureConnection removes the capture session, which frees its packet reservation.
// A session the node no longer holds is closed already.
func (a *Adapter) CloseCaptureConnection(ctx context.Context, input captureplane.CloseCaptureConnectionInput) (captureplane.CloseCaptureConnectionResult, error) {
	const operation = captureplane.OperationCloseCaptureConnection
	if err := input.Validate(); err != nil {
		return captureplane.CloseCaptureConnectionResult{}, err
	}
	if result, replayed, err := captureplane.ReplayLookup[captureplane.CloseCaptureConnectionResult](a.captureReplay, input.Metadata, operation, input); err != nil || replayed {
		return result, err
	}
	path, err := sessionPath(input.Connection.String(), "remove")
	if err != nil {
		return captureplane.CloseCaptureConnectionResult{}, captureFailure(operation, input.Metadata, err)
	}
	if err := a.call(ctx, path, wireRemoveRequest{Scope: captureScope(input.Metadata)}, nil); err != nil && !errors.Is(err, mediaplane.ErrConnectionNotFound) {
		return captureplane.CloseCaptureConnectionResult{}, captureFailure(operation, input.Metadata, err)
	}
	result := captureplane.CloseCaptureConnectionResult{Connection: input.Metadata.Connection(input.Connection), Closed: true}
	return result, captureplane.ReplayStore(a.captureReplay, input.Metadata, operation, input, result)
}
