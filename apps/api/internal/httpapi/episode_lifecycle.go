package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const idempotencyKeyHeader = "Idempotency-Key"

var (
	readEpisodesPermission  = authorization.TenantPermission{Scope: authentication.ScopeEpisodesRead, MinimumRole: memberships.RoleObserver}
	writeEpisodesPermission = authorization.TenantPermission{Scope: authentication.ScopeEpisodesWrite, MinimumRole: memberships.RoleCollaborator}
)

type EpisodeLifecycleService interface {
	CreateEpisode(context.Context, episodes.CreateEpisodeInput) (episodes.Episode, error)
	GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error)
	ListEpisodes(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (episodes.EpisodeList, error)
	AdmitParticipant(context.Context, episodes.AdmitParticipantInput) (episodes.Admission, error)
	RequestParticipantRemoval(context.Context, episodes.RequestParticipantRemovalInput) (episodes.Removal, error)
	RequestEpisodeEnd(context.Context, episodes.RequestEpisodeEndInput) (episodes.EndRequest, error)
	SetDeadline(context.Context, episodes.SetDeadlineInput) (episodes.ControlRequest, error)
}

type SyncTokenIssuer interface {
	Issue(context.Context, synctokens.Input) (synctokens.Token, error)
}

type SyncTokenRefreshIssuer interface {
	IssueForParticipant(context.Context, synctokens.SubjectKey) (synctokens.Token, error)
}

type MediaPlaneResolver interface {
	Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error)
}

type createEpisodeRequest struct {
	Metadata  utilities.OptionalJSON `json:"metadata"`
	StartedAt *time.Time             `json:"started_at,omitempty"`
}

type createEpisodeEndpointRequest struct {
	TenantID   utilities.ID
	SpaceID    utilities.ID
	RequestKey string
	Body       createEpisodeRequest
}

type admitParticipantRequest struct {
	ParticipantID string                 `json:"participant_id,omitempty"`
	Name          string                 `json:"name"`
	Metadata      utilities.OptionalJSON `json:"metadata"`
	Role          string                 `json:"role"`
	IdentityID    string                 `json:"identity_id,omitempty"`
}

type admitParticipantEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	RequestKey    string
	ParticipantID utilities.ID
	IdentityID    utilities.ID
	Body          admitParticipantRequest
}

type removeParticipantRequest struct {
	ParticipantGeneration int64 `json:"participant_generation"`
}

type removeParticipantEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	RequestKey    string
	ParticipantID utilities.ID
	Body          removeParticipantRequest
}

type endEpisodeEndpointRequest struct {
	TenantID   utilities.ID
	SpaceID    utilities.ID
	EpisodeID  utilities.ID
	RequestKey string
}

type setDeadlineRequest struct {
	DeadlineAt time.Time `json:"deadline_at"`
}

type setDeadlineEndpointRequest struct {
	TenantID   utilities.ID
	SpaceID    utilities.ID
	EpisodeID  utilities.ID
	RequestKey string
	Body       setDeadlineRequest
}

type issueSyncTokenEndpointRequest struct {
	TenantID      utilities.ID
	SpaceID       utilities.ID
	EpisodeID     utilities.ID
	ParticipantID utilities.ID
}

type episodeResponse struct {
	ID                 string  `json:"id"`
	TenantID           string  `json:"tenant_id"`
	SpaceID            string  `json:"space_id"`
	Status             string  `json:"status"`
	Metadata           any     `json:"metadata"`
	ConfigSnapshot     any     `json:"config_snapshot"`
	EndReason          *string `json:"end_reason,omitempty"`
	StartedAt          string  `json:"started_at"`
	EndedAt            string  `json:"ended_at,omitempty"`
	DeadlineAt         string  `json:"deadline_at"`
	DeadlineGeneration int64   `json:"deadline_generation"`
	UpdatedAt          string  `json:"updated_at"`
	CreatedAt          string  `json:"created_at"`
}

type episodeListResponse struct {
	Episodes   []episodeResponse  `json:"episodes"`
	Pagination paginationResponse `json:"pagination"`
}

type syncTokenResponse struct {
	SyncToken string `json:"sync_token"`
	ExpiresAt string `json:"expires_at"`
}

