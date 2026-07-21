package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/participantaccess"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ParticipantMediaIssuer interface {
	Issue(context.Context, participantaccess.Subject) (participantaccess.MediaCredential, error)
}

type ParticipantGenerationAuthorizer interface {
	AuthorizeActiveParticipantGeneration(context.Context, synctokens.SubjectKey, int64) (bool, error)
}

type participantAccessSubjectResponse struct {
	TenantID              string `json:"tenant_id"`
	RoomID                string `json:"room_id"`
	SessionID             string `json:"session_id"`
	ParticipantSessionID  string `json:"participant_session_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
}

type participantAccessTokenResponse struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}

type participantMediaAccessResponse struct {
	Token         string         `json:"token"`
	ExpiresAt     string         `json:"expires_at"`
	Provider      string         `json:"provider"`
	ClientPayload map[string]any `json:"client_payload"`
}

type participantAccessResponse struct {
	Subject participantAccessSubjectResponse `json:"subject"`
	Sync    participantAccessTokenResponse   `json:"sync"`
	Media   participantMediaAccessResponse   `json:"media"`
}

type issueParticipantAccessBody struct {
	ParticipantGeneration  int64  `json:"participant_session_generation"`
	CurrentMediaToken      string `json:"current_media_token,omitempty"`
	ReplaceMediaConnection bool   `json:"replace_media_connection"`
}

type issueParticipantAccessRequest struct {
	TenantID      utilities.ID
	RoomID        utilities.ID
	SessionID     utilities.ID
	ParticipantID utilities.ID
	Body          issueParticipantAccessBody
}

func issueParticipantAccessEndpoint(
	refresh SyncTokenRefreshIssuer,
	mediaIssuer ParticipantMediaIssuer,
	mediaVerifier ParticipantMediaVerifier,
	active ActiveParticipantAuthorizer,
	generations ParticipantGenerationAuthorizer,
	roomsService RoomService,
	tenantsService TenantService,
	mediaResolver MediaPlaneResolver,
	authorizer TenantAuthorizer,
) Endpoint[issueParticipantAccessRequest, participantAccessResponse] {
	return Post(
		"/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/access",
		"/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/access",
		"issueSessionParticipantAccess",
		decodeIssueParticipantAccessRequest,
		func(ctx context.Context, request issueParticipantAccessRequest) (participantAccessResponse, error) {
			if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSessionsPermission); err != nil {
				return participantAccessResponse{}, err
			}
			if refresh == nil || mediaIssuer == nil || mediaVerifier == nil || active == nil || generations == nil {
				return participantAccessResponse{}, apiErrorServiceUnavailable
			}
			if request.Body.ParticipantGeneration <= 0 {
				return participantAccessResponse{}, apiErrorInvalidRequest
			}

			key := synctokens.SubjectKey{TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID, ParticipantID: request.ParticipantID}
			var (
				subject participantaccess.Subject
				join    mediaplane.Join
				err     error
			)
			if request.Body.ReplaceMediaConnection {
				isActive, authErr := generations.AuthorizeActiveParticipantGeneration(ctx, key, request.Body.ParticipantGeneration)
				if authErr != nil {
					return participantAccessResponse{}, authErr
				}
				if !isActive {
					return participantAccessResponse{}, apiErrorForbidden
				}
				join, err = createParticipantAccessJoin(ctx, roomsService, tenantsService, mediaResolver, request)
				if err != nil {
					return participantAccessResponse{}, err
				}
				subject, err = participantSubjectForJoin(request, join)
			} else {
				currentToken := strings.TrimSpace(request.Body.CurrentMediaToken)
				if currentToken == "" {
					return participantAccessResponse{}, apiErrorInvalidRequest
				}
				subject, err = mediaVerifier.Verify(ctx, currentToken)
				if err == nil {
					err = participantaccess.RequireRouteSubject(subject, participantaccess.RouteSubject{
						TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID,
						ParticipantSessionID: request.ParticipantID, ParticipantGeneration: request.Body.ParticipantGeneration,
						Provider: subject.Provider, CloudflareConnectionID: subject.CloudflareConnectionID,
					})
				}
				if err != nil {
					return participantAccessResponse{}, participantAccessRefreshError(err)
				}
				isActive, authErr := active.AuthorizeActiveParticipant(ctx, subject)
				if authErr != nil {
					return participantAccessResponse{}, authErr
				}
				if !isActive {
					return participantAccessResponse{}, apiErrorForbidden
				}
				join, err = resumeParticipantAccessJoin(ctx, roomsService, tenantsService, mediaResolver, request, subject)
			}
			if err != nil {
				return participantAccessResponse{}, err
			}

			syncCredential, err := refresh.IssueForParticipant(ctx, key)
			if err != nil {
				return participantAccessResponse{}, err
			}
			mediaCredential, err := mediaIssuer.Issue(ctx, subject)
			if err != nil {
				return participantAccessResponse{}, err
			}
			return newParticipantAccessResponse(subject, syncCredential, mediaCredential, join), nil
		},
	).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantRoomSessionParticipantParameters()...).
		RequestBody("IssueParticipantAccessRequest", issueParticipantAccessBody{}).
		Responds(http.StatusCreated, "ParticipantAccess", participantAccessResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidParticipantID, apiErrorParticipantNotFound, apiErrorParticipantGenerationMismatch, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).
		MapErrors(sessionLifecycleEndpointAPIError)
}

func decodeIssueParticipantAccessRequest(request *http.Request) (issueParticipantAccessRequest, error) {
	tenantID, roomID, sessionID, participantID, err := tenantRoomSessionParticipantIDsRequest(request)
	if err != nil {
		return issueParticipantAccessRequest{}, err
	}
	body, err := decodeJSONBody[issueParticipantAccessBody](request)
	return issueParticipantAccessRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, ParticipantID: participantID, Body: body}, err
}

func createParticipantAccessJoin(ctx context.Context, roomsService RoomService, tenantsService TenantService, resolver MediaPlaneResolver, request issueParticipantAccessRequest) (mediaplane.Join, error) {
	service, session, err := participantAccessMediaSession(ctx, roomsService, tenantsService, resolver, request.TenantID, request.RoomID, request.SessionID)
	if err != nil {
		return mediaplane.Join{}, err
	}
	return service.CreateJoin(ctx, mediaplane.CreateJoinInput{
		Provider: service.Provider(), Session: session,
		ParticipantName: request.ParticipantID.String(), ExternalParticipantID: request.ParticipantID.String(), ParticipantPreset: "contributor",
	})
}

func resumeParticipantAccessJoin(ctx context.Context, roomsService RoomService, tenantsService TenantService, resolver MediaPlaneResolver, request issueParticipantAccessRequest, subject participantaccess.Subject) (mediaplane.Join, error) {
	service, session, err := participantAccessMediaSession(ctx, roomsService, tenantsService, resolver, request.TenantID, request.RoomID, request.SessionID)
	if err != nil {
		return mediaplane.Join{}, err
	}
	return service.ResumeJoin(ctx, mediaplane.ResumeJoinInput{
		Provider: service.Provider(), Session: session, ExternalParticipantID: request.ParticipantID.String(), ConnectionRef: subject.CloudflareConnectionID,
	})
}

func participantAccessMediaSession(ctx context.Context, roomsService RoomService, tenantsService TenantService, resolver MediaPlaneResolver, tenantID, roomID, sessionID utilities.ID) (*mediaplane.Service, mediaplane.Session, error) {
	service, err := resolveMediaPlane(ctx, resolver, roomsService, tenantsService, tenantID, roomID)
	if err != nil {
		return nil, mediaplane.Session{}, err
	}
	if service == nil || service.Provider() != mediaplane.ProviderCloudflareSFU {
		return nil, mediaplane.Session{}, mediaplane.ErrPlaneUnavailable
	}
	session, err := service.EnsureSession(ctx, mediaplane.EnsureSessionInput{Provider: service.Provider(), SessionKey: sessionID.String(), Metadata: map[string]string{"tenant_id": tenantID.String(), "room_id": roomID.String()}})
	return service, session, err
}

func participantSubjectForJoin(request issueParticipantAccessRequest, join mediaplane.Join) (participantaccess.Subject, error) {
	connectionID, ok := join.ClientPayload["connectionId"].(string)
	connectionID = strings.TrimSpace(connectionID)
	if !ok || connectionID == "" || join.Provider != mediaplane.ProviderCloudflareSFU {
		return participantaccess.Subject{}, mediaplane.ErrProviderFailed
	}
	return participantaccess.Subject{
		TenantID: request.TenantID, RoomID: request.RoomID, SessionID: request.SessionID,
		ParticipantSessionID: request.ParticipantID, ParticipantGeneration: request.Body.ParticipantGeneration,
		Provider: participantaccess.ProviderCloudflareSFU, CloudflareConnectionID: connectionID,
	}, nil
}

func newParticipantAccessResponse(subject participantaccess.Subject, syncCredential synctokens.Token, mediaCredential participantaccess.MediaCredential, join mediaplane.Join) participantAccessResponse {
	return participantAccessResponse{
		Subject: participantAccessSubjectResponse{
			TenantID: subject.TenantID.String(), RoomID: subject.RoomID.String(), SessionID: subject.SessionID.String(),
			ParticipantSessionID: subject.ParticipantSessionID.String(), ParticipantGeneration: subject.ParticipantGeneration,
		},
		Sync:  participantAccessTokenResponse{Token: syncCredential.Value, ExpiresAt: syncCredential.ExpiresAt.UTC().Format(time.RFC3339)},
		Media: participantMediaAccessResponse{Token: mediaCredential.Token, ExpiresAt: mediaCredential.ExpiresAt.UTC().Format(time.RFC3339), Provider: subject.Provider, ClientPayload: join.ClientPayload},
	}
}

func participantAccessRefreshError(err error) error {
	if errors.Is(err, participantaccess.ErrSubjectMismatch) {
		return apiErrorForbidden
	}
	if isParticipantMediaCredentialRejection(err) {
		return apiErrorInvalidRequest
	}
	return err
}
