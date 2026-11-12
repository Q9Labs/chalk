package httpapi

import (
	"context"
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

type ParticipantGenerationAuthorizer interface {
	AuthorizeActiveParticipantGeneration(context.Context, synctokens.SubjectKey, int64) (bool, error)
	BindParticipantMediaConnection(context.Context, accessgrants.Subject) error
	CheckParticipantMediaConnection(context.Context, accessgrants.Subject) error
	ReplaceParticipantMediaConnection(context.Context, accessgrants.Subject, accessgrants.Subject) error
	ReserveParticipantMediaRefresh(context.Context, accessgrants.Subject, accessgrants.Subject, [32]byte) error
	LoadParticipantMediaRefresh(context.Context, accessgrants.Subject, [32]byte) (*accessgrants.StoredRefreshReplay, error)
	CompleteParticipantMediaRefresh(context.Context, accessgrants.Subject, accessgrants.Subject, accessgrants.RefreshReplay) error
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
	ParticipantGeneration     int64   `json:"participant_generation"`
	CurrentMediaToken         string  `json:"current_media_token,omitempty"`
	ReplaceMediaConnection    bool    `json:"replace_media_connection"`
	ExpectedMediaConnectionID *string `json:"expected_media_connection_id,omitempty"`
}

type issueAccessGrantRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
	MediaClients  mediaplane.ClientProviders
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
	issuer := accessGrantIssuer{refresh, mediaIssuer, mediaVerifier, active, generations, spacesService, tenantsService, mediaResolver, authorizer}
	return Post(
		"/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/access-grant",
		"issueAccessGrant",
		decodeIssueAccessGrantRequest,
		issuer.issue,
	).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(accessGrantParameters()...).
		RequestBody("IssueAccessGrantRequest", issueAccessGrantBody{}).
		Responds(http.StatusCreated, "AccessGrant", accessGrantResponse{}).
		Errors(accessGrantErrors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorParticipantNotFound, apiErrorParticipantGenerationMismatch, apiErrorMediaPlaneUnavailable, apiErrorMediaClientUnsupported, apiErrorRateLimited))...).
		ErrorRules(episodeLifecycleRules)
}

func decodeIssueAccessGrantRequest(request *http.Request) (issueAccessGrantRequest, error) {
	tenantID, spaceID, episodeID, participantID, err := accessGrantIDsRequest(request)
	if err != nil {
		return issueAccessGrantRequest{}, err
	}
	body, err := decodeJSONBody[issueAccessGrantBody](request)
	return issueAccessGrantRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, ParticipantID: participantID, MediaClients: mediaClients(request), Body: body}, err
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
		mediaProvidersParameter(),
	}
}

func createAccessGrantJoin(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, request issueAccessGrantRequest) (mediaplane.Join, error) {
	service, episode, err := accessGrantMediaEpisode(ctx, spacesService, tenantsService, resolver, request)
	if err != nil {
		return mediaplane.Join{}, err
	}
	return service.CreateJoin(ctx, mediaplane.CreateJoinInput{
		Provider: service.Provider(), Scope: accessGrantScope(request), Episode: episode,
		ParticipantName: request.ParticipantID.String(), ExternalParticipantID: request.ParticipantID.String(), ParticipantPreset: "contributor",
		AllowRelay: true,
	})
}

func resumeAccessGrantJoin(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, request issueAccessGrantRequest, subject accessgrants.Subject) (mediaplane.Join, error) {
	service, episode, err := accessGrantMediaEpisode(ctx, spacesService, tenantsService, resolver, request)
	if err != nil {
		return mediaplane.Join{}, err
	}
	connectionRef := subject.ConnectionID

	if strings.TrimSpace(connectionRef) == "" {
		return mediaplane.Join{}, mediaplane.ErrInvalidConnectionRef
	}
	return service.ResumeJoin(ctx, mediaplane.ResumeJoinInput{
		Provider: service.Provider(), Scope: accessGrantScope(request), Episode: episode, ExternalParticipantID: request.ParticipantID.String(), ConnectionRef: connectionRef,
		AllowRelay: true,
	})
}

func accessGrantMediaEpisode(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, request issueAccessGrantRequest) (*mediaplane.Service, mediaplane.Episode, error) {
	tenantID, spaceID, episodeID := request.TenantID, request.SpaceID, request.EpisodeID
	service, err := resolveMediaPlaneForClients(ctx, resolver, spacesService, tenantsService, tenantID, spaceID, episodeID, request.MediaClients)
	if err != nil {
		return nil, mediaplane.Episode{}, err
	}
	if service == nil || !grantProvider(service.Provider()) {
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
	if !grantProvider(join.Provider) {
		return accessgrants.Subject{}, mediaplane.ErrInvalidProvider
	}
	connectionID, ok := join.ClientPayload["connectionId"].(string)
	if !ok || strings.TrimSpace(connectionID) == "" {
		return accessgrants.Subject{}, mediaplane.ErrProviderFailed
	}
	subject.Provider = string(join.Provider)
	subject.ConnectionID = strings.TrimSpace(connectionID)
	return subject, nil
}

// grantProvider reports whether the provider's joins end in a media credential
// that names one connection. Both SFU providers do, and their names match the
// accessgrants vocabulary.
func grantProvider(provider mediaplane.Provider) bool {
	return provider == mediaplane.ProviderCloudflareSFU || provider == mediaplane.ProviderChalkSFU
}

func accessGrantScope(request issueAccessGrantRequest) mediaplane.Scope {
	return mediaplane.Scope{
		TenantID: request.TenantID.String(), EpisodeID: request.EpisodeID.String(),
		ParticipantID: request.ParticipantID.String(), Generation: request.Body.ParticipantGeneration,
	}
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