type lifecycleIntentResponse struct {
	ID                    string  `json:"id"`
	RequestKey            string  `json:"request_key"`
	IntentName            string  `json:"intent_name"`
	ParticipantID         *string `json:"participant_id,omitempty"`
	ParticipantGeneration *int64  `json:"participant_generation,omitempty"`
	Status                string  `json:"status"`
	CreatedAt             string  `json:"created_at"`
}

type participantResponse struct {
	ID           string   `json:"id"`
	TenantID     string   `json:"tenant_id"`
	SpaceID      string   `json:"space_id"`
	EpisodeID    string   `json:"episode_id"`
	IdentityID   *string  `json:"identity_id,omitempty"`
	Role         string   `json:"role"`
	Capabilities []string `json:"capabilities"`
	Generation   int64    `json:"generation"`
	Status       string   `json:"status"`
}

type participantLifecycleResponse struct {
	Participant      participantResponse       `json:"participant"`
	Intent           lifecycleIntentResponse   `json:"lifecycle_intent"`
	AdmissionRequest *admissionRequestResponse `json:"admission_request,omitempty"`
	Access           *accessGrantResponse      `json:"access,omitempty"`
	SyncToken        string                    `json:"sync_token,omitempty"`
	ExpiresAt        string                    `json:"expires_at,omitempty"`
	MediaPlane       *mediaPlaneResponse       `json:"media_plane,omitempty"`
}

type admissionRequestResponse struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	ExpiresAt string `json:"expires_at"`
}

type mediaPlaneResponse struct {
	Provider      string         `json:"provider"`
	ClientPayload map[string]any `json:"client_payload"`
}

type participantRemovalResponse struct {
	Participant participantResponse       `json:"participant"`
	Operation   externalOperationResponse `json:"external_operation"`
}

type episodeControlResponse struct {
	EpisodeID string                    `json:"episode_id"`
	Status    string                    `json:"status"`
	Operation externalOperationResponse `json:"external_operation"`
}

type externalOperationResponse struct {
	ID                          string  `json:"id"`
	RequestKey                  string  `json:"request_key"`
	OperationName               string  `json:"operation_name"`
	TargetParticipantID         *string `json:"target_participant_id,omitempty"`
	TargetParticipantGeneration *int64  `json:"target_participant_generation,omitempty"`
	DeadlineGeneration          *int64  `json:"deadline_generation,omitempty"`
	Status                      string  `json:"status"`
	CreatedAt                   string  `json:"created_at"`
}

func mountEpisodeLifecycleRoutes(r chi.Router, spacesService SpaceService, tenantsService TenantService, lifecycle EpisodeLifecycleService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, mediaTokens ParticipantMediaIssuer, diagnosticsTokens ParticipantDiagnosticsIssuer, mediaVerifier ParticipantMediaVerifier, active ActiveParticipantAuthorizer, generations ParticipantGenerationAuthorizer, media MediaPlaneResolver, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range episodeLifecycleEndpoints(spacesService, tenantsService, lifecycle, tokens, refresh, mediaTokens, diagnosticsTokens, mediaVerifier, active, generations, media, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func episodeLifecycleEndpoints(spacesService SpaceService, tenantsService TenantService, lifecycle EpisodeLifecycleService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, mediaTokens ParticipantMediaIssuer, diagnosticsTokens ParticipantDiagnosticsIssuer, mediaVerifier ParticipantMediaVerifier, active ActiveParticipantAuthorizer, generations ParticipantGenerationAuthorizer, media MediaPlaneResolver, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createEpisodeEndpoint(lifecycle, authorizer),
		listEpisodesEndpoint(lifecycle, authorizer),
		getEpisodeEndpoint(lifecycle, authorizer),
		admitParticipantEndpoint(lifecycle, tokens, refresh, mediaTokens, diagnosticsTokens, spacesService, tenantsService, media, authorizer),
		issueSyncTokenEndpoint(refresh, authorizer),
		issueAccessGrantEndpoint(refresh, mediaTokens, diagnosticsTokens, mediaVerifier, active, generations, spacesService, tenantsService, media, authorizer),
		removeParticipantEndpoint(lifecycle, authorizer),
		setDeadlineEndpoint(lifecycle, authorizer),
		endEpisodeEndpoint(lifecycle, authorizer),
	}
}

func createEpisodeEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[createEpisodeEndpointRequest, episodeResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes", "/tenants/{tenant_id}/spaces/{space_id}/episodes", "createEpisode", decodeCreateEpisodeRequest, func(ctx context.Context, request createEpisodeEndpointRequest) (episodeResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
			return episodeResponse{}, err
		}
		if service == nil {
			return episodeResponse{}, apiErrorServiceUnavailable
		}
		created, err := service.CreateEpisode(ctx, episodes.CreateEpisodeInput{TenantID: request.TenantID, SpaceID: request.SpaceID, Metadata: request.Body.Metadata.Value, CreatedByUserID: createdByUserID(ctx), StartedAt: request.Body.StartedAt, Request: episodes.Request{Key: request.RequestKey}})
		if err != nil {
			return episodeResponse{}, err
		}
		return newEpisodeResponse(created), nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), idempotencyKeyParameter()).
		RequestBody("CreateEpisodeRequest", createEpisodeRequest{}).Responds(http.StatusCreated, "Episode", episodeResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidRequestKey, apiErrorSpaceNotFound, apiErrorEpisodeNotFound, apiErrorIdempotencyConflict, apiErrorRateLimited)...).MapErrors(episodeLifecycleEndpointAPIError)
}

func listEpisodesEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[listEpisodesRequest, episodeListResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes", "/tenants/{tenant_id}/spaces/{space_id}/episodes", "listEpisodes", decodeListEpisodesRequest, func(ctx context.Context, request listEpisodesRequest) (episodeListResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readEpisodesPermission); err != nil {
			return episodeListResponse{}, err
		}
		if service == nil {
			return episodeListResponse{}, apiErrorServiceUnavailable
		}
		list, err := service.ListEpisodes(ctx, request.TenantID, request.SpaceID, request.Page)
		if err != nil {
			return episodeListResponse{}, err
		}
		page, err := newPaginationResponse(list.Page)
		if err != nil {
			return episodeListResponse{}, err
		}
		result := episodeListResponse{Episodes: make([]episodeResponse, 0, len(list.Episodes)), Pagination: page}
		for _, episode := range list.Episodes {
			result.Episodes = append(result.Episodes, newEpisodeResponse(episode))
		}
		return result, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(append([]APIParameterContract{tenantIDParameter(), spaceIDParameter()}, paginationParameters()...)...).Responds(http.StatusOK, "EpisodeList", episodeListResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidSpaceID, apiErrorInvalidPageSize, apiErrorInvalidCursor, apiErrorSpaceNotFound, apiErrorEpisodeNotFound)...).MapErrors(episodeLifecycleEndpointAPIError)
}

func getEpisodeEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[getEpisodeRequest, episodeResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}", "/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}", "getEpisode", decodeGetEpisodeRequest, func(ctx context.Context, request getEpisodeRequest) (episodeResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readEpisodesPermission); err != nil {
			return episodeResponse{}, err
		}
		if service == nil {
			return episodeResponse{}, apiErrorServiceUnavailable
		}
		episode, err := service.GetEpisode(ctx, request.TenantID, request.SpaceID, request.EpisodeID)
		if err != nil {
			return episodeResponse{}, err
		}
		return newEpisodeResponse(episode), nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter()).Responds(http.StatusOK, "Episode", episodeResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorSpaceNotFound, apiErrorEpisodeNotFound)...).MapErrors(episodeLifecycleEndpointAPIError)
}

func issueSyncTokenEndpoint(service SyncTokenRefreshIssuer, authorizer TenantAuthorizer) Endpoint[issueSyncTokenEndpointRequest, syncTokenResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/sync-token", "/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/sync-token", "issueEpisodeParticipantSyncToken", decodeIssueSyncTokenRequest, func(ctx context.Context, request issueSyncTokenEndpointRequest) (syncTokenResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
			return syncTokenResponse{}, err
		}
		if service == nil {
			return syncTokenResponse{}, apiErrorServiceUnavailable
		}
		token, err := service.IssueForParticipant(ctx, synctokens.SubjectKey{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID})
		if err != nil {
			return syncTokenResponse{}, err
		}
		return syncTokenResponse{SyncToken: token.Value, ExpiresAt: token.ExpiresAt.UTC().Format(time.RFC3339)}, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), participantIDParameter()).Responds(http.StatusCreated, "SyncToken", syncTokenResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorParticipantNotFound, apiErrorRateLimited)...).MapErrors(episodeLifecycleEndpointAPIError)
}

