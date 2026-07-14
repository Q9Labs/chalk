package httpapi

import (
	"context"
	"net/http"

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

type sfuTracksEndpointRequest struct {
	TenantID      utilities.ID
	RoomID        utilities.ID
	SessionID     utilities.ID
	ParticipantID utilities.ID
	Body          sfuTracksRequest
}

type sfuRenegotiateEndpointRequest struct {
	TenantID      utilities.ID
	RoomID        utilities.ID
	SessionID     utilities.ID
	ParticipantID utilities.ID
	Body          sfuRenegotiateRequest
}

type sfuRenegotiateResponse struct {
	Accepted bool `json:"accepted"`
}

type sfuPublicationsEndpointRequest struct {
	TenantID      utilities.ID
	RoomID        utilities.ID
	SessionID     utilities.ID
	ParticipantID utilities.ID
}

type sfuPublicationResponse struct {
	ParticipantSessionID string `json:"participant_session_id"`
	Source               string `json:"source"`
	PublicationID        string `json:"publication_id"`
}

type sfuPublicationsResponse struct {
	Incarnation  int64                    `json:"incarnation"`
	Sequence     int64                    `json:"sequence"`
	Publications []sfuPublicationResponse `json:"publications"`
}

func sfuSignalingEndpoints(rooms RoomService, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		sfuAddTracksEndpoint(rooms, tenants, media, publications, authorizer),
		sfuRenegotiateEndpoint(rooms, tenants, media, authorizer),
		sfuListPublicationsEndpoint(rooms, tenants, media, publications, authorizer),
	}
}

