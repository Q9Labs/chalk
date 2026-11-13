package sfu

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// UpdateTracks changes the simulcast layer of remote subscriptions in place.
// Cloudflare answers with requiresImmediateRenegotiation=false, so no SDP moves.
// Cloudflare has no pause in place, so a paused request fails instead of
// silently switching layers.
func (a Adapter) UpdateTracks(ctx context.Context, input mediaplane.UpdateTracksRequest) (mediaplane.TracksResponse, error) {
	tracks := make([]providerTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		if track.Paused != nil {
			return mediaplane.TracksResponse{}, fmt.Errorf("%w: cloudflare sfu cannot pause a track in place", mediaplane.ErrInvalidSignalRequest)
		}
		tracks = append(tracks, providerTrack{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, SessionID: a.sessions.providerID(track.SessionID), Simulcast: track.Simulcast})
	}
	response := updateTracksResponse{requestedTracks: tracks}
	if err := a.request(ctx, http.MethodPut, fmt.Sprintf("/sessions/%s/tracks/update", url.PathEscape(a.sessions.providerID(input.ConnectionID))), tracksRequest{Tracks: tracks}, &response, "update_tracks"); err != nil {
		return mediaplane.TracksResponse{}, err
	}
	return a.toClientIDs(mediaplane.TracksResponse{Tracks: response.mediaPlaneTracks(), RequiresImmediateRenegotiation: response.RequiresImmediateRenegotiation}), nil
}

func (a Adapter) Renegotiate(ctx context.Context, input mediaplane.RenegotiateRequest) error {
	err := a.request(ctx, http.MethodPut, fmt.Sprintf("/sessions/%s/renegotiate", url.PathEscape(a.sessions.providerID(input.ConnectionID))), renegotiateRequest{
		SessionDescription: input.SessionDescription,
	}, nil, "renegotiate")
	if err == nil {
		a.sessions.negotiated(input.ConnectionID)
	}
	return err
}

func (r *updateTracksResponse) providerError(operation string, statusCode int) error {
	if strings.TrimSpace(r.ErrorCode) != "" || strings.TrimSpace(r.ErrorDescription) != "" {
		return newProviderResponseFailure(operation, failureStageTopLevel, statusCode, r.ErrorCode, r.ErrorDescription, len(r.Tracks), failedAddTrackCount(r.Tracks))
	}
	requested := make(map[string]struct{}, len(r.requestedTracks))
	for _, track := range r.requestedTracks {
		requested[track.Mid] = struct{}{}
	}
	for _, track := range r.Tracks {
		if _, ok := requested[strings.TrimSpace(track.Mid)]; !ok {
			return newProviderFailure(operation, failureStageContract, statusCode, "invalid_contract")
		}
		if strings.TrimSpace(track.ErrorCode) != "" || strings.TrimSpace(track.ErrorDescription) != "" {
			return newProviderResponseFailure(operation, failureStageTrack, statusCode, track.ErrorCode, track.ErrorDescription, len(r.Tracks), failedAddTrackCount(r.Tracks))
		}
	}
	if len(r.Tracks) != len(r.requestedTracks) {
		return newProviderFailure(operation, failureStageContract, statusCode, "invalid_contract")
	}
	return nil
}

func (r updateTracksResponse) mediaPlaneTracks() []mediaplane.Track {
	tracks := make([]mediaplane.Track, 0, len(r.Tracks))
	for _, track := range r.Tracks {
		tracks = append(tracks, mediaplane.Track{Location: "remote", Mid: track.Mid, TrackName: track.TrackName, SessionID: track.SessionID})
	}
	return tracks
}
