package sfu

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

func (a Adapter) CloseTracks(ctx context.Context, input mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.CloseTracksResponse{}, mediaplane.ErrInvalidProvider
	}
	providerSession := a.sessions.providerID(input.ConnectionID)
	if input.Force && !input.ReceiveOnly && a.sessions.isGone(providerSession) {
		return mediaplane.CloseTracksResponse{AlreadyClosed: true, Tracks: input.Tracks}, nil
	}
	if input.ReceiveOnly {
		// The participant grant already binds this session to the caller. Verify
		// the MID's direction so this path cannot bypass publication retirement.
		var session struct {
			Tracks []struct {
				Mid      string `json:"mid"`
				Location string `json:"location"`
			} `json:"tracks"`
		}
		if err := a.request(ctx, http.MethodGet, fmt.Sprintf("/sessions/%s", url.PathEscape(a.sessions.providerID(input.ConnectionID))), nil, &session, "get_session"); err != nil {
			return mediaplane.CloseTracksResponse{}, err
		}
		for _, requested := range input.Tracks {
			matches := 0
			for _, track := range session.Tracks {
				if track.Mid != requested.Mid {
					continue
				}
				if track.Location != "remote" {
					return mediaplane.CloseTracksResponse{}, mediaplane.ErrInvalidSignalRequest
				}
				matches++
			}
			if matches != 1 {
				return mediaplane.CloseTracksResponse{}, mediaplane.ErrInvalidSignalRequest
			}
		}
		input.Force = true
		input.SessionDescription = nil
	}

	providerTracks := make([]closeTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		providerTracks = append(providerTracks, closeTrack{Mid: track.Mid})
	}

	request := closeTracksRequest{
		SessionDescription: input.SessionDescription,
		Tracks:             providerTracks,
		Force:              input.Force,
	}
	providerResponse := closeTracksResponse{requestedTracks: input.Tracks}
	// Disconnected provider connections can take longer than the interactive
	// request budget to report their absence. Keep teardown bounded separately.
	if input.Force && a.forcedCloseClient != nil {
		a.client = a.forcedCloseClient
	}
	providerID := a.sessions.providerID(input.ConnectionID)
	err := a.request(ctx, http.MethodPut, fmt.Sprintf("/sessions/%s/tracks/close", url.PathEscape(providerID)), request, &providerResponse, "close_tracks")
	if err != nil && input.Force && !forcedCloseSatisfied(err) && a.closeSessionTerminated(ctx, providerID, err) {
		return mediaplane.CloseTracksResponse{AlreadyClosed: true, Tracks: input.Tracks}, nil
	}
	var closeFailure providerFailure
	if errors.As(err, &closeFailure) && closeFailure.statusCode == http.StatusGone {
		a.sessions.markGone(providerID)
	}
	if err != nil && !(input.Force && forcedCloseSatisfied(err)) {
		return mediaplane.CloseTracksResponse{}, err
	}
	alreadyClosed := input.Force && forcedCloseSatisfied(err)
	if err == nil && len(providerResponse.Tracks) > 0 {
		alreadyClosed = true
		for _, track := range providerResponse.Tracks {
			if !closedTrackAbsent(track.ErrorCode) {
				alreadyClosed = false
				break
			}
		}
	}
	return mediaplane.CloseTracksResponse{
		AlreadyClosed:                  alreadyClosed,
		SessionDescription:             providerResponse.SessionDescription,
		Tracks:                         input.Tracks,
		RequiresImmediateRenegotiation: providerResponse.RequiresImmediateRenegotiation,
	}, nil
}

func (r *closeTracksResponse) providerError(operation string, statusCode int) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, statusCode, r.ErrorCode, r.ErrorDescription, len(r.Tracks), failedCloseTrackCount(r.Tracks))
	}

	requestedMids := make(map[string]struct{}, len(r.requestedTracks))
	for _, track := range r.requestedTracks {
		requestedMids[track.Mid] = struct{}{}
	}
	seenMids := make(map[string]struct{}, len(r.Tracks))
	for _, track := range r.Tracks {
		track.Mid = strings.TrimSpace(track.Mid)
		if _, ok := requestedMids[track.Mid]; !ok || track.Mid == "" {
			return newProviderFailure(operation, failureStageContract, statusCode, "invalid_contract")
		}
		if _, duplicate := seenMids[track.Mid]; duplicate {
			return newProviderFailure(operation, failureStageContract, statusCode, "invalid_contract")
		}
		seenMids[track.Mid] = struct{}{}
		if closedTrackAbsent(track.ErrorCode) {
			continue
		}
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			return newProviderResponseFailure(operation, failureStageTrack, statusCode, track.ErrorCode, track.ErrorDescription, len(r.Tracks), failedCloseTrackCount(r.Tracks))
		}
	}
	if len(seenMids) != len(requestedMids) {
		return newProviderFailure(operation, failureStageContract, statusCode, "invalid_contract")
	}

	return nil
}

func closedTrackAbsent(code string) bool {
	switch strings.ToLower(strings.TrimSpace(code)) {
	case "session_not_found", "connection_not_found", "track_already_closed", "track_not_found", "close_track_error":
		return true
	default:
		return false
	}
}

func forcedCloseSatisfied(err error) bool {
	var failure providerFailure
	if !errors.As(err, &failure) || failure.operation != "close_tracks" {
		return false
	}
	if failure.statusCode == http.StatusNotFound || failure.statusCode == http.StatusGone {
		return true
	}
	if failure.statusCode == http.StatusTooEarly {
		return failure.providerCode == "connection_not_connected"
	}
	return isSuccessfulHTTPStatus(failure.statusCode) &&
		(failure.providerCode == "connection_not_found" || failure.providerCode == "track_already_closed" || failure.providerCode == "track_not_found")
}

func failedCloseTrackCount(tracks []closeTrackResult) int {
	count := 0
	for _, track := range tracks {
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			count++
		}
	}
	return count
}
