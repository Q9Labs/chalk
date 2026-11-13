package sfu

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func (a Adapter) PullCaptureTracks(ctx context.Context, input captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, error) {
	if err := input.Validate(); err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	tracks, err := captureplane.CanonicalizeCaptureTracks(input.Tracks)
	if err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	input.Tracks = tracks
	if result, replayed, err := captureplane.ReplayLookup[captureplane.PullCaptureTracksResult](a.captureReplay, input.Metadata, captureplane.OperationPullCaptureTracks, input); err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	} else if replayed {
		return result, nil
	}
	requestTracks := make([]captureTrackRequest, 0, len(tracks))
	for _, track := range tracks {
		providerTrack := captureTrackRequest{
			providerConnectionEnvelope: providerConnectionEnvelope{ConnectionReference: a.sessions.providerID(track.OwnerReference.String())},
			Location:                   "remote",
			TrackName:                  track.TrackReference.String(),
			Kind:                       track.Kind.String(),
		}
		if rid := track.RequestedLayer.RID(); rid != "" {
			providerTrack.Simulcast = &captureSimulcast{PreferredRID: rid}
		}
		requestTracks = append(requestTracks, providerTrack)
	}
	request := captureTracksRequest{providerDescriptionEnvelope: providerDescriptionEnvelope{Description: captureDescription(input.LocalDescription)}, Tracks: requestTracks, AutoDiscover: false}
	var response captureTracksResponse
	path := fmt.Sprintf(providerConnectionsPath+"/%s/tracks/new", url.PathEscape(input.Connection.String()))
	err = a.request(ctx, http.MethodPost, path, request, &response, "add_tracks")
	for index := range response.Tracks {
		response.Tracks[index].ConnectionReference = a.sessions.clientID(response.Tracks[index].ConnectionReference)
	}
	if err != nil {
		if result, handled, unavailableErr := captureUnavailablePullResult(err, response, input); handled {
			if unavailableErr != nil {
				return captureplane.PullCaptureTracksResult{}, unavailableErr
			}
			if err := captureplane.ReplayStore(a.captureReplay, input.Metadata, captureplane.OperationPullCaptureTracks, input, result); err != nil {
				return captureplane.PullCaptureTracksResult{}, err
			}
			return result, nil
		}
		err = retryableCaptureTrackAvailability(err, response, tracks)
		return captureplane.PullCaptureTracksResult{}, captureProviderError(err)
	}
	if err := validateCapturePullResponse(response, tracks); err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	byIdentity := make(map[captureTrackKey]captureTrackResult, len(response.Tracks))
	for _, result := range response.Tracks {
		byIdentity[captureTrackKey{owner: result.ConnectionReference, track: result.TrackName}] = result
	}
	pulled := make([]captureplane.PulledCaptureTrack, 0, len(tracks))
	for _, track := range tracks {
		result := byIdentity[captureTrackKey{owner: track.OwnerReference.String(), track: track.TrackReference.String()}]
		mid, err := captureplane.NewProviderReference(strings.TrimSpace(result.Mid))
		if err != nil {
			return captureplane.PullCaptureTracksResult{}, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		pulledTrack := captureplane.PulledCaptureTrack{CaptureTrack: track, MID: mid}
		pulled = append(pulled, pulledTrack)
	}
	negotiation, err := captureNegotiation(input.Metadata, input.Connection, captureplane.OperationPullCaptureTracks, response.Description, response.RequiresImmediateRenegotiation)
	if err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	result := captureplane.PullCaptureTracksResult{Connection: input.Metadata.Connection(input.Connection), Tracks: pulled, Negotiation: negotiation}
	if err := captureplane.ReplayStore(a.captureReplay, input.Metadata, captureplane.OperationPullCaptureTracks, input, result); err != nil {
		return captureplane.PullCaptureTracksResult{}, err
	}
	return result, nil
}