func sfuAddTracksEndpoint(rooms RoomService, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry, authorizer TenantAuthorizer) Endpoint[sfuTracksEndpointRequest, mediaplane.TracksResponse] {
	return Post(
		"/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/media/sfu/tracks",
		"/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/media/sfu/tracks",
		"addCloudflareSFUTracks",
		decodeSFUTracksRequest,
		func(ctx context.Context, request sfuTracksEndpointRequest) (mediaplane.TracksResponse, error) {
			if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
				return mediaplane.TracksResponse{}, err
			}
			service, err := resolveSFUSignalingPlane(ctx, rooms, tenants, media, request.TenantID, request.RoomID, request.SessionID)
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
					published = append(published, mediapublications.PublishedTrack{Source: track.Source, TrackName: track.TrackName})
				}
			}
			if len(published) > 0 {
				if publications == nil {
					return mediaplane.TracksResponse{}, mediapublications.ErrUnavailable
				}
				if err := publications.RecordPublishedTracks(ctx, mediapublications.RecordInput{TenantID: request.TenantID, SessionID: request.SessionID, ParticipantSessionID: request.ParticipantID, ConnectionID: request.Body.ConnectionID, Tracks: published}); err != nil {
					return mediaplane.TracksResponse{}, err
				}
			}
			return response, nil
		},
	).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantRoomSessionParticipantParameters()...).
		RequestBody("CloudflareSFUTracksRequest", sfuTracksRequest{}).
		Responds(http.StatusOK, "CloudflareSFUTracksResponse", mediaplane.TracksResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidParticipantID, apiErrorSessionNotFound, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func sfuListPublicationsEndpoint(rooms RoomService, tenants TenantService, media MediaPlaneResolver, publications mediapublications.Registry, authorizer TenantAuthorizer) Endpoint[sfuPublicationsEndpointRequest, sfuPublicationsResponse] {
	return Get(
		"/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/media/sfu/publications",
		"/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/media/sfu/publications",
		"listCloudflareSFUPublications",
		decodeSFUPublicationsRequest,
		func(ctx context.Context, request sfuPublicationsEndpointRequest) (sfuPublicationsResponse, error) {
			if err := authorizeTenant(ctx, authorizer, request.TenantID, readSessionsPermission); err != nil {
				return sfuPublicationsResponse{}, err
			}
			if _, err := resolveSFUSignalingPlane(ctx, rooms, tenants, media, request.TenantID, request.RoomID, request.SessionID); err != nil {
				return sfuPublicationsResponse{}, err
			}
			if publications == nil {
				return sfuPublicationsResponse{}, mediapublications.ErrUnavailable
			}
			snapshot, err := publications.Latest(ctx, request.TenantID, request.SessionID)
			if err != nil {
				return sfuPublicationsResponse{}, err
			}
			response := sfuPublicationsResponse{Incarnation: snapshot.Incarnation, Sequence: snapshot.Sequence, Publications: make([]sfuPublicationResponse, 0, len(snapshot.Publications))}
			for _, publication := range snapshot.Publications {
				if publication.Enabled && publication.PublicationID != "" {
					response.Publications = append(response.Publications, sfuPublicationResponse{ParticipantSessionID: publication.ParticipantSessionID.String(), Source: publication.Source, PublicationID: publication.PublicationID})
				}
			}
			return response, nil
		},
	).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantRoomSessionParticipantParameters()...).
		Responds(http.StatusOK, "CloudflareSFUPublicationsResponse", sfuPublicationsResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidParticipantID, apiErrorSessionNotFound, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func sfuRenegotiateEndpoint(rooms RoomService, tenants TenantService, media MediaPlaneResolver, authorizer TenantAuthorizer) Endpoint[sfuRenegotiateEndpointRequest, sfuRenegotiateResponse] {
	return Post(
		"/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/media/sfu/renegotiate",
		"/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/media/sfu/renegotiate",
		"renegotiateCloudflareSFU",
		decodeSFURenegotiateRequest,
		func(ctx context.Context, request sfuRenegotiateEndpointRequest) (sfuRenegotiateResponse, error) {
			if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
				return sfuRenegotiateResponse{}, err
			}
			service, err := resolveSFUSignalingPlane(ctx, rooms, tenants, media, request.TenantID, request.RoomID, request.SessionID)
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
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantRoomSessionParticipantParameters()...).
		RequestBody("CloudflareSFURenegotiateRequest", sfuRenegotiateRequest{}).
		Responds(http.StatusOK, "CloudflareSFURenegotiateResponse", sfuRenegotiateResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidParticipantID, apiErrorSessionNotFound, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func decodeSFUTracksRequest(request *http.Request) (sfuTracksEndpointRequest, error) {
	tenantID, roomID, sessionID, participantID, err := tenantRoomSessionParticipantIDsRequest(request)
	if err != nil {
		return sfuTracksEndpointRequest{}, err
	}
	body, err := decodeJSONBody[sfuTracksRequest](request)
	if err != nil {
		return sfuTracksEndpointRequest{}, err
	}
	return sfuTracksEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, ParticipantID: participantID, Body: body}, nil
}

func decodeSFURenegotiateRequest(request *http.Request) (sfuRenegotiateEndpointRequest, error) {
	tenantID, roomID, sessionID, participantID, err := tenantRoomSessionParticipantIDsRequest(request)
	if err != nil {
		return sfuRenegotiateEndpointRequest{}, err
	}
	body, err := decodeJSONBody[sfuRenegotiateRequest](request)
	if err != nil {
		return sfuRenegotiateEndpointRequest{}, err
	}
	return sfuRenegotiateEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, ParticipantID: participantID, Body: body}, nil
}

func decodeSFUPublicationsRequest(request *http.Request) (sfuPublicationsEndpointRequest, error) {
	tenantID, roomID, sessionID, participantID, err := tenantRoomSessionParticipantIDsRequest(request)
	if err != nil {
		return sfuPublicationsEndpointRequest{}, err
	}
	return sfuPublicationsEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, ParticipantID: participantID}, nil
}

func tenantRoomSessionParticipantIDsRequest(request *http.Request) (utilities.ID, utilities.ID, utilities.ID, utilities.ID, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(request)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, err
	}
	participantID, err := routeID(request, "participant_session_id", apiErrorInvalidParticipantID)
	return tenantID, roomID, sessionID, participantID, err
}

func tenantRoomSessionParticipantParameters() []APIParameterContract {
	return []APIParameterContract{tenantIDParameter(), roomIDParameter(), sessionIDParameter(), participantSessionIDParameter()}
}

func resolveSFUSignalingPlane(ctx context.Context, rooms RoomService, tenants TenantService, media MediaPlaneResolver, tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) (*mediaplane.Service, error) {
	if rooms == nil {
		return nil, mediaplane.ErrPlaneUnavailable
	}
	if _, err := rooms.GetSession(ctx, tenantID, roomID, sessionID); err != nil {
		return nil, err
	}
	service, err := resolveMediaPlane(ctx, media, rooms, tenants, tenantID, roomID)
	if err != nil {
		return nil, err
	}
	if service == nil || service.Provider() != mediaplane.ProviderCloudflareSFU {
		return nil, mediaplane.ErrInvalidProvider
	}
	return service, nil
}
