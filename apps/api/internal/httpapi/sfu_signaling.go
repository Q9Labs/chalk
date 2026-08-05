package httpapi

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type sfuTracksRequest struct {
	ConnectionID       string                         `json:"connection_id"`
	SessionDescription *mediaplane.SessionDescription `json:"session_description,omitempty"`
	Tracks             []mediaplane.Track             `json:"tracks"`
}

type sfuRenegotiateRequest struct {
	ConnectionID       string                        `json:"connection_id"`
	SessionDescription mediaplane.SessionDescription `json:"session_description"`
}

type sfuCloseTracksRequest struct {
	ConnectionID       string                         `json:"connection_id"`
	SessionDescription *mediaplane.SessionDescription `json:"session_description,omitempty"`
	Tracks             []sfuCloseTrackRequest         `json:"tracks"`
	Force              bool                           `json:"force"`
}

type sfuCloseTrackRequest struct {
	Mid           string `json:"mid"`
	Source        string `json:"source"`
	PublicationID string `json:"publication_id"`
}

type sfuTracksEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	Body          sfuTracksRequest
}

type sfuRenegotiateEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	Body          sfuRenegotiateRequest
}

type sfuCloseTracksEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	Body          sfuCloseTracksRequest
}

type sfuRenegotiateResponse struct {
	Accepted bool `json:"accepted"`
}

type sfuPublicationsEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
}

type sfuPublicationResponse struct {
	ParticipantID string `json:"participant_id"`
	Source        string `json:"source"`
	PublicationID string `json:"publication_id"`
}

type sfuPublicationsResponse struct {
	Incarnation  int64                    `json:"incarnation"`
	Sequence     int64                    `json:"sequence"`
	Publications []sfuPublicationResponse `json:"publications"`
}

// EpisodeLookup provides the bounded read needed to ensure participant media
// routes refer to an Episode belonging to the requested Space.
type EpisodeLookup interface {
	GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error)
}

func mountParticipantMediaRoutes(r chi.Router, spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry, verifier ParticipantMediaVerifier, active ActiveParticipantAuthorizer, limits RateLimitOptions) {
	r.Use(requireParticipantMedia(verifier, active))
	for _, endpoint := range sfuSignalingEndpoints(spaces, episodeLookup, tenants, media, publications) {
		endpoint.Mount(r, limits)
	}
}

func sfuSignalingEndpoints(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) []RouteEndpoint {
	return []RouteEndpoint{
		sfuAddTracksEndpoint(spaces, episodeLookup, tenants, media, publications),
		sfuCloseTracksEndpoint(spaces, episodeLookup, tenants, media, publications),
		sfuRenegotiateEndpoint(spaces, episodeLookup, tenants, media),
		sfuListPublicationsEndpoint(spaces, episodeLookup, tenants, media, publications),
	}
}

func sfuAddTracksEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) Endpoint[sfuTracksEndpointRequest, mediaplane.TracksResponse] {
	return Post(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/tracks",
		"/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/tracks",
		"addCloudflareSFUTracks",
		decodeSFUTracksRequest,
		func(ctx context.Context, request sfuTracksEndpointRequest) (mediaplane.TracksResponse, error) {
			if err := authorizeSFURequest(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.ParticipantID, request.Body.ConnectionID); err != nil {
				return mediaplane.TracksResponse{}, err
			}
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return mediaplane.TracksResponse{}, apiErrorUnauthenticated
			}
			service, err := resolveSFUSignalingPlane(ctx, spaces, episodeLookup, tenants, media, request.TenantID, request.SpaceID, request.EpisodeID)
			if err != nil {
				return mediaplane.TracksResponse{}, err
			}
			response, err := service.AddTracks(ctx, mediaplane.TracksRequest{
				ConnectionID:       request.Body.ConnectionID,
				SessionDescription: request.Body.SessionDescription,
				Tracks:             request.Body.Tracks,
			})
			if err != nil {
				return mediaplane.TracksResponse{}, err
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
		},
	).
		Auth(APIAuthParticipantMedia).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantSpaceEpisodeParticipantParameters()...).
		RequestBody("CloudflareSFUTracksRequest", sfuTracksRequest{}).
		Responds(http.StatusOK, "CloudflareSFUTracksAPIResponse", mediaplane.TracksResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).
		MapErrors(episodeLifecycleEndpointAPIError)
}

func sfuCloseTracksEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) Endpoint[sfuCloseTracksEndpointRequest, mediaplane.CloseTracksResponse] {
	return Put(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/tracks/close",
		"/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/tracks/close",
		"closeCloudflareSFUTracks",
		decodeSFUCloseTracksRequest,
		func(ctx context.Context, request sfuCloseTracksEndpointRequest) (mediaplane.CloseTracksResponse, error) {
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
			if publications == nil {
				return mediaplane.CloseTracksResponse{}, mediapublications.ErrUnavailable
			}
			requiredTracks := make([]mediaplane.CloseTrack, 0, len(tracks))
			for _, track := range tracks {
				decision, err := publications.PrepareClose(ctx, mediapublications.CloseInput{
					TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID,
					ParticipantGeneration: subject.ParticipantGeneration, ConnectionID: request.Body.ConnectionID,
					MID: track.Mid, Source: track.Source, PublicationID: track.PublicationID,
				})
				if err != nil {
					return mediaplane.CloseTracksResponse{}, err
				}
				if decision.ProviderCloseRequired {
					requiredTracks = append(requiredTracks, track)
				}
			}
			if len(requiredTracks) == 0 {
				return mediaplane.CloseTracksResponse{Tracks: tracks}, nil
			}
			response, err := service.CloseTracks(ctx, mediaplane.CloseTracksRequest{
				Provider: service.Provider(), ConnectionID: request.Body.ConnectionID,
				SessionDescription: request.Body.SessionDescription, Tracks: requiredTracks, Force: request.Body.Force,
			})
			if err != nil {
				return mediaplane.CloseTracksResponse{}, err
			}
			for _, track := range requiredTracks {
				if err := publications.RecordClosedPublication(ctx, mediapublications.CloseInput{
					TenantID: request.TenantID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID,
					ParticipantGeneration: subject.ParticipantGeneration, ConnectionID: request.Body.ConnectionID,
					MID: track.Mid, Source: track.Source, PublicationID: track.PublicationID,
				}); err != nil {
					return mediaplane.CloseTracksResponse{}, err
				}
			}
			response.Tracks = tracks
			return response, nil
		},
	).
		Auth(APIAuthParticipantMedia).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantSpaceEpisodeParticipantParameters()...).
		RequestBody("CloudflareSFUCloseTracksRequest", sfuCloseTracksRequest{}).
		Responds(http.StatusOK, "CloudflareSFUCloseTracksAPIResponse", mediaplane.CloseTracksResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).
		MapErrors(episodeLifecycleEndpointAPIError)
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

func sfuListPublicationsEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry) Endpoint[sfuPublicationsEndpointRequest, sfuPublicationsResponse] {
	return Get(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/publications",
		"/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/publications",
		"listCloudflareSFUPublications",
		decodeSFUPublicationsRequest,
		func(ctx context.Context, request sfuPublicationsEndpointRequest) (sfuPublicationsResponse, error) {
			if err := authorizeSFURequest(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.ParticipantID, ""); err != nil {
				return sfuPublicationsResponse{}, err
			}
			if _, err := resolveSFUSignalingPlane(ctx, spaces, episodeLookup, tenants, media, request.TenantID, request.SpaceID, request.EpisodeID); err != nil {
				return sfuPublicationsResponse{}, err
			}
			if publications == nil {
				return sfuPublicationsResponse{}, mediapublications.ErrUnavailable
			}
			snapshot, err := publications.Latest(ctx, request.TenantID, request.EpisodeID)
			if err != nil {
				return sfuPublicationsResponse{}, err
			}
			response := sfuPublicationsResponse{Incarnation: snapshot.Incarnation, Sequence: snapshot.Sequence, Publications: make([]sfuPublicationResponse, 0, len(snapshot.Publications))}
			for _, publication := range snapshot.Publications {
				if publication.Enabled && publication.PublicationID != "" {
					response.Publications = append(response.Publications, sfuPublicationResponse{ParticipantID: publication.ParticipantID.String(), Source: publication.Source, PublicationID: publication.PublicationID})
				}
			}
			return response, nil
		},
	).
		Auth(APIAuthParticipantMedia).
		Parameters(tenantSpaceEpisodeParticipantParameters()...).
		Responds(http.StatusOK, "CloudflareSFUPublicationsResponse", sfuPublicationsResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).
		MapErrors(episodeLifecycleEndpointAPIError)
}