// captureUnavailablePullResult accepts only a complete, identity-matched response
// whose failed entries are per-track publication-not-found answers. A mixed
// response keeps the successful pulls; unrelated failures retain their usual
// classification and retry behavior.
func captureUnavailablePullResult(requestErr error, response captureTracksResponse, input captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, bool, error) {
	var failure providerFailure
	if !errors.As(requestErr, &failure) || failure.operation != "add_tracks" || failure.stage != failureStageTrack || !isSuccessfulHTTPStatus(failure.statusCode) {
		return captureplane.PullCaptureTracksResult{}, false, nil
	}
	if response.ErrorCode != "" || response.ErrorDescription != "" || len(response.Tracks) != len(input.Tracks) {
		return captureplane.PullCaptureTracksResult{}, false, nil
	}
	byIdentity := make(map[captureTrackKey]captureTrackResult, len(response.Tracks))
	incomplete := make([]captureTrackResult, 0)
	for _, result := range response.Tracks {
		key := captureTrackKey{owner: result.ConnectionReference, track: result.TrackName}
		if result.Location != "" && result.Location != "remote" {
			return captureplane.PullCaptureTracksResult{}, false, nil
		}
		if strings.EqualFold(strings.TrimSpace(result.ErrorCode), "not_found_track_error") && (key.owner == "" || key.track == "") {
			incomplete = append(incomplete, result)
			continue
		}
		if _, exists := byIdentity[key]; exists {
			return captureplane.PullCaptureTracksResult{}, false, nil
		}
		byIdentity[key] = result
	}
	// Match explicit identities first. Optional error identities can then use
	// only unmatched requests, independent of the provider's response order.
	for len(incomplete) > 0 {
		unresolved := make([]captureTrackResult, 0, len(incomplete))
		for _, result := range incomplete {
			var key captureTrackKey
			matches := 0
			for _, requested := range input.Tracks {
				candidate := captureTrackKey{owner: requested.OwnerReference.String(), track: requested.TrackReference.String()}
				if _, matched := byIdentity[candidate]; matched {
					continue
				}
				if (result.ConnectionReference == "" || result.ConnectionReference == requested.OwnerReference.String()) &&
					(result.TrackName == "" || result.TrackName == requested.TrackReference.String()) {
					key = candidate
					matches++
				}
			}
			if matches == 0 {
				return captureplane.PullCaptureTracksResult{}, false, nil
			}
			if matches > 1 {
				unresolved = append(unresolved, result)
				continue
			}
			byIdentity[key] = result
		}
		if len(unresolved) == len(incomplete) {
			return captureplane.PullCaptureTracksResult{}, false, nil
		}
		incomplete = unresolved
	}
	pulled := make([]captureplane.PulledCaptureTrack, 0, len(input.Tracks))
	unavailable := make([]captureplane.CaptureTrack, 0)
	missing := false
	for _, track := range input.Tracks {
		result, exists := byIdentity[captureTrackKey{owner: track.OwnerReference.String(), track: track.TrackReference.String()}]
		if !exists {
			return captureplane.PullCaptureTracksResult{}, false, nil
		}
		if strings.EqualFold(strings.TrimSpace(result.ErrorCode), "not_found_track_error") {
			missing = true
			// A publisher can be visible before the SFU can serve its RTP.
			// Keep it retryable; absence here is not an unpublish event.
			unavailable = append(unavailable, track)
			continue
		}
		if strings.EqualFold(strings.TrimSpace(result.ErrorCode), "empty_track_error") {
			unavailable = append(unavailable, track)
			continue
		}
		if result.ErrorCode != "" || result.ErrorDescription != "" {
			return captureplane.PullCaptureTracksResult{}, false, nil
		}
		mid, err := captureplane.NewProviderReference(strings.TrimSpace(result.Mid))
		if err != nil || result.Mid != strings.TrimSpace(result.Mid) {
			return captureplane.PullCaptureTracksResult{}, false, nil
		}
		pulled = append(pulled, captureplane.PulledCaptureTrack{CaptureTrack: track, MID: mid})
	}
	if !missing {
		return captureplane.PullCaptureTracksResult{}, false, nil
	}
	negotiation, err := captureNegotiation(input.Metadata, input.Connection, captureplane.OperationPullCaptureTracks, response.Description, response.RequiresImmediateRenegotiation)
	if err != nil {
		return captureplane.PullCaptureTracksResult{}, true, err
	}
	result := captureplane.PullCaptureTracksResult{Connection: input.Metadata.Connection(input.Connection), Tracks: pulled, Unavailable: unavailable, Negotiation: negotiation}
	if err := result.ValidateAgainst(input.Metadata); err != nil {
		return captureplane.PullCaptureTracksResult{}, true, captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
	return result, true, nil
}

func validateCapturePullResponse(response captureTracksResponse, tracks []captureplane.CaptureTrack) error {
	requested := make(map[captureTrackKey]struct{}, len(tracks))
	for _, track := range tracks {
		requested[captureTrackKey{owner: track.OwnerReference.String(), track: track.TrackReference.String()}] = struct{}{}
	}
	seen := make(map[captureTrackKey]struct{}, len(response.Tracks))
	seenMIDs := make(map[string]struct{}, len(response.Tracks))
	for _, result := range response.Tracks {
		key := captureTrackKey{owner: result.ConnectionReference, track: result.TrackName}
		if result.Location != "" && result.Location != "remote" {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		mid := strings.TrimSpace(result.Mid)
		if _, ok := requested[key]; !ok || key.owner == "" || key.track == "" || result.Mid != mid || mid == "" {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if _, duplicate := seen[key]; duplicate {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		if _, duplicate := seenMIDs[mid]; duplicate {
			return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
		}
		seen[key] = struct{}{}
		seenMIDs[mid] = struct{}{}
	}
	if len(seen) != len(requested) {
		return captureplane.ProviderError{Class: captureplane.ProviderFailureProtocol, Code: "invalid_contract", Retryable: false}
	}
	return nil
}
