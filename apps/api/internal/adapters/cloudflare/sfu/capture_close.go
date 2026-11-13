package sfu

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"go.opentelemetry.io/otel/trace"
)

func (a Adapter) CloseCaptureTracks(ctx context.Context, input captureplane.CloseCaptureTracksInput) (captureplane.CloseCaptureTracksResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	tracks, err := captureplane.CanonicalizePulledCaptureTracks(input.Tracks)
	if err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	input.Tracks = tracks
	if result, replayed, err := captureplane.ReplayLookup[captureplane.CloseCaptureTracksResult](a.captureReplay, input.Metadata, captureplane.OperationCloseCaptureTracks, input); err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	} else if replayed {
		return result, nil
	}
	closeTracks := make([]captureCloseTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		closeTracks = append(closeTracks, captureCloseTrack{Mid: track.MID.String()})
	}
	request := captureCloseTracksRequest{Tracks: closeTracks, Force: true}
	var response captureCloseTracksResponse
	path := fmt.Sprintf(providerConnectionsPath+"/%s/tracks/close", url.PathEscape(input.Connection.String()))
	statusCode, requestErr := a.requestStatus(ctx, http.MethodPut, path, request, &response, "close_tracks")
	if requestErr != nil && !captureCloseSessionGone(requestErr) {
		return captureplane.CloseCaptureTracksResult{}, captureProviderError(requestErr)
	}
	if requestErr == nil {
		if err := validateCaptureCloseResponse(ctx, response, closeTracks, statusCode); err != nil {
			return captureplane.CloseCaptureTracksResult{}, err
		}
	}
	negotiation, err := captureNegotiation(input.Metadata, input.Connection, captureplane.OperationCloseCaptureTracks, response.Description, response.RequiresImmediateRenegotiation)
	if err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	result := captureplane.CloseCaptureTracksResult{Connection: input.Metadata.Connection(input.Connection), Tracks: append([]captureplane.PulledCaptureTrack(nil), input.Tracks...), Negotiation: negotiation}
	if err := captureplane.ReplayStore(a.captureReplay, input.Metadata, captureplane.OperationCloseCaptureTracks, input, result); err != nil {
		return captureplane.CloseCaptureTracksResult{}, err
	}
	return result, nil
}

func validateCaptureCloseResponse(ctx context.Context, response captureCloseTracksResponse, requested []captureCloseTrack, statusCode int) error {
	wanted := make(map[string]struct{}, len(requested))
	for _, track := range requested {
		wanted[track.Mid] = struct{}{}
	}
	seen := make(map[string]struct{}, len(response.Tracks))
	for _, track := range response.Tracks {
		mid := strings.TrimSpace(track.Mid)
		if _, ok := wanted[mid]; !ok || mid == "" {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if _, duplicate := seen[mid]; duplicate {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		seen[mid] = struct{}{}
		if (strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "") && !closedTrackAbsent(track.ErrorCode) {
			failure := newProviderResponseFailure("close_tracks", failureStageTrack, statusCode, track.ErrorCode, track.ErrorDescription, len(response.Tracks), captureCloseTrackFailureCount(response.Tracks))
			recordProviderFailure(ctx, trace.SpanFromContext(ctx), failure)
			return captureProviderError(failure)
		}
	}
	if len(seen) != len(wanted) {
		return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
	return nil
}

func (a Adapter) CloseCaptureConnection(ctx context.Context, input captureplane.CloseCaptureConnectionInput) (captureplane.CloseCaptureConnectionResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.CloseCaptureConnectionResult{}, err
	}
	canonical, err := captureplane.CanonicalizeCloseCaptureConnectionInput(input)
	if err != nil {
		return captureplane.CloseCaptureConnectionResult{}, err
	}
	input = canonical
	if result, replayed, err := captureplane.ReplayLookup[captureplane.CloseCaptureConnectionResult](a.captureReplay, input.Metadata, captureplane.OperationCloseCaptureConnection, input); err != nil {
		return captureplane.CloseCaptureConnectionResult{}, err
	} else if replayed {
		return result, nil
	}
	if len(input.Tracks) > 0 && !input.Force {
		return captureplane.CloseCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "force_required", Retryable: false}
	}
	closeTracks := make([]captureCloseTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		closeTracks = append(closeTracks, captureCloseTrack{Mid: track.MID.String()})
	}
	if input.Force {
		// A failed pull may have allocated tracks without returning their MIDs.
		// Inspect this retired session and close observed allocations as well.
		var response captureInspectResponse
		path := fmt.Sprintf(providerConnectionsPath+"/%s", url.PathEscape(input.Connection.String()))
		if err := a.request(ctx, http.MethodGet, path, nil, &response, "verify_connection"); err != nil {
			var failure providerFailure
			if !errors.As(err, &failure) || (failure.statusCode != http.StatusGone && failure.statusCode != http.StatusNotFound) {
				return captureplane.CloseCaptureConnectionResult{}, captureProviderError(err)
			}
			closeTracks = nil
		} else {
			seen := make(map[string]bool, len(closeTracks))
			for _, track := range closeTracks {
				seen[track.Mid] = true
			}
			for _, track := range response.Tracks {
				mid, err := captureplane.NewProviderReference(track.Mid)
				if err != nil {
					return captureplane.CloseCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract"}
				}
				if !seen[mid.String()] {
					closeTracks = append(closeTracks, captureCloseTrack{Mid: mid.String()})
					seen[mid.String()] = true
				}
			}
		}
	}
	if len(closeTracks) > 0 {
		var closeResponse captureCloseTracksResponse
		path := fmt.Sprintf(providerConnectionsPath+"/%s/tracks/close", url.PathEscape(input.Connection.String()))
		statusCode, requestErr := a.requestStatus(ctx, http.MethodPut, path, captureCloseTracksRequest{Tracks: closeTracks, Force: input.Force}, &closeResponse, "close_tracks")
		if requestErr != nil && !captureCloseSessionGone(requestErr) {
			return captureplane.CloseCaptureConnectionResult{}, captureProviderError(requestErr)
		}
		if requestErr == nil {
			if err := validateCaptureCloseResponse(ctx, closeResponse, closeTracks, statusCode); err != nil {
				return captureplane.CloseCaptureConnectionResult{}, err
			}
		}
		if closeResponse.Description != nil || closeResponse.RequiresImmediateRenegotiation {
			return captureplane.CloseCaptureConnectionResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
	}
	result := captureplane.CloseCaptureConnectionResult{Connection: input.Metadata.Connection(input.Connection), Closed: true}
	if err := captureplane.ReplayStore(a.captureReplay, input.Metadata, captureplane.OperationCloseCaptureConnection, input, result); err != nil {
		return captureplane.CloseCaptureConnectionResult{}, err
	}
	return result, nil
}

var _ captureplane.CapturePlane = Adapter{}

// An expired session cannot retain tracks or reconnect. Its forced cleanup is
// complete, even though the provider cannot return individual track results.
func captureCloseSessionGone(err error) bool {
	var failure providerFailure
	return errors.As(err, &failure) && failure.operation == "close_tracks" && failure.statusCode == http.StatusGone
}
