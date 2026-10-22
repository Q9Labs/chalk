package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ParticipantMediaIssuer interface {
	Issue(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error)
}

type ParticipantGenerationAuthorizer interface {
	AuthorizeActiveParticipantGeneration(context.Context, synctokens.SubjectKey, int64) (bool, error)
	BindParticipantMediaConnection(context.Context, accessgrants.Subject) error
	CheckParticipantMediaConnection(context.Context, accessgrants.Subject) error
	ReplaceParticipantMediaConnection(context.Context, accessgrants.Subject, accessgrants.Subject) error
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

type accessGrantResponse struct {
	EpisodeStartedAt *string                    `json:"episode_started_at,omitempty"`
	Subject          accessGrantSubjectResponse `json:"subject"`
	Sync             accessGrantTokenResponse   `json:"sync"`
	Media            accessGrantMediaResponse   `json:"media"`
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
		func(ctx context.Context, request issueAccessGrantRequest) (_ accessGrantResponse, failure error) {
			stage := "tenant_authorization"
			defer func() {
				if failure != nil {
					apiErr := accessGrantAPIError(failure)
					observability.LogAccessGrantFailure(ctx, stage, apiErr.Code)
				}
			}()
			if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
				return accessGrantResponse{}, err
			}
			stage = "request"
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
			replaceMediaConnection := request.Body.ReplaceMediaConnection
			if !replaceMediaConnection {
				stage = "media_token"
				currentToken := strings.TrimSpace(request.Body.CurrentMediaToken)
				if currentToken == "" {
					return accessGrantResponse{}, apiErrorMediaTokenRequired
				}
				subject, err = mediaVerifier.Verify(observability.ContextWithAccessGrantRefresh(ctx), currentToken)
				if err != nil && !errors.Is(err, accessgrants.ErrExpired) {
					return accessGrantResponse{}, accessGrantRefreshError(err)
				}
				replaceMediaConnection = errors.Is(err, accessgrants.ErrExpired)
				if routeErr := accessgrants.RequireRouteSubject(subject, accessgrants.RouteSubject{
					TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID,
					ParticipantID: request.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration,
					Provider: subject.Provider, ProviderSubject: subject.ProviderSubject,
					CloudflareConnectionID: subject.CloudflareConnectionID,
				}); routeErr != nil {
					return accessGrantResponse{}, accessGrantRefreshError(routeErr)
				}
				if subject.ParticipantGeneration != request.Body.ParticipantGeneration {
					return accessGrantResponse{}, apiErrorParticipantGenerationMismatch
				}
			}
			stage = "participant_authorization"
			var isActive bool
			if replaceMediaConnection {
				isActive, err = generations.AuthorizeActiveParticipantGeneration(ctx, key, request.Body.ParticipantGeneration)
			} else {
				isActive, err = active.AuthorizeActiveParticipant(ctx, subject)
			}
			if err != nil {
				return accessGrantResponse{}, accessGrantRefreshError(err)
			}
			if !isActive {
				return accessGrantResponse{}, apiErrorForbidden
			}
			previous := subject
			implicitReplacement := replaceMediaConnection && !request.Body.ReplaceMediaConnection
			if implicitReplacement {
				if err := generations.CheckParticipantMediaConnection(ctx, previous); err != nil {
					return accessGrantResponse{}, accessGrantRefreshError(err)
				}
			}
			stage = "media_connection"
			if replaceMediaConnection {
				join, err = createAccessGrantJoin(ctx, spacesService, tenantsService, mediaResolver, request)
				if err == nil {
					subject, err = accessGrantSubjectForJoin(request, join)
				}
			} else {
				join, err = resumeAccessGrantJoin(ctx, spacesService, tenantsService, mediaResolver, request, subject)
			}
			if err != nil {
				return accessGrantResponse{}, err
			}

			stage = "sync_credential"
			syncCredential, err := refresh.IssueForParticipant(ctx, key)
			if err != nil {
				return accessGrantResponse{}, err
			}
			stage = "media_credential"
			mediaCredential, err := mediaIssuer.Issue(ctx, subject)
			if err != nil {
				return accessGrantResponse{}, err
			}
			if replaceMediaConnection {
				stage = "media_binding"
				if implicitReplacement {
					err = generations.ReplaceParticipantMediaConnection(ctx, previous, subject)
				} else {
					err = generations.BindParticipantMediaConnection(ctx, subject)
				}
				if err != nil {
					return accessGrantResponse{}, accessGrantRefreshError(err)
				}
			}
			response := newAccessGrantResponse(subject, syncCredential, mediaCredential, join)

			return response, nil
		},
	).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(accessGrantParameters()...).
		RequestBody("IssueAccessGrantRequest", issueAccessGrantBody{}).
		Responds(http.StatusCreated, "AccessGrant", accessGrantResponse{}).
		Errors(accessGrantErrors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorParticipantNotFound, apiErrorParticipantGenerationMismatch, apiErrorMediaPlaneUnavailable, apiErrorRateLimited))...).
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
	connectionRef := subject.CloudflareConnectionID

	if strings.TrimSpace(connectionRef) == "" {
		return mediaplane.Join{}, mediaplane.ErrInvalidConnectionRef
	}
	return service.ResumeJoin(ctx, mediaplane.ResumeJoinInput{
		Provider: service.Provider(), Episode: episode, ExternalParticipantID: request.ParticipantID.String(), ConnectionRef: connectionRef,
	})
}

