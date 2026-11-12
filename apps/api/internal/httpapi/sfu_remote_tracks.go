package httpapi

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
)

func confirmFailedRemoteTracks(ctx context.Context, service *mediaplane.Service, publications mediapublications.Registry, request sfuTracksEndpointRequest, response mediaplane.TracksResponse, providerErr error) {
	requested := make(map[mediapublications.RemoteTrackIdentity]struct{}, len(request.Body.Tracks))
	for _, track := range request.Body.Tracks {
		if track.Location == "remote" {
			requested[mediapublications.RemoteTrackIdentity{
				ConnectionID: strings.TrimSpace(track.SessionID),
				TrackName:    strings.TrimSpace(track.TrackName),
			}] = struct{}{}
		}
	}
	if len(requested) == 0 {
		return
	}
	failed := make(map[mediapublications.RemoteTrackIdentity]struct{}, len(response.TrackErrors))
	for _, trackErr := range response.TrackErrors {
		if !trackErr.PublicationMissing {
			continue
		}
		identity := mediapublications.RemoteTrackIdentity{
			ConnectionID: strings.TrimSpace(trackErr.ConnectionID),
			TrackName:    strings.TrimSpace(trackErr.TrackName),
		}
		if _, askedFor := requested[identity]; askedFor && identity.ConnectionID != "" && identity.TrackName != "" {
			failed[identity] = struct{}{}
		}
	}
	for _, trackErr := range mediaplane.MissingRemoteTracks(providerErr) {
		identity := mediapublications.RemoteTrackIdentity{
			ConnectionID: strings.TrimSpace(trackErr.ConnectionID),
			TrackName:    strings.TrimSpace(trackErr.TrackName),
		}
		if _, askedFor := requested[identity]; askedFor && identity.ConnectionID != "" && identity.TrackName != "" {
			failed[identity] = struct{}{}
		}
	}
	if len(failed) == 0 {
		return
	}
	confirmer, ok := publications.(mediapublications.RemoteTrackFailureConfirmer)
	if !ok {
		return
	}
	failedTracks := make([]mediapublications.RemoteTrackIdentity, 0, len(failed))
	for identity := range failed {
		failedTracks = append(failedTracks, identity)
	}
	reader := func(ctx context.Context, connectionID string) (mediapublications.PublisherSession, error) {
		state, err := service.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: connectionID, Scope: sfuScope(ctx), Peer: true})
		if err != nil {
			return mediapublications.PublisherSession{}, err
		}
		session := mediapublications.PublisherSession{Found: state.Found}
		for _, track := range state.Tracks {
			if track.Location == "local" {
				session.Tracks = append(session.Tracks, mediapublications.PublisherTrack{
					MID: track.Mid, TrackName: track.TrackName, Active: track.Active,
				})
			}
		}
		return session, nil
	}
	confirmCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	if _, err := confirmer.ConfirmRemoteTrackFailures(confirmCtx, mediapublications.RemoteTrackFailureInput{
		TenantID:              request.TenantID,
		EpisodeID:             request.EpisodeID,
		ListenerParticipantID: request.ParticipantID,
		ListenerConnectionID:  request.Body.ConnectionID,
		Failed:                failedTracks,
	}, reader); err != nil {
		slog.WarnContext(confirmCtx, "failed to confirm unavailable remote media tracks",
			"event", "media_publication.failure_confirmation_failed",
			"error", err,
		)
	}
}

func remoteTrackObserver(publications mediapublications.Registry) (mediapublications.RemoteTrackObserver, bool) {
	observer, ok := publications.(mediapublications.RemoteTrackObserver)
	return observer, ok
}

func partialSFUTracksResponse(request sfuTracksEndpointRequest, response mediaplane.TracksResponse, providerErr error) (mediaplane.TracksResponse, error) {
	if !request.AllowPartialRemoteTracks {
		return mediaplane.TracksResponse{}, providerErr
	}
	return response, nil
}

