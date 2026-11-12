package httpapi

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
)

func signalSFUCloseTracks(ctx context.Context, request sfuCloseTracksEndpointRequest, spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) (mediaplane.CloseTracksResponse, error) {
	if err := authorizeSFURequest(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.ParticipantID, request.Body.ConnectionID); err != nil {
		return mediaplane.CloseTracksResponse{}, err
	}
	subject, ok := accessgrants.SubjectFromContext(ctx)
	if !ok {
		return mediaplane.CloseTracksResponse{}, apiErrorUnauthenticated
	}
	service, err := resolveSFUSignalingPlane(ctx, spaces, episodeLookup, tenants, media, request.TenantID, request.SpaceID, request.EpisodeID)
	if err != nil {
		return mediaplane.CloseTracksResponse{}, err
	}
	tracks := make([]mediaplane.CloseTrack, 0, len(request.Body.Tracks))
	for _, track := range request.Body.Tracks {
		tracks = append(tracks, mediaplane.CloseTrack{Mid: track.Mid, Source: track.Source, PublicationID: track.PublicationID})
	}
	if request.Body.ReceiveOnly {
		return service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
			Provider: service.Provider(), ConnectionID: request.Body.ConnectionID, Scope: sfuScope(ctx),
			Tracks: tracks, Force: true, ReceiveOnly: true,
		})
	}
	if publications == nil {
		return mediaplane.CloseTracksResponse{}, mediapublications.ErrUnavailable
	}
	closeInput := func(track mediaplane.CloseTrack) mediapublications.CloseInput {
		return mediapublications.CloseInput{
			TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID,
			ParticipantGeneration: subject.ParticipantGeneration, ConnectionID: request.Body.ConnectionID,
			MID: track.Mid, Source: track.Source, PublicationID: track.PublicationID,
		}
	}
	requiredTracks := make([]mediaplane.CloseTrack, 0, len(tracks))
	for _, track := range tracks {
		decision, err := publications.PrepareClose(ctx, closeInput(track))
		if err != nil {
			return mediaplane.CloseTracksResponse{}, err
		}
		// A force-closed track still needs an offer/answer exchange to
		// retire its browser media section before a fresh publication.
		if decision.ProviderCloseRequired || (!request.Body.Force && request.Body.SessionDescription != nil) {
			requiredTracks = append(requiredTracks, track)
		}
	}
	if len(requiredTracks) == 0 {
		return mediaplane.CloseTracksResponse{Tracks: tracks}, nil
	}
	response, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
		Provider: service.Provider(), ConnectionID: request.Body.ConnectionID, Scope: sfuScope(ctx),
		SessionDescription: request.Body.SessionDescription, Tracks: requiredTracks, Force: request.Body.Force,
	})
	if err != nil {
		return mediaplane.CloseTracksResponse{}, err
	}
	for _, track := range requiredTracks {
		if err := publications.RecordClosedPublication(ctx, closeInput(track)); err != nil {
			return mediaplane.CloseTracksResponse{}, err
		}
	}
	response.Tracks = tracks
	return response, nil
}

func listSFUPublications(ctx context.Context, request sfuPublicationsEndpointRequest, spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) (sfuPublicationsResponse, error) {
	if err := authorizeSFURequest(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.ParticipantID, ""); err != nil {
		return sfuPublicationsResponse{}, err
	}
	if _, err := resolveSFUSignalingPlane(ctx, spaces, episodeLookup, tenants, media, request.TenantID, request.SpaceID, request.EpisodeID); err != nil {
		return sfuPublicationsResponse{}, err
	}
	return listEnabledPublications(ctx, publications, request.TenantID, request.EpisodeID)
}

func listSFUSubscriptions(ctx context.Context, request sfuPublicationsEndpointRequest, spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver) (sfuSubscriptionsResponse, error) {
	if err := authorizeSFURequest(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.ParticipantID, ""); err != nil {
		return sfuSubscriptionsResponse{}, err
	}
	service, err := resolveSFUSignalingPlane(ctx, spaces, episodeLookup, tenants, media, request.TenantID, request.SpaceID, request.EpisodeID)
	if err != nil {
		return sfuSubscriptionsResponse{}, err
	}
	subject, _ := accessgrants.SubjectFromContext(ctx)
	states, err := service.SubscriptionStates(ctx, mediaplane.SubscriptionStatesRequest{ConnectionID: subject.ConnectionID, Scope: sfuScope(ctx)})
	if errors.Is(err, mediaplane.ErrUnsupportedOperation) {
		return sfuSubscriptionsResponse{}, fmt.Errorf("%w: this media plane reports no subscription state", mediaplane.ErrInvalidSignalRequest)
	}
	if err != nil {
		return sfuSubscriptionsResponse{}, err
	}
	response := sfuSubscriptionsResponse{Subscriptions: make([]sfuSubscriptionResponse, 0, len(states))}
	for _, state := range states {
		response.Subscriptions = append(response.Subscriptions, sfuSubscriptionResponse{
			Mid: state.Mid, SessionID: state.SessionID, TrackName: state.TrackName, State: state.State, Reason: state.Reason,
			Revision: state.Revision, RequestedRID: state.RequestedRID, EffectiveRID: state.EffectiveRID,
		})
	}
	return response, nil
}

func signalSFUUpdateTracks(ctx context.Context, request sfuUpdateTracksEndpointRequest, spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) (mediaplane.TracksResponse, error) {
	if err := authorizeSFURequest(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.ParticipantID, request.Body.ConnectionID); err != nil {
		return mediaplane.TracksResponse{}, err
	}
	service, err := resolveSFUSignalingPlane(ctx, spaces, episodeLookup, tenants, media, request.TenantID, request.SpaceID, request.EpisodeID)
	if err != nil {
		return mediaplane.TracksResponse{}, err
	}
	update := mediaplane.UpdateTracksRequest{ConnectionID: request.Body.ConnectionID, Scope: sfuScope(ctx), Tracks: request.Body.Tracks}
	if !slices.ContainsFunc(request.Body.Tracks, func(track mediaplane.Track) bool { return track.Location == "local" }) {
		return service.UpdateTracks(ctx, update)
	}
	return holdLocalTracks(ctx, request, service, publications, update)
}

func signalSFURenegotiate(ctx context.Context, request sfuRenegotiateEndpointRequest, spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver) (sfuRenegotiateResponse, error) {
	if err := authorizeSFURequest(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.ParticipantID, request.Body.ConnectionID); err != nil {
		return sfuRenegotiateResponse{}, err
	}
	service, err := resolveSFUSignalingPlane(ctx, spaces, episodeLookup, tenants, media, request.TenantID, request.SpaceID, request.EpisodeID)
	if err != nil {
		return sfuRenegotiateResponse{}, err
	}
	err = service.Renegotiate(ctx, mediaplane.RenegotiateRequest{
		ConnectionID:       request.Body.ConnectionID,
		Scope:              sfuScope(ctx),
		SessionDescription: request.Body.SessionDescription,
	})
	return sfuRenegotiateResponse{Accepted: err == nil}, err
}
