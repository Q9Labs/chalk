package httpapi

import (
	"context"
	"errors"
	"slices"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func signalSFUTracks(ctx context.Context, request sfuTracksEndpointRequest, spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) (mediaplane.TracksResponse, error) {
	if err := authorizeSFURequest(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.ParticipantID, request.Body.ConnectionID); err != nil {
		return mediaplane.TracksResponse{}, err
	}
	observability.LogMediaConnectionReplacement(ctx, request.ReplacementCause)
	subject, ok := accessgrants.SubjectFromContext(ctx)
	if !ok {
		return mediaplane.TracksResponse{}, apiErrorUnauthenticated
	}
	service, err := resolveSFUSignalingPlane(ctx, spaces, episodeLookup, tenants, media, request.TenantID, request.SpaceID, request.EpisodeID)
	if err != nil {
		return mediaplane.TracksResponse{}, err
	}
	if !request.Body.PullPublishedAudio {
		return pullOrPushTracks(ctx, request, subject, service, publications)
	}
	list, err := expandPullPublishedAudio(ctx, &request, service, publications)
	if err != nil {
		return mediaplane.TracksResponse{}, err
	}
	if len(request.Body.Tracks) == 0 {
		return mediaplane.TracksResponse{Publications: &list}, nil
	}
	response, err := pullOrPushTracks(ctx, request, subject, service, publications)
	if err != nil {
		return mediaplane.TracksResponse{}, err
	}
	response.Publications = &list
	return response, nil
}

// expandPullPublishedAudio turns a pull-published-audio request into the remote tracks the SDK's first poll would
// pull: every enabled microphone and screen audio publication of another Participant. Video waits for the UI's
// tile reports, so it is never part of this request.
func expandPullPublishedAudio(ctx context.Context, request *sfuTracksEndpointRequest, service *mediaplane.Service, publications mediapublications.Registry) (mediaplane.PublicationList, error) {
	body := request.Body
	if service.Provider() != mediaplane.ProviderChalkSFU || len(body.Tracks) > 0 || body.SessionDescription != nil {
		return mediaplane.PublicationList{}, mediaplane.ErrInvalidSignalRequest
	}
	list, err := listEnabledPublications(ctx, publications, request.TenantID, request.EpisodeID)
	if err != nil {
		return mediaplane.PublicationList{}, err
	}
	self := request.ParticipantID.String()
	for _, publication := range list.Publications {
		if publication.ParticipantID == self || (publication.Source != "microphone" && publication.Source != "screen_audio") {
			continue
		}
		reference, err := mediapublications.ParseReference(publication.PublicationID)
		if err != nil {
			continue
		}
		if len(request.Body.Tracks) == mediaplane.MaxTracksPerRequest {
			break
		}
		request.Body.Tracks = append(request.Body.Tracks, mediaplane.Track{Location: "remote", SessionID: reference.ConnectionID, TrackName: reference.TrackName})
	}
	request.AllowPartialRemoteTracks = true
	return list, nil
}

func listEnabledPublications(ctx context.Context, publications mediapublications.Registry, tenantID, episodeID utilities.ID) (mediaplane.PublicationList, error) {
	if publications == nil {
		return mediaplane.PublicationList{}, mediapublications.ErrUnavailable
	}
	snapshot, err := publications.Latest(ctx, tenantID, episodeID)
	if err != nil {
		return mediaplane.PublicationList{}, err
	}
	list := mediaplane.PublicationList{Incarnation: snapshot.Incarnation, Sequence: snapshot.Sequence, Publications: make([]mediaplane.ListedPublication, 0, len(snapshot.Publications))}
	for _, publication := range snapshot.Publications {
		if publication.Enabled && publication.PublicationID != "" {
			list.Publications = append(list.Publications, mediaplane.ListedPublication{ParticipantID: publication.ParticipantID.String(), Source: publication.Source, PublicationID: publication.PublicationID})
		}
	}
	return list, nil
}

func pullOrPushTracks(ctx context.Context, request sfuTracksEndpointRequest, subject accessgrants.Subject, service *mediaplane.Service, publications mediapublications.Registry) (mediaplane.TracksResponse, error) {
	episode := mediapublications.ReceiveHealthEpisode{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID}
	var capture mediapublications.ListenerPullCapture
	for _, track := range request.Body.Tracks {
		if track.Location == "remote" {
			if observer, ok := publications.(interface {
				CaptureListenerPull(mediapublications.ReceiveHealthEpisode) mediapublications.ListenerPullCapture
			}); ok {
				capture = observer.CaptureListenerPull(episode)
			}
			break
		}
	}
	response, err := service.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID:       request.Body.ConnectionID,
		Scope:              sfuScope(ctx),
		SessionDescription: request.Body.SessionDescription,
		Tracks:             request.Body.Tracks,
		SpaceID:            request.SpaceID.String(),
		EpisodeID:          request.EpisodeID.String(),
	})
	if observer, ok := publications.(mediapublications.ListenerPullObserver); ok {
		observer.ObserveListenerPull(ctx, mediapublications.ListenerPullInput{
			ReceiveHealthEpisode: episode,
			ParticipantID:        request.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration,
			ConnectionID: request.Body.ConnectionID, Capture: capture, Requested: request.Body.Tracks, Response: response, Err: err,
		})
	}
	confirmFailedRemoteTracks(ctx, service, publications, request, response, err)
	if err != nil {
		observation, observed := remoteTrackObservationForFailure(request, err)
		if observed {
			if observer, available := remoteTrackObserver(publications); available {
				if observationErr := observer.ObserveRemoteTracks(ctx, observation); observationErr != nil {
					return mediaplane.TracksResponse{}, errors.Join(err, observationErr)
				}
				logRemoteTrackResponse(ctx, response, observation, true)
				return partialSFUTracksResponse(request, response, err)
			}
			return mediaplane.TracksResponse{}, err
		}
		if mediaplane.IsPartialRemoteTrackResponse(err) {
			observation, observed := remoteTrackPartialObservation(request, response)
			if observed {
				logRemoteTrackResponse(ctx, response, observation, true)
			}
			return partialSFUTracksResponse(request, response, err)
		}
		return mediaplane.TracksResponse{}, err
	}
	if observation, observed := remoteTrackObservation(request, nil); observed {
		observer, available := remoteTrackObserver(publications)
		if available {
			if err := observer.ObserveRemoteTracks(ctx, observation); err != nil {
				return mediaplane.TracksResponse{}, err
			}
			logRemoteTrackResponse(ctx, response, observation, false)
		}
	}
	published := make([]mediapublications.PublishedTrack, 0, len(request.Body.Tracks))
	for _, track := range request.Body.Tracks {
		if track.Location == "local" {
			published = append(published, mediapublications.PublishedTrack{Source: track.Source, MID: track.Mid, TrackName: track.TrackName})
		}
	}
	if len(published) > 0 {
		if publications == nil {
			return mediaplane.TracksResponse{}, mediapublications.ErrUnavailable
		}
		references, err := publications.RecordPublishedTracks(ctx, mediapublications.RecordInput{TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration, ConnectionID: request.Body.ConnectionID, Tracks: published})
		if err != nil {
			return mediaplane.TracksResponse{}, err
		}
		if err := attachPublishedReferences(&response, references); err != nil {
			return mediaplane.TracksResponse{}, err
		}
	}
	return response, nil
}

