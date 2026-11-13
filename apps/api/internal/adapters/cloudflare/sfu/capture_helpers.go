package sfu

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func captureTrackFailureCount(tracks []captureTrackResult) int {
	count := 0
	for _, track := range tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			count++
		}
	}
	return count
}

func captureCloseTrackFailureCount(tracks []captureCloseTrackResult) int {
	count := 0
	for _, track := range tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			count++
		}
	}
	return count
}

func captureDescription(value *captureplane.Description) *providerDescription {
	if value == nil {
		return nil
	}
	return &providerDescription{SDP: value.SDP, Type: value.Type}
}

func captureDescriptionValue(value *providerDescription) (*captureplane.Description, error) {
	if value == nil {
		return nil, nil
	}
	description := &captureplane.Description{SDP: value.SDP, Type: strings.TrimSpace(value.Type)}
	if err := description.Validate(); err != nil {
		return nil, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
	return description, nil
}

func retryableCaptureTrackAvailability(err error, response captureTracksResponse, requested []captureplane.CaptureTrack) error {
	var failure providerFailure
	if !errors.As(err, &failure) || failure.operation != "add_tracks" ||
		failure.stage != failureStageTrack || !isSuccessfulHTTPStatus(failure.statusCode) ||
		!allCaptureTracksTemporarilyUnavailable(response, requested) {
		return err
	}
	failure.retryableTrackAvailability = true
	return failure
}

func allCaptureTracksTemporarilyUnavailable(response captureTracksResponse, requested []captureplane.CaptureTrack) bool {
	if strings.TrimSpace(response.ErrorCode) != "" || strings.TrimSpace(response.ErrorDescription) != "" ||
		len(requested) == 0 || len(response.Tracks) != len(requested) ||
		response.Description != nil || response.RequiresImmediateRenegotiation {
		return false
	}
	wanted := make(map[captureTrackKey]struct{}, len(requested))
	for _, track := range requested {
		key := captureTrackKey{owner: track.OwnerReference.String(), track: track.TrackReference.String()}
		if _, duplicate := wanted[key]; duplicate {
			return false
		}
		wanted[key] = struct{}{}
	}
	seen := make(map[captureTrackKey]struct{}, len(response.Tracks))
	for _, result := range response.Tracks {
		key := captureTrackKey{owner: result.ConnectionReference, track: result.TrackName}
		if result.Location != "" && result.Location != "remote" {
			return false
		}
		if _, ok := wanted[key]; !ok {
			return false
		}
		if _, duplicate := seen[key]; duplicate || !captureTrackTemporarilyUnavailable(result) {
			return false
		}
		seen[key] = struct{}{}
	}
	return len(seen) == len(wanted)
}

func captureTrackTemporarilyUnavailable(result captureTrackResult) bool {
	switch strings.ToLower(strings.TrimSpace(result.ErrorCode)) {
	case "not_found_track_error", "empty_track_error":
		return true
	default:
		return false
	}
}

func captureProviderError(err error) error {
	if err == nil {
		return nil
	}
	var failure providerFailure
	if !errors.As(err, &failure) {
		return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "adapter_error", Retryable: false}
	}
	class := captureplane.ProviderFailureProtocol
	retryable := false
	switch {
	case failure.retryableTrackAvailability && failure.operation == "add_tracks" && failure.stage == failureStageTrack && isSuccessfulHTTPStatus(failure.statusCode):
		class = captureplane.ProviderFailureNotFound
		retryable = true
	case failure.statusCode == http.StatusUnauthorized,
		failure.statusCode == http.StatusForbidden,
		failure.providerCode == "unauthorized":
		class = captureplane.ProviderFailureUnauthorized
	case failure.statusCode == http.StatusNotFound,
		failure.statusCode == http.StatusGone,
		failure.providerCode == "connection_not_found",
		failure.providerCode == "track_not_found":
		class = captureplane.ProviderFailureNotFound
	case failure.statusCode == http.StatusTooManyRequests || failure.providerCode == "rate_limited":
		class = captureplane.ProviderFailureRateLimited
		retryable = true
	case failure.stage == failureStageTransport,
		failure.statusCode >= 500,
		failure.providerCode == "plane_unavailable",
		failure.providerCode == "provider_internal",
		failure.providerCode == "timeout",
		failure.providerCode == "transport_error",
		failure.providerCode == "connection_not_connected":
		class = captureplane.ProviderFailureUnavailable
		retryable = true
	}
	if failure.operation == "add_tracks" && failure.stage == failureStageTrack && isSuccessfulHTTPStatus(failure.statusCode) && !failure.retryableTrackAvailability {
		// A successful HTTP request can have a mixed or unrelated per-track
		// failure. Replaying it could duplicate subscriptions or negotiation.
		retryable = false
	}
	if (failure.operation == "add_tracks" || failure.operation == "renegotiate") && class != captureplane.ProviderFailureNotFound {
		// Transport and top-level errors do not promise an unchanged session.
		// Only explicit missing-track rejections may replay in this epoch.
		retryable = false
	}
	code := strings.TrimSpace(failure.providerCode)
	if failure.stage == failureStageTrack && failure.trackCode != "" {
		code = failure.trackCode
	}
	if code == "" || code == "unknown" {
		// Persist a bounded stage/status fingerprint when the provider supplies
		// an unrecognized code. It distinguishes an HTTP rejection from a
		// top-level or per-track response without retaining provider payloads.
		code = fmt.Sprintf("provider_%s_%d", failure.stage, failure.statusCode)
	}
	return captureplane.ProviderError{Class: class, Code: code, Retryable: retryable}
}

func captureNegotiationID(metadata captureplane.OperationMetadata, connection captureplane.ProviderReference, operation captureplane.OperationKind, description *captureplane.Description) captureplane.ProviderReference {
	var descriptionType, descriptionSDP string
	if description != nil {
		descriptionType = description.Type
		descriptionSDP = description.SDP
	}
	hashInput := fmt.Sprintf("%s\x00%d\x00%d\x00%s\x00%s\x00%s", connection, metadata.CaptureEpoch, metadata.PlanRevision, operation, descriptionType, descriptionSDP)
	digest := sha256.Sum256([]byte(hashInput))
	return captureplane.ProviderReference("cf-neg-" + hex.EncodeToString(digest[:16]))
}

func captureNegotiation(metadata captureplane.OperationMetadata, connection captureplane.ProviderReference, operation captureplane.OperationKind, description *providerDescription, requires bool) (captureplane.Negotiation, error) {
	converted, err := captureDescriptionValue(description)
	if err != nil {
		return captureplane.Negotiation{}, err
	}
	if converted == nil {
		if requires {
			return captureplane.Negotiation{
				ID:          captureNegotiationID(metadata, connection, operation, nil),
				Requirement: captureplane.NegotiationOfferNeeded,
			}, nil
		}
		return captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}, nil
	}
	switch converted.Type {
	case "offer":
		if !requires {
			return captureplane.Negotiation{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		return captureplane.Negotiation{
			ID:          captureNegotiationID(metadata, connection, operation, converted),
			Requirement: captureplane.NegotiationAnswerNeeded,
			Description: converted,
		}, nil
	case "answer":
		if requires {
			return captureplane.Negotiation{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		return captureplane.Negotiation{Requirement: captureplane.NegotiationRemoteAnswer, Description: converted}, nil
	default:
		return captureplane.Negotiation{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
}
