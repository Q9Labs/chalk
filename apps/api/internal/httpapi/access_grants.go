package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ParticipantMediaIssuer interface {
	Issue(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error)
}

type ParticipantDiagnosticsIssuer interface {
	Issue(context.Context, accessgrants.DiagnosticsSubject) (accessgrants.DiagnosticsCredential, error)
}

type ParticipantGenerationAuthorizer interface {
	AuthorizeActiveParticipantGeneration(context.Context, synctokens.SubjectKey, int64) (bool, error)
}

type accessGrantSubjectResponse struct {
	TenantID              string `json:"tenant_id"`
	SpaceID               string `json:"space_id"`
	EpisodeID             string `json:"episode_id"`
	ParticipantID         string `json:"participant_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
}

type accessGrantTokenResponse struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}

type accessGrantMediaResponse struct {
	Token         string         `json:"token"`
	ExpiresAt     string         `json:"expires_at"`
	Provider      string         `json:"provider"`
	ClientPayload map[string]any `json:"client_payload"`
}

type accessGrantDiagnosticsResponse struct {
	Token      string `json:"token"`
	ExpiresAt  string `json:"expires_at"`
	Generation int64  `json:"generation"`
	IntakePath string `json:"intake_path"`
}

type accessGrantResponse struct {
	Subject     accessGrantSubjectResponse      `json:"subject"`
	Sync        accessGrantTokenResponse        `json:"sync"`
	Media       accessGrantMediaResponse        `json:"media"`
	Diagnostics *accessGrantDiagnosticsResponse `json:"diagnostics,omitempty"`
}

type issueAccessGrantBody struct {
	ParticipantGeneration  int64  `json:"participant_generation"`
	CurrentMediaToken      string `json:"current_media_token,omitempty"`
	ReplaceMediaConnection bool   `json:"replace_media_connection"`
}

type issueAccessGrantRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	Body          issueAccessGrantBody
}

func issueAccessGrantEndpoint(
	refresh SyncTokenRefreshIssuer,
	mediaIssuer ParticipantMediaIssuer,
	diagnosticsIssuer ParticipantDiagnosticsIssuer,
	mediaVerifier ParticipantMediaVerifier,
	active ActiveParticipantAuthorizer,
	generations ParticipantGenerationAuthorizer,
	spacesService SpaceService,
	tenantsService TenantService,
	mediaResolver MediaPlaneResolver,
	authorizer TenantAuthorizer,
) Endpoint[issueAccessGrantRequest, accessGrantResponse] {
	return Post(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/access-grant",
		"/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/access-grant",
		"issueAccessGrant",
		decodeIssueAccessGrantRequest,
		func(ctx context.Context, request issueAccessGrantRequest) (accessGrantResponse, error) {
			if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
				return accessGrantResponse{}, err
			}
			if refresh == nil || mediaIssuer == nil || mediaVerifier == nil || active == nil || generations == nil {
				return accessGrantResponse{}, apiErrorServiceUnavailable
			}
			if request.Body.ParticipantGeneration <= 0 {
				return accessGrantResponse{}, apiErrorInvalidRequest
			}

			key := synctokens.SubjectKey{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID}
			var (
				subject accessgrants.Subject
				join    mediaplane.Join
				err     error
			)
			if request.Body.ReplaceMediaConnection {
				isActive, authErr := generations.AuthorizeActiveParticipantGeneration(ctx, key, request.Body.ParticipantGeneration)
				if authErr != nil {
					return accessGrantResponse{}, authErr
				}
				if !isActive {
					return accessGrantResponse{}, apiErrorForbidden
				}
				join, err = createAccessGrantJoin(ctx, spacesService, tenantsService, mediaResolver, request)
				if err != nil {
					return accessGrantResponse{}, err
				}
				subject, err = accessGrantSubjectForJoin(request, join)
			} else {
				currentToken := strings.TrimSpace(request.Body.CurrentMediaToken)
				if currentToken == "" {
					return accessGrantResponse{}, apiErrorInvalidRequest
				}
				subject, err = mediaVerifier.Verify(ctx, currentToken)
				if err == nil {
					err = accessgrants.RequireRouteSubject(subject, accessgrants.RouteSubject{
						TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID,
						ParticipantID: request.ParticipantID, ParticipantGeneration: request.Body.ParticipantGeneration,
						Provider: subject.Provider, CloudflareConnectionID: subject.CloudflareConnectionID,
					})
				}
				if err != nil {
					return accessGrantResponse{}, accessGrantRefreshError(err)
				}
				isActive, authErr := active.AuthorizeActiveParticipant(ctx, subject)
				if authErr != nil {
					return accessGrantResponse{}, authErr
				}
				if !isActive {
					return accessGrantResponse{}, apiErrorForbidden
				}
				join, err = resumeAccessGrantJoin(ctx, spacesService, tenantsService, mediaResolver, request, subject)
			}
			if err != nil {
				return accessGrantResponse{}, err
			}

			syncCredential, err := refresh.IssueForParticipant(ctx, key)
			if err != nil {
				return accessGrantResponse{}, err
			}
			mediaCredential, err := mediaIssuer.Issue(ctx, subject)
			if err != nil {
				return accessGrantResponse{}, err
			}
			response := newAccessGrantResponse(subject, syncCredential, mediaCredential, join)
			attachDiagnosticsCredential(ctx, &response, diagnosticsIssuer, subject)
			return response, nil
		},
	).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(accessGrantParameters()...).
		RequestBody("IssueAccessGrantRequest", issueAccessGrantBody{}).
		Responds(http.StatusCreated, "AccessGrant", accessGrantResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorParticipantNotFound, apiErrorParticipantGenerationMismatch, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).
		MapErrors(episodeLifecycleEndpointAPIError)
}

func decodeIssueAccessGrantRequest(request *http.Request) (issueAccessGrantRequest, error) {
	tenantID, spaceID, episodeID, participantID, err := accessGrantIDsRequest(request)
	if err != nil {
		return issueAccessGrantRequest{}, err
	}
	body, err := decodeJSONBody[issueAccessGrantBody](request)
	return issueAccessGrantRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, Body: body}, err
}

func accessGrantIDsRequest(request *http.Request) (utilities.ID, utilities.ID, utilities.ID, utilities.ID, error) {
	tenantID, err := routeID(request, "tenant_id", apiErrorInvalidTenantID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, err
	}
	spaceID, err := routeID(request, "space_id", apiErrorInvalidSpaceID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, err
	}
	episodeID, err := routeID(request, "episode_id", apiErrorInvalidEpisodeID)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, utilities.ID{}, err
	}
	participantID, err := routeID(request, "participant_id", apiErrorInvalidParticipantID)
	return tenantID, spaceID, episodeID, participantID, err
}

func accessGrantParameters() []APIParameterContract {
	return []APIParameterContract{
		{Name: "tenant_id", In: "path", Type: "string", Required: true},
		{Name: "space_id", In: "path", Type: "string", Required: true},
		{Name: "episode_id", In: "path", Type: "string", Required: true},
		{Name: "participant_id", In: "path", Type: "string", Required: true},
	}
}

func createAccessGrantJoin(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, request issueAccessGrantRequest) (mediaplane.Join, error) {
	service, episode, err := accessGrantMediaEpisode(ctx, spacesService, tenantsService, resolver, request.TenantID, request.SpaceID, request.EpisodeID)
	if err != nil {
		return mediaplane.Join{}, err
	}
	return service.CreateJoin(ctx, mediaplane.CreateJoinInput{
		Provider: service.Provider(), Episode: episode,
		ParticipantName: request.ParticipantID.String(), ExternalParticipantID: request.ParticipantID.String(), ParticipantPreset: "contributor",
	})
}

func resumeAccessGrantJoin(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, request issueAccessGrantRequest, subject accessgrants.Subject) (mediaplane.Join, error) {
	service, episode, err := accessGrantMediaEpisode(ctx, spacesService, tenantsService, resolver, request.TenantID, request.SpaceID, request.EpisodeID)
	if err != nil {
		return mediaplane.Join{}, err
	}
	return service.ResumeJoin(ctx, mediaplane.ResumeJoinInput{
		Provider: service.Provider(), Episode: episode, ExternalParticipantID: request.ParticipantID.String(), ConnectionRef: subject.CloudflareConnectionID,
	})
}

func accessGrantMediaEpisode(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, tenantID, spaceID, episodeID utilities.ID) (*mediaplane.Service, mediaplane.Episode, error) {
	service, err := resolveMediaPlane(ctx, resolver, spacesService, tenantsService, tenantID, spaceID)
	if err != nil {
		return nil, mediaplane.Episode{}, err
	}
	if service == nil || service.Provider() != mediaplane.ProviderCloudflareSFU {
		return nil, mediaplane.Episode{}, mediaplane.ErrPlaneUnavailable
	}
	episode, err := service.EnsureEpisode(ctx, mediaplane.EnsureEpisodeInput{Provider: service.Provider(), EpisodeKey: episodeID.String(), Metadata: map[string]string{"tenant_id": tenantID.String(), "space_id": spaceID.String()}})
	return service, episode, err
}

func accessGrantSubjectForJoin(request issueAccessGrantRequest, join mediaplane.Join) (accessgrants.Subject, error) {
	connectionID, ok := join.ClientPayload["connectionId"].(string)
	connectionID = strings.TrimSpace(connectionID)
	if !ok || connectionID == "" || join.Provider != mediaplane.ProviderCloudflareSFU {
		return accessgrants.Subject{}, mediaplane.ErrProviderFailed
	}
	return accessgrants.Subject{
		TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID,
		ParticipantID: request.ParticipantID, ParticipantGeneration: request.Body.ParticipantGeneration,
		Provider: accessgrants.ProviderCloudflareSFU, CloudflareConnectionID: connectionID,
	}, nil
}

func newAccessGrantResponse(subject accessgrants.Subject, syncCredential synctokens.Token, mediaCredential accessgrants.MediaCredential, join mediaplane.Join) accessGrantResponse {
	return accessGrantResponse{
		Subject: accessGrantSubjectResponse{
			TenantID: subject.TenantID.String(), SpaceID: subject.SpaceID.String(), EpisodeID: subject.EpisodeID.String(),
			ParticipantID: subject.ParticipantID.String(), ParticipantGeneration: subject.ParticipantGeneration,
		},
		Sync:  accessGrantTokenResponse{Token: syncCredential.Value, ExpiresAt: syncCredential.ExpiresAt.UTC().Format(time.RFC3339)},
		Media: accessGrantMediaResponse{Token: mediaCredential.Token, ExpiresAt: mediaCredential.ExpiresAt.UTC().Format(time.RFC3339), Provider: subject.Provider, ClientPayload: join.ClientPayload},
	}
}

func attachDiagnosticsCredential(ctx context.Context, response *accessGrantResponse, issuer ParticipantDiagnosticsIssuer, subject accessgrants.Subject) {
	if response == nil || issuer == nil {
		return
	}
	credential, err := issuer.Issue(ctx, accessgrants.DiagnosticsSubject{
		TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID, ParticipantID: subject.ParticipantID,
		ParticipantGeneration: subject.ParticipantGeneration, Capability: accessgrants.DiagnosticsCapability,
	})
	if err != nil {
		return
	}
	response.Diagnostics = &accessGrantDiagnosticsResponse{
		Token: credential.Token, ExpiresAt: credential.ExpiresAt.UTC().Format(time.RFC3339),
		Generation: credential.Generation, IntakePath: credential.IntakePath,
	}
}

func accessGrantRefreshError(err error) error {
	if errors.Is(err, accessgrants.ErrSubjectMismatch) {
		return apiErrorForbidden
	}
	if isParticipantMediaCredentialRejection(err) {
		return apiErrorInvalidRequest
	}
	return err
}