func admitParticipantEndpoint(service EpisodeLifecycleService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, mediaTokens ParticipantMediaIssuer, diagnosticsTokens ParticipantDiagnosticsIssuer, spacesService SpaceService, tenantsService TenantService, media MediaPlaneResolver, authorizer TenantAuthorizer) Endpoint[admitParticipantEndpointRequest, participantLifecycleResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants", "/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants", "admitEpisodeParticipant", decodeAdmitParticipantRequest, func(ctx context.Context, request admitParticipantEndpointRequest) (participantLifecycleResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
			return participantLifecycleResponse{}, err
		}
		if service == nil {
			return participantLifecycleResponse{}, apiErrorServiceUnavailable
		}
		admission, err := service.AdmitParticipant(ctx, episodes.AdmitParticipantInput{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID, Name: request.Body.Name, Metadata: request.Body.Metadata.Value, Role: request.Body.Role, IdentityID: request.IdentityID, Request: episodes.Request{Key: request.RequestKey}})
		if err != nil {
			return participantLifecycleResponse{}, err
		}
		response := newParticipantLifecycleResponse(admission.Participant, admission.Intent)
		if admission.AdmissionRequest != nil {
			response.AdmissionRequest = &admissionRequestResponse{ID: admission.AdmissionRequest.ID.String(), Status: admission.AdmissionRequest.Status, ExpiresAt: admission.AdmissionRequest.ExpiresAt.UTC().Format(time.RFC3339)}
			return response, nil
		}
		var syncCredential synctokens.Token
		if tokens != nil {
			token, err := tokens.Issue(ctx, synctokens.Input{TenantID: admission.Participant.TenantID, SpaceID: admission.Participant.SpaceID, EpisodeID: admission.Participant.EpisodeID, ParticipantID: admission.Participant.ID, ParticipantGeneration: admission.Participant.Generation, AdmissionLifecycleIntentID: admission.Intent.ID, DisplayName: request.Body.Name, Role: admission.Participant.Role, Capabilities: append([]string(nil), admission.Participant.Capabilities...)})
			if err != nil {
				return participantLifecycleResponse{}, err
			}
			syncCredential = token
			response.SyncToken, response.ExpiresAt = token.Value, token.ExpiresAt.UTC().Format(time.RFC3339)
		} else if refresh != nil {
			token, err := refresh.IssueForParticipant(ctx, synctokens.SubjectKey{TenantID: admission.Participant.TenantID, SpaceID: admission.Participant.SpaceID, EpisodeID: admission.Participant.EpisodeID, ParticipantID: admission.Participant.ID})
			if err != nil {
				return participantLifecycleResponse{}, err
			}
			syncCredential = token
			response.SyncToken, response.ExpiresAt = token.Value, token.ExpiresAt.UTC().Format(time.RFC3339)
		}
		join, err := createParticipantJoin(ctx, spacesService, tenantsService, media, admission.Participant)
		if err != nil {
			return participantLifecycleResponse{}, err
		}
		if join.Provider != "" {
			response.MediaPlane = &mediaPlaneResponse{Provider: string(join.Provider), ClientPayload: join.ClientPayload}
		}
		if mediaTokens != nil && syncCredential.Value != "" && join.Provider == mediaplane.ProviderCloudflareSFU {
			accessRequest := issueAccessGrantRequest{TenantID: admission.Participant.TenantID, SpaceID: admission.Participant.SpaceID, EpisodeID: admission.Participant.EpisodeID, ParticipantID: admission.Participant.ID, Body: issueAccessGrantBody{ParticipantGeneration: admission.Participant.Generation}}
			subject, err := accessGrantSubjectForJoin(accessRequest, join)
			if err != nil {
				return participantLifecycleResponse{}, err
			}
			mediaCredential, err := mediaTokens.Issue(ctx, subject)
			if err != nil {
				return participantLifecycleResponse{}, err
			}
			response.Access = func() *accessGrantResponse {
				grant := newAccessGrantResponse(subject, syncCredential, mediaCredential, join)
				attachDiagnosticsCredential(ctx, &grant, diagnosticsTokens, subject)
				return &grant
			}()
		}
		return response, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), idempotencyKeyParameter()).RequestBody("AdmitEpisodeParticipantRequest", admitParticipantRequest{}).
		Responds(http.StatusCreated, "ParticipantLifecycle", participantLifecycleResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorInvalidRequestKey, apiErrorSpaceNotFound, apiErrorEpisodeNotFound, apiErrorEpisodeNotActive, apiErrorIdempotencyConflict, apiErrorEpisodeCapacityExceeded, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).MapErrors(episodeLifecycleEndpointAPIError)
}

