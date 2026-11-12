package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func sfuSignalingEndpoints(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) []RouteEndpoint {
	return []RouteEndpoint{
		sfuAddTracksEndpoint(spaces, episodeLookup, tenants, media, publications),
		sfuCloseTracksEndpoint(spaces, episodeLookup, tenants, media, publications),
		sfuUpdateTracksEndpoint(spaces, episodeLookup, tenants, media, publications),
		sfuRenegotiateEndpoint(spaces, episodeLookup, tenants, media),
		sfuListPublicationsEndpoint(spaces, episodeLookup, tenants, media, publications),
		sfuListSubscriptionsEndpoint(spaces, episodeLookup, tenants, media),
		sfuSignalEndpoint(spaces, episodeLookup, tenants, media, publications),
	}
}

// legacy: remove once no supported SDK or mobile build uses it (Android/iOS 3.0.6 use it today); see https://github.com/Q9Labs/chalk/issues/1026.
// No new behaviour lands here: the unified signal route serves the same operation.
func sfuAddTracksEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) Endpoint[sfuTracksEndpointRequest, mediaplane.TracksResponse] {
	return Post(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/tracks",
		"addCloudflareSFUTracks",
		decodeSFUTracksRequest,
		func(ctx context.Context, request sfuTracksEndpointRequest) (mediaplane.TracksResponse, error) {
			return signalSFUTracks(ctx, request, spaces, episodeLookup, tenants, media, publications)
		},
	).
		Auth(APIAuthParticipantMedia).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(append(tenantSpaceEpisodeParticipantParameters(),
			APIParameterContract{Name: "allow_partial_remote_tracks", In: "query", Type: "boolean"},
			APIParameterContract{Name: "replacement_cause", In: "query", Type: "string", Enum: observability.MediaReplacementCauses()},
		)...).
		RequestBody("CloudflareSFUTracksRequest", sfuTracksRequest{}).
		Responds(http.StatusOK, "CloudflareSFUTracksAPIResponse", mediaplane.TracksResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorMediaConnectionNotFound, apiErrorRateLimited)...).
		ErrorRules(episodeLifecycleRules)
}

// legacy: remove once no supported SDK or mobile build uses it (Android/iOS 3.0.6 use it today); see https://github.com/Q9Labs/chalk/issues/1026.
// No new behaviour lands here: the unified signal route serves the same operation.
func sfuCloseTracksEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) Endpoint[sfuCloseTracksEndpointRequest, mediaplane.CloseTracksResponse] {
	return Put(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/tracks/close",
		"closeCloudflareSFUTracks",
		decodeSFUCloseTracksRequest,
		func(ctx context.Context, request sfuCloseTracksEndpointRequest) (mediaplane.CloseTracksResponse, error) {
			return signalSFUCloseTracks(ctx, request, spaces, episodeLookup, tenants, media, publications)
		},
	).
		Auth(APIAuthParticipantMedia).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantSpaceEpisodeParticipantParameters()...).
		RequestBody("CloudflareSFUCloseTracksRequest", sfuCloseTracksRequest{}).
		Responds(http.StatusOK, "CloudflareSFUCloseTracksAPIResponse", mediaplane.CloseTracksResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorMediaConnectionNotFound, apiErrorRateLimited)...).
		ErrorRules(episodeLifecycleRules)
}

// legacy: remove once no supported SDK or mobile build uses it (Android/iOS 3.0.6 use it today); see https://github.com/Q9Labs/chalk/issues/1026.
// No new behaviour lands here: the unified signal route serves the same operation.
func sfuListPublicationsEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) Endpoint[sfuPublicationsEndpointRequest, sfuPublicationsResponse] {
	return Get(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/publications",
		"listCloudflareSFUPublications",
		decodeSFUPublicationsRequest,
		func(ctx context.Context, request sfuPublicationsEndpointRequest) (sfuPublicationsResponse, error) {
			return listSFUPublications(ctx, request, spaces, episodeLookup, tenants, media, publications)
		},
	).
		Auth(APIAuthParticipantMedia).
		Parameters(tenantSpaceEpisodeParticipantParameters()...).
		Responds(http.StatusOK, "CloudflareSFUPublicationsResponse", sfuPublicationsResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorMediaConnectionNotFound, apiErrorRateLimited)...).
		ErrorRules(episodeLifecycleRules)
}