func attachPublishedReferences(response *mediaplane.TracksResponse, references []mediapublications.PublishedReference) error {
	byMID := make(map[string]mediapublications.PublishedReference, len(references))
	for _, reference := range references {
		if _, duplicate := byMID[reference.MID]; duplicate {
			return mediapublications.ErrInvalidPublication
		}
		byMID[reference.MID] = reference
	}
	for index := range response.Tracks {
		track := &response.Tracks[index]
		reference, ok := byMID[track.Mid]
		if !ok {
			continue
		}
		if track.TrackName != reference.TrackName {
			return mediaplane.ErrProviderFailed
		}
		track.Location = "local"
		track.Source = reference.Source
		track.PublicationID = reference.PublicationID
		delete(byMID, track.Mid)
	}
	if len(byMID) != 0 {
		return mediaplane.ErrProviderFailed
	}
	return nil
}

// holdLocalTracks parks or resumes the caller's own publications for a mute that keeps the
// track and its MID. The node changes first, so media stops before any viewer is told, and the
// publication keeps its identity in the registry with only its visibility changed. A record that
// fails after the node changed leaves a parked publication listed as live; the caller answers
// that error by closing the publication, which settles both.
func holdLocalTracks(ctx context.Context, request sfuUpdateTracksEndpointRequest, service *mediaplane.Service, publications mediapublications.Registry, update mediaplane.UpdateTracksRequest) (mediaplane.TracksResponse, error) {
	if publications == nil {
		return mediaplane.TracksResponse{}, mediapublications.ErrUnavailable
	}
	subject, ok := accessgrants.SubjectFromContext(ctx)
	if !ok {
		return mediaplane.TracksResponse{}, apiErrorUnauthenticated
	}
	for _, track := range update.Tracks {
		if track.Location != "local" {
			return mediaplane.TracksResponse{}, mediaplane.ErrInvalidSignalRequest
		}
	}
	held := func(track mediaplane.Track) mediapublications.CloseInput {
		return mediapublications.CloseInput{
			TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID,
			ParticipantGeneration: subject.ParticipantGeneration, ConnectionID: request.Body.ConnectionID,
			MID: track.Mid, Source: track.Source, PublicationID: track.PublicationID,
		}
	}
	for _, track := range update.Tracks {
		decision, err := publications.PrepareClose(ctx, held(track))
		if err != nil {
			return mediaplane.TracksResponse{}, err
		}
		if !decision.ProviderCloseRequired {
			return mediaplane.TracksResponse{}, mediapublications.ErrInvalidPublication
		}
	}
	response, err := service.UpdateTracks(ctx, update)
	if err != nil {
		return response, err
	}
	for _, track := range update.Tracks {
		// A partly applied batch still moved the tracks that did not fail on the node, so the registry follows them.
		if slices.ContainsFunc(response.TrackErrors, func(failed mediaplane.TrackError) bool { return failed.TrackName == track.TrackName }) {
			continue
		}
		if err := publications.RecordPublicationAvailability(ctx, mediapublications.AvailabilityInput{
			TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID,
			Source: track.Source, PublicationID: track.PublicationID, Enabled: track.Paused == nil || !*track.Paused,
		}); err != nil {
			return mediaplane.TracksResponse{}, err
		}
	}
	return response, nil
}