func createParticipantJoin(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, participant episodes.Participant) (mediaplane.Join, error) {
	service, episode, err := resolveMediaEpisode(ctx, spacesService, tenantsService, resolver, participant.TenantID, participant.SpaceID, participant.EpisodeID)
	if err != nil || service == nil {
		return mediaplane.Join{}, err
	}
	return service.CreateJoin(ctx, mediaplane.CreateJoinInput{Provider: service.Provider(), Episode: episode, ParticipantName: participant.ID.String(), ExternalParticipantID: participant.ID.String(), ParticipantPreset: "contributor"})
}

func removeParticipantEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[removeParticipantEndpointRequest, participantRemovalResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/remove", "/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/remove", "removeEpisodeParticipant", decodeRemoveParticipantRequest, func(ctx context.Context, request removeParticipantEndpointRequest) (participantRemovalResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
			return participantRemovalResponse{}, err
		}
		if service == nil {
			return participantRemovalResponse{}, apiErrorServiceUnavailable
		}
		removal, err := service.RequestParticipantRemoval(ctx, episodes.RequestParticipantRemovalInput{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID, ParticipantGeneration: request.Body.ParticipantGeneration, Request: episodes.Request{Key: request.RequestKey}})
		if err != nil {
			return participantRemovalResponse{}, err
		}
		return participantRemovalResponse{Participant: newParticipantResponse(removal.Participant), Operation: newExternalOperationResponseFromIntent(removal.Intent)}, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), participantIDParameter(), idempotencyKeyParameter()).RequestBody("RemoveEpisodeParticipantRequest", removeParticipantRequest{}).
		Responds(http.StatusAccepted, "ParticipantRemoval", participantRemovalResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorInvalidRequestKey, apiErrorEpisodeNotFound, apiErrorEpisodeNotActive, apiErrorParticipantNotFound, apiErrorParticipantNotActive, apiErrorParticipantGenerationMismatch, apiErrorIdempotencyConflict, apiErrorRateLimited)...).MapErrors(episodeLifecycleEndpointAPIError)
}

func endEpisodeEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[endEpisodeEndpointRequest, episodeControlResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/end", "/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/end", "endEpisode", decodeEndEpisodeRequest, func(ctx context.Context, request endEpisodeEndpointRequest) (episodeControlResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
			return episodeControlResponse{}, err
		}
		if service == nil {
			return episodeControlResponse{}, apiErrorServiceUnavailable
		}
		end, err := service.RequestEpisodeEnd(ctx, episodes.RequestEpisodeEndInput{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, Request: episodes.Request{Key: request.RequestKey}})
		if err != nil {
			return episodeControlResponse{}, err
		}
		return episodeControlResponse{EpisodeID: end.Episode.ID.String(), Status: end.Episode.Status, Operation: newExternalOperationResponseFromIntent(end.Intent)}, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), idempotencyKeyParameter()).Responds(http.StatusAccepted, "EpisodeEnd", episodeControlResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidRequestKey, apiErrorEpisodeNotFound, apiErrorEpisodeNotActive, apiErrorIdempotencyConflict, apiErrorEpisodeCapacityExceeded, apiErrorRateLimited)...).MapErrors(episodeLifecycleEndpointAPIError)
}

func setDeadlineEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[setDeadlineEndpointRequest, episodeControlResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/deadline", "/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/deadline", "setEpisodeDeadline", decodeSetDeadlineRequest, func(ctx context.Context, request setDeadlineEndpointRequest) (episodeControlResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
			return episodeControlResponse{}, err
		}
		if service == nil {
			return episodeControlResponse{}, apiErrorServiceUnavailable
		}
		control, err := service.SetDeadline(ctx, episodes.SetDeadlineInput{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, Deadline: request.Body.DeadlineAt, Request: episodes.Request{Key: request.RequestKey}})
		if err != nil {
			return episodeControlResponse{}, err
		}
		return episodeControlResponse{EpisodeID: control.Episode.ID.String(), Status: control.Episode.Status, Operation: newExternalOperationResponse(control.Operation)}, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), idempotencyKeyParameter()).RequestBody("SetEpisodeDeadlineRequest", setDeadlineRequest{}).Responds(http.StatusAccepted, "EpisodeDeadline", episodeControlResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidRequestKey, apiErrorEpisodeNotFound, apiErrorEpisodeNotActive, apiErrorIdempotencyConflict, apiErrorRateLimited)...).MapErrors(episodeLifecycleEndpointAPIError)
}