func sfuRenegotiateEndpoint(spaces SpaceService, episodeLookup EpisodeLookup, tenants TenantService, media MediaPlaneResolver) Endpoint[sfuRenegotiateEndpointRequest, sfuRenegotiateResponse] {
	return Post(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/renegotiate",
		"/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/media/sfu/renegotiate",
		"renegotiateCloudflareSFU",
		decodeSFURenegotiateRequest,
		func(ctx context.Context, request sfuRenegotiateEndpointRequest) (sfuRenegotiateResponse, error) {
			if err := authorizeSFURequest(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.ParticipantID, request.Body.ConnectionID); err != nil {
				return sfuRenegotiateResponse{}, err
			}
			service, err := resolveSFUSignalingPlane(ctx, spaces, episodeLookup, tenants, media, request.TenantID, request.SpaceID, request.EpisodeID)
			if err != nil {
				return sfuRenegotiateResponse{}, err
			}
			err = service.Renegotiate(ctx, mediaplane.RenegotiateRequest{
				ConnectionID:       request.Body.ConnectionID,
				SessionDescription: request.Body.SessionDescription,
			})
			return sfuRenegotiateResponse{Accepted: err == nil}, err
		},
	).
		Auth(APIAuthParticipantMedia).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantSpaceEpisodeParticipantParameters()...).
		RequestBody("CloudflareSFURenegotiateRequest", sfuRenegotiateRequest{}).
		Responds(http.StatusOK, "CloudflareSFURenegotiateResponse", sfuRenegotiateResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).
		MapErrors(episodeLifecycleEndpointAPIError)
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
	return sfuTracksEndpointRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, Body: body}, nil
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

func tenantSpaceEpisodeParticipantIDsRequest(request *http.Request) (utilities.ID, utilities.ID, utilities.ID, utilities.ID, error) {
	tenantID, spaceID, episodeID, err := tenantSpaceEpisodeIDsRequest(request)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, err
	}
	participantID, err := routeID(request, "participant_id", apiErrorInvalidParticipantID)
	return tenantID, spaceID, episodeID, participantID, err
}

func tenantSpaceEpisodeParticipantParameters() []APIParameterContract {
	return []APIParameterContract{tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), participantIDParameter()}
}

func authorizeSFURequest(ctx context.Context, tenantID, spaceID, episodeID, participantID utilities.ID, connectionID string) error {
	subject, ok := accessgrants.SubjectFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if connectionID == "" {
		connectionID = subject.CloudflareConnectionID
	}
	return requireParticipantMediaRoute(
		ctx, tenantID, spaceID, episodeID, participantID, subject.ParticipantGeneration,
		accessgrants.ProviderCloudflareSFU, connectionID,
	)
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
	service, err := resolveMediaPlane(ctx, media, spaces, tenants, tenantID, spaceID)
	if err != nil {
		return nil, err
	}
	if service == nil || service.Provider() != mediaplane.ProviderCloudflareSFU {
		return nil, mediaplane.ErrInvalidProvider
	}
	return service, nil
}