func accessGrantMediaEpisode(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, tenantID, spaceID, episodeID utilities.ID) (*mediaplane.Service, mediaplane.Episode, error) {
	service, err := resolveMediaPlane(ctx, resolver, spacesService, tenantsService, tenantID, spaceID)
	if err != nil {
		return nil, mediaplane.Episode{}, err
	}
	if service == nil || (service.Provider() != mediaplane.ProviderCloudflareSFU) {
		return nil, mediaplane.Episode{}, mediaplane.ErrPlaneUnavailable
	}
	episode, err := service.EnsureEpisode(ctx, mediaplane.EnsureEpisodeInput{Provider: service.Provider(), EpisodeKey: episodeID.String(), Metadata: map[string]string{"tenant_id": tenantID.String(), "space_id": spaceID.String()}})
	return service, episode, err
}

func accessGrantSubjectForJoin(request issueAccessGrantRequest, join mediaplane.Join) (accessgrants.Subject, error) {
	subject := accessgrants.Subject{
		TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID,
		ParticipantID: request.ParticipantID, ParticipantGeneration: request.Body.ParticipantGeneration,
	}
	switch join.Provider {
	case mediaplane.ProviderCloudflareSFU:
		connectionID, ok := join.ClientPayload["connectionId"].(string)
		if !ok || strings.TrimSpace(connectionID) == "" {
			return accessgrants.Subject{}, mediaplane.ErrProviderFailed
		}
		subject.Provider = accessgrants.ProviderCloudflareSFU
		subject.CloudflareConnectionID = strings.TrimSpace(connectionID)

	default:
		return accessgrants.Subject{}, mediaplane.ErrInvalidProvider
	}
	return subject, nil
}

func newAccessGrantResponse(subject accessgrants.Subject, syncCredential synctokens.Token, mediaCredential accessgrants.MediaCredential, join mediaplane.Join) accessGrantResponse {
	return accessGrantResponse{
		EpisodeStartedAt: episodeStartedAt(syncCredential.StartedAt),
		Subject: accessGrantSubjectResponse{
			TenantID: subject.TenantID.String(), SpaceID: subject.SpaceID.String(), EpisodeID: subject.EpisodeID.String(),
			ParticipantID: subject.ParticipantID.String(), ParticipantGeneration: subject.ParticipantGeneration,
		},
		Sync:  accessGrantTokenResponse{Token: syncCredential.Value, ExpiresAt: syncCredential.ExpiresAt.UTC().Format(time.RFC3339)},
		Media: accessGrantMediaResponse{Token: mediaCredential.Token, ExpiresAt: mediaCredential.ExpiresAt.UTC().Format(time.RFC3339), Provider: subject.Provider, ClientPayload: join.ClientPayload},
	}
}

func episodeStartedAt(value *time.Time) *string {
	if value == nil || value.IsZero() {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
