package chalksfu

import (
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