func remoteTrackPartialObservation(request sfuTracksEndpointRequest, response mediaplane.TracksResponse) (mediapublications.RemoteTrackObservationInput, bool) {
	returned := make(map[mediaplane.RemoteTrackIdentity]struct{}, len(response.Tracks))
	for _, track := range response.Tracks {
		if track.Location == "remote" {
			returned[mediaplane.RemoteTrackIdentity{ConnectionID: track.SessionID, TrackName: track.TrackName}] = struct{}{}
		}
	}
	missing := make([]mediaplane.RemoteTrackIdentity, 0, len(request.Body.Tracks))
	for _, track := range request.Body.Tracks {
		if track.Location != "remote" {
			continue
		}
		identity := mediaplane.RemoteTrackIdentity{ConnectionID: track.SessionID, TrackName: track.TrackName}
		if _, present := returned[identity]; !present {
			missing = append(missing, identity)
		}
	}
	return remoteTrackObservation(request, missing)
}

func logRemoteTrackResponse(ctx context.Context, response mediaplane.TracksResponse, observation mediapublications.RemoteTrackObservationInput, partial bool) {
	descriptionType := "none"
	if response.SessionDescription != nil {
		descriptionType = strings.ToLower(strings.TrimSpace(response.SessionDescription.Type))
		if descriptionType != "offer" && descriptionType != "answer" {
			descriptionType = "unknown"
		}
	}
	slog.InfoContext(ctx, "Cloudflare SFU remote track response",
		"event", "cloudflare_sfu.remote_track_response",
		"partial", partial,
		"requested_track_count", len(observation.Requested),
		"missing_track_count", len(observation.Missing),
		"response_track_count", len(response.Tracks),
		"sdp_type", descriptionType,
		"requires_immediate_renegotiation", response.RequiresImmediateRenegotiation,
	)
}

func remoteTrackObservationForFailure(request sfuTracksEndpointRequest, err error) (mediapublications.RemoteTrackObservationInput, bool) {
	if !mediaplane.IsExactRemoteTrackAbsence(err) {
		return mediapublications.RemoteTrackObservationInput{}, false
	}
	return remoteTrackObservation(request, mediaplane.MissingRemoteTracks(err))
}

func remoteTrackObservation(request sfuTracksEndpointRequest, missing []mediaplane.RemoteTrackIdentity) (mediapublications.RemoteTrackObservationInput, bool) {
	requested := make([]mediapublications.RemoteTrackIdentity, 0, len(request.Body.Tracks))
	requestedSet := make(map[mediapublications.RemoteTrackIdentity]struct{}, len(request.Body.Tracks))
	for _, track := range request.Body.Tracks {
		if track.Location != "remote" {
			continue
		}
		identity := mediapublications.RemoteTrackIdentity{ConnectionID: track.SessionID, TrackName: track.TrackName}
		requested = append(requested, identity)
		requestedSet[identity] = struct{}{}
	}
	if len(requested) == 0 {
		return mediapublications.RemoteTrackObservationInput{}, false
	}
	missingPublications := make([]mediapublications.RemoteTrackIdentity, 0, len(missing))
	for _, track := range missing {
		identity := mediapublications.RemoteTrackIdentity{ConnectionID: track.ConnectionID, TrackName: track.TrackName}
		if _, requestedHere := requestedSet[identity]; requestedHere {
			missingPublications = append(missingPublications, identity)
		}
	}
	if len(missing) > 0 && len(missingPublications) == 0 {
		return mediapublications.RemoteTrackObservationInput{}, false
	}
	return mediapublications.RemoteTrackObservationInput{
		TenantID: request.TenantID, EpisodeID: request.EpisodeID, ListenerParticipantID: request.ParticipantID,
		ListenerConnectionID: request.Body.ConnectionID,
		Requested:            requested, Missing: missingPublications,
	}, true
}