func resolveMediaPlane(ctx context.Context, resolver MediaPlaneResolver, spacesService SpaceService, tenantsService TenantService, tenantID, spaceID utilities.ID) (*mediaplane.Service, error) {
	if resolver == nil {
		return nil, nil
	}
	if spacesService == nil || tenantsService == nil {
		return nil, mediaplane.ErrPlaneUnavailable
	}
	space, err := spacesService.GetSpace(ctx, tenantID, spaceID)
	if err != nil {
		return nil, fmt.Errorf("%w: space lookup failed", mediaplane.ErrPlaneUnavailable)
	}
	tenant, err := tenantsService.GetTenant(ctx, tenantID)
	if err != nil {
		return nil, fmt.Errorf("%w: tenant lookup failed", mediaplane.ErrPlaneUnavailable)
	}
	return resolver.Resolve(ctx, tenant, space)
}

func resolveMediaEpisode(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, tenantID, spaceID, episodeID utilities.ID) (*mediaplane.Service, mediaplane.Episode, error) {
	service, err := resolveMediaPlane(ctx, resolver, spacesService, tenantsService, tenantID, spaceID)
	if err != nil || service == nil {
		return service, mediaplane.Episode{}, err
	}
	episode, err := service.EnsureEpisode(ctx, mediaplane.EnsureEpisodeInput{Provider: service.Provider(), EpisodeKey: episodeID.String(), Metadata: map[string]string{"tenant_id": tenantID.String(), "space_id": spaceID.String()}})
	return service, episode, err
}

func newEpisodeResponse(episode episodes.Episode) episodeResponse {
	return episodeResponse{ID: episode.ID.String(), TenantID: episode.TenantID.String(), SpaceID: episode.SpaceID.String(), Status: episode.Status, Metadata: rawJSONValue(episode.Metadata), ConfigSnapshot: rawJSONValue(episode.ConfigSnapshot), EndReason: episode.EndReason, StartedAt: episodeTimestampString(episode.StartedAt), EndedAt: episodeTimestampString(episode.EndedAt), DeadlineAt: episodeTimestampString(episode.DeadlineAt), DeadlineGeneration: episode.DeadlineGeneration, UpdatedAt: episodeTimestampString(episode.UpdatedAt), CreatedAt: episodeTimestampString(episode.CreatedAt)}
}

func newParticipantResponse(participant episodes.Participant) participantResponse {
	return participantResponse{ID: participant.ID.String(), TenantID: participant.TenantID.String(), SpaceID: participant.SpaceID.String(), EpisodeID: participant.EpisodeID.String(), IdentityID: optionalIDString(participant.IdentityID), Role: participant.Role, Capabilities: append([]string(nil), participant.Capabilities...), Generation: participant.Generation, Status: participant.Status}
}

func newParticipantLifecycleResponse(participant episodes.Participant, intent episodes.Intent) participantLifecycleResponse {
	return participantLifecycleResponse{Participant: newParticipantResponse(participant), Intent: newLifecycleIntentResponse(intent)}
}

func newLifecycleIntentResponse(intent episodes.Intent) lifecycleIntentResponse {
	response := lifecycleIntentResponse{ID: intent.ID.String(), RequestKey: intent.RequestKey, IntentName: intent.IntentName, Status: intent.Status, CreatedAt: episodeTimestampString(intent.CreatedAt)}
	if !intent.ParticipantID.IsZero() {
		id := intent.ParticipantID.String()
		response.ParticipantID = &id
		generation := intent.ParticipantGeneration
		response.ParticipantGeneration = &generation
	}
	return response
}

func newExternalOperationResponse(operation episodes.ExternalOperation) externalOperationResponse {
	response := externalOperationResponse{ID: operation.ID.String(), RequestKey: operation.RequestKey, OperationName: operation.OperationName, Status: operation.Status, CreatedAt: episodeTimestampString(operation.CreatedAt)}
	if !operation.TargetParticipantID.IsZero() {
		id := operation.TargetParticipantID.String()
		response.TargetParticipantID = &id
		generation := operation.TargetGeneration
		response.TargetParticipantGeneration = &generation
	}
	if operation.DeadlineGeneration > 0 {
		generation := operation.DeadlineGeneration
		response.DeadlineGeneration = &generation
	}
	return response
}