// sfuListSubscriptionsEndpoint reports whether the plane is delivering each
// remote video of the caller's connection, and on which layer. A client reads it
// when a video goes quiet, so it can tell a paused subscription from a stall.
//
// legacy: remove once no supported SDK or mobile build uses it (Android/iOS 3.0.6 use it today); see https://github.com/Q9Labs/chalk/issues/1026.
// No new behaviour lands here: the unified signal route serves the same operation.
func sfuListSubscriptionsEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver) Endpoint[sfuPublicationsEndpointRequest, sfuSubscriptionsResponse] {
	return Get(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/subscriptions",
		"listSFUSubscriptions",
		decodeSFUPublicationsRequest,
		func(ctx context.Context, request sfuPublicationsEndpointRequest) (sfuSubscriptionsResponse, error) {
			return listSFUSubscriptions(ctx, request, spaces, episodeLookup, tenants, media)
		},
	).
		Auth(APIAuthParticipantMedia).
		Parameters(tenantSpaceEpisodeParticipantParameters()...).
		Responds(http.StatusOK, "SFUSubscriptionsResponse", sfuSubscriptionsResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorMediaConnectionNotFound, apiErrorRateLimited)...).
		ErrorRules(episodeLifecycleRules)
}

// legacy: remove once no supported SDK or mobile build uses it (Android/iOS 3.0.6 use it today); see https://github.com/Q9Labs/chalk/issues/1026.
// No new behaviour lands here: the unified signal route serves the same operation.
func sfuUpdateTracksEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) Endpoint[sfuUpdateTracksEndpointRequest, mediaplane.TracksResponse] {
	return Put(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/tracks/update",
		"updateCloudflareSFUTracks",
		decodeSFUUpdateTracksRequest,
		func(ctx context.Context, request sfuUpdateTracksEndpointRequest) (mediaplane.TracksResponse, error) {
			return signalSFUUpdateTracks(ctx, request, spaces, episodeLookup, tenants, media, publications)
		},
	).
		Auth(APIAuthParticipantMedia).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantSpaceEpisodeParticipantParameters()...).
		RequestBody("CloudflareSFUUpdateTracksRequest", sfuUpdateTracksRequest{}).
		Responds(http.StatusOK, "CloudflareSFUUpdateTracksAPIResponse", mediaplane.TracksResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorMediaConnectionNotFound, apiErrorRateLimited)...).
		ErrorRules(episodeLifecycleRules)
}

// legacy: remove once no supported SDK or mobile build uses it (Android/iOS 3.0.6 use it today); see https://github.com/Q9Labs/chalk/issues/1026.
// No new behaviour lands here: the unified signal route serves the same operation.
func sfuRenegotiateEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver) Endpoint[sfuRenegotiateEndpointRequest, sfuRenegotiateResponse] {
	return Post(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/renegotiate",
		"renegotiateCloudflareSFU",
		decodeSFURenegotiateRequest,
		func(ctx context.Context, request sfuRenegotiateEndpointRequest) (sfuRenegotiateResponse, error) {
			return signalSFURenegotiate(ctx, request, spaces, episodeLookup, tenants, media)
		},
	).
		Auth(APIAuthParticipantMedia).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantSpaceEpisodeParticipantParameters()...).
		RequestBody("CloudflareSFURenegotiateRequest", sfuRenegotiateRequest{}).
		Responds(http.StatusOK, "CloudflareSFURenegotiateResponse", sfuRenegotiateResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorMediaConnectionNotFound, apiErrorRateLimited)...).
		ErrorRules(episodeLifecycleRules)
}

func decodeSFUUpdateTracksRequest(request *http.Request) (sfuUpdateTracksEndpointRequest, error) {
	tenantID, spaceID, episodeID, participantID, err := tenantSpaceEpisodeParticipantIDsRequest(request)
	if err != nil {
		return sfuUpdateTracksEndpointRequest{}, err
	}
	body, err := decodeJSONBody[sfuUpdateTracksRequest](request)
	if err != nil {
		return sfuUpdateTracksEndpointRequest{}, err
	}
	return sfuUpdateTracksEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, Body: body}, nil
}

func decodeSFUTracksRequest(request *http.Request) (sfuTracksEndpointRequest, error) {
	tenantID, spaceID, episodeID, participantID, err := tenantSpaceEpisodeParticipantIDsRequest(request)
	if err != nil {
		return sfuTracksEndpointRequest{}, err
	}
	body, err := decodeJSONBody[sfuTracksRequest](request)
	if err != nil {
		return sfuTracksEndpointRequest{}, err
	}
	return sfuTracksEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, Body: body, AllowPartialRemoteTracks: request.URL.Query().Get("allow_partial_remote_tracks") == "true", ReplacementCause: request.URL.Query().Get("replacement_cause")}, nil
}

func decodeSFURenegotiateRequest(request *http.Request) (sfuRenegotiateEndpointRequest, error) {
	tenantID, spaceID, episodeID, participantID, err := tenantSpaceEpisodeParticipantIDsRequest(request)
	if err != nil {
		return sfuRenegotiateEndpointRequest{}, err
	}
	body, err := decodeJSONBody[sfuRenegotiateRequest](request)
	if err != nil {
		return sfuRenegotiateEndpointRequest{}, err
	}
	return sfuRenegotiateEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, Body: body}, nil
}

func decodeSFUCloseTracksRequest(request *http.Request) (sfuCloseTracksEndpointRequest, error) {
	tenantID, spaceID, episodeID, participantID, err := tenantSpaceEpisodeParticipantIDsRequest(request)
	if err != nil {
		return sfuCloseTracksEndpointRequest{}, err
	}
	body, err := decodeJSONBody[sfuCloseTracksRequest](request)
	if err != nil {
		return sfuCloseTracksEndpointRequest{}, err
	}
	return sfuCloseTracksEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, Body: body}, nil
}

func decodeSFUPublicationsRequest(request *http.Request) (sfuPublicationsEndpointRequest, error) {
	tenantID, spaceID, episodeID, participantID, err := tenantSpaceEpisodeParticipantIDsRequest(request)
	if err != nil {
		return sfuPublicationsEndpointRequest{}, err
	}
	return sfuPublicationsEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID}, nil
}

func authorizeSFURequest(ctx context.Context, tenantID, spaceID, episodeID, participantID utilities.ID, connectionID string) error {
	subject, ok := accessgrants.SubjectFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if connectionID == "" {
		connectionID = subject.ConnectionID
	}
	return requireParticipantMediaRoute(
		ctx, tenantID, spaceID, episodeID, participantID, subject.ParticipantGeneration,
		subject.Provider, connectionID,
	)
}

// sfuScope names the connection the verified media credential belongs to. The route
// check in authorizeSFURequest has already matched it to the URL.
func sfuScope(ctx context.Context) mediaplane.Scope {
	subject, _ := accessgrants.SubjectFromContext(ctx)
	return mediaplane.Scope{
		TenantID: subject.TenantID.String(), EpisodeID: subject.EpisodeID.String(),
		ParticipantID: subject.ParticipantID.String(), Generation: subject.ParticipantGeneration,
	}
}

func resolveSFUSignalingPlane(ctx context.Context, spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID) (*mediaplane.Service, error) {
	if spaces == nil {
		return nil, mediaplane.ErrPlaneUnavailable
	}
	if episodeLookup == nil {
		return nil, mediaplane.ErrPlaneUnavailable
	}
	if _, err := episodeLookup.GetEpisode(ctx, tenantID, spaceID, episodeID); err != nil {
		return nil, err
	}
	service, err := resolveMediaPlane(ctx, media, spaces, tenants, tenantID, spaceID, episodeID)
	if err != nil {
		return nil, err
	}
	subject, _ := accessgrants.SubjectFromContext(ctx)
	if service == nil || string(service.Provider()) != subject.Provider {
		return nil, mediaplane.ErrInvalidProvider
	}
	return service, nil
}