func newExternalOperationResponseFromIntent(intent episodes.Intent) externalOperationResponse {
	return newExternalOperationResponse(episodes.ExternalOperation{ID: intent.ID, RequestKey: intent.RequestKey, OperationName: intent.IntentName, TargetParticipantID: intent.ParticipantID, TargetGeneration: intent.ParticipantGeneration, Status: intent.Status, CreatedAt: intent.CreatedAt})
}

func lifecycleWriteErrors(extra ...APIError) []APIError {
	return append([]APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInternal}, extra...)
}

func lifecycleReadErrors(extra ...APIError) []APIError {
	return append([]APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInternal}, extra...)
}

func episodeLifecycleEndpointAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, mediapublications.ErrInvalidPublication), errors.Is(err, mediaplane.ErrInvalidSignalRequest):
		return apiErrorInvalidRequest, true
	case errors.Is(err, mediapublications.ErrUnavailable), errors.Is(err, mediaplaneproviders.ErrUnknownProvider), errors.Is(err, mediaplaneproviders.ErrInvalidMode), errors.Is(err, mediaplaneproviders.ErrMissingProviderConfig), errors.Is(err, mediaplaneproviders.ErrInvalidProviderConfig), errors.Is(err, mediaplaneproviders.ErrAdapterUnavailable), errors.Is(err, mediaplane.ErrPlaneUnavailable), errors.Is(err, mediaplane.ErrProviderFailed):
		return apiErrorMediaPlaneUnavailable, true
	case errors.Is(err, episodes.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, episodes.ErrInvalidSpaceID):
		return apiErrorInvalidSpaceID, true
	case errors.Is(err, episodes.ErrInvalidEpisodeID):
		return apiErrorInvalidEpisodeID, true
	case errors.Is(err, episodes.ErrInvalidParticipantID):
		return apiErrorInvalidParticipantID, true
	case errors.Is(err, episodes.ErrSpaceNotFound):
		return apiErrorSpaceNotFound, true
	case errors.Is(err, episodes.ErrEpisodeNotFound):
		return apiErrorEpisodeNotFound, true
	case errors.Is(err, episodes.ErrEpisodeNotActive):
		return apiErrorEpisodeNotActive, true
	case errors.Is(err, episodes.ErrParticipantNotFound), errors.Is(err, synctokens.ErrSubjectNotFound):
		return apiErrorParticipantNotFound, true
	case errors.Is(err, episodes.ErrParticipantNotActive):
		return apiErrorParticipantNotActive, true
	case errors.Is(err, episodes.ErrParticipantGenerationMismatch):
		return apiErrorParticipantGenerationMismatch, true
	case errors.Is(err, episodes.ErrInvalidRequestKey):
		return apiErrorInvalidRequestKey, true
	case errors.Is(err, episodes.ErrIdempotencyConflict):
		return apiErrorIdempotencyConflict, true
	case errors.Is(err, episodes.ErrCapacityExceeded):
		return apiErrorEpisodeCapacityExceeded, true
	case errors.Is(err, episodes.ErrAdmissionClosed), errors.Is(err, episodes.ErrInvalidAdmissionPolicy), errors.Is(err, episodes.ErrInvalidRole), errors.Is(err, episodes.ErrInvalidRoleCapabilities), errors.Is(err, episodes.ErrInvalidConfigSnapshot), errors.Is(err, episodes.ErrInvalidParticipantName), errors.Is(err, episodes.ErrInvalidParticipantGeneration), errors.Is(err, episodes.ErrInvalidIntentPayload), errors.Is(err, episodes.ErrInvalidInitialControlState), errors.Is(err, episodes.ErrInvalidMaximumDuration), errors.Is(err, episodes.ErrInvalidMaximumDurationCeiling), errors.Is(err, episodes.ErrInvalidDeadline), errors.Is(err, episodes.ErrDeadlineExceedsCeiling), errors.Is(err, episodes.ErrDeadlineChangePending), errors.Is(err, episodes.ErrEpisodeControlBusy):
		return apiErrorInvalidRequest, true
	default:
		return authorizationAPIError(err), true
	}
}

func episodeTimestampString(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return utilities.FormatTimestamp(value)
}
