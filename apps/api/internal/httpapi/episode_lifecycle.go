package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/mediapublications"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const idempotencyKeyHeader = "Idempotency-Key"

var (
	readEpisodesPermission  = authorization.TenantPermission{Scope: authentication.ScopeEpisodesRead, MinimumRole: memberships.RoleObserver}
	writeEpisodesPermission = authorization.TenantPermission{Scope: authentication.ScopeEpisodesWrite, MinimumRole: memberships.RoleCollaborator}
)

type EpisodeLifecycleService interface {
	GetEpisodeAttendance(context.Context, utilities.ID, utilities.ID, utilities.ID) ([]episodes.AttendanceParticipant, error)
	ListSpaceLiveEpisodes(context.Context, utilities.ID, []utilities.ID) ([]episodes.SpaceLiveEpisode, error)
	ListSpaceActivity(context.Context, utilities.ID, []utilities.ID) ([]episodes.SpaceActivity, error)
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

// MediaPlaneResolver finds the media plane an Episode is bound to. It reads the
// Episode's frozen binding, never the Space's current selection, so a change to
// the selector cannot move a live Episode to another provider.
type MediaPlaneResolver interface {
	ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error)
}

func episodeLifecycleEndpoints(spacesService SpaceService, tenantsService TenantService, lifecycle EpisodeLifecycleService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, mediaTokens ParticipantMediaIssuer, mediaVerifier ParticipantMediaVerifier, active ActiveParticipantAuthorizer, generations ParticipantGenerationAuthorizer, media MediaPlaneResolver, authorizer TenantAuthorizer) []RouteEndpoint {
	endpoints := []RouteEndpoint{
		createEpisodeEndpoint(lifecycle, authorizer),
		listEpisodesEndpoint(lifecycle, authorizer),
		getEpisodeEndpoint(lifecycle, authorizer),
		getEpisodeAttendanceEndpoint(lifecycle, authorizer),
		listSpaceLiveEpisodesEndpoint(lifecycle, authorizer),
		listSpaceActivityEndpoint(lifecycle, authorizer),
		admitParticipantEndpoint(lifecycle, tokens, refresh, mediaTokens, generations, spacesService, tenantsService, media, authorizer),
		issueSyncTokenEndpoint(refresh, authorizer),
		issueAccessGrantEndpoint(refresh, mediaTokens, mediaVerifier, active, generations, spacesService, tenantsService, media, authorizer),
		removeParticipantEndpoint(lifecycle, authorizer),
		setDeadlineEndpoint(lifecycle, authorizer),
		endEpisodeEndpoint(lifecycle, authorizer),
	}
	return endpoints
}

func createEpisodeEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[createEpisodeEndpointRequest, episodeResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes", "createEpisode", decodeCreateEpisodeRequest, func(ctx context.Context, request createEpisodeEndpointRequest) (episodeResponse, error) {
		created, err := service.CreateEpisode(ctx, episodes.CreateEpisodeInput{TenantID: request.TenantID, SpaceID: request.SpaceID, Metadata: request.Body.Metadata.Value, CreatedByUserID: createdByUserID(ctx), StartedAt: request.Body.StartedAt, MediaClients: request.MediaClients, Request: episodes.Request{Key: request.RequestKey}})
		if err != nil {
			return episodeResponse{}, err
		}
		return newEpisodeResponse(created), nil
	}).Permission(authorizer, writeEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), idempotencyKeyParameter(), mediaProvidersParameter()).
		RequestBody("CreateEpisodeRequest", createEpisodeRequest{}).Responds(http.StatusCreated, "Episode", episodeResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidRequestKey, apiErrorSpaceNotFound, apiErrorEpisodeNotFound, apiErrorIdempotencyConflict, apiErrorEpisodeCapacityExceeded, apiErrorTenantLiveEpisodeLimit, apiErrorMediaClientUnsupported, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).ErrorRules(episodeLifecycleRules)
}

func listEpisodesEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[listEpisodesRequest, episodeListResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes", "listEpisodes", decodeListEpisodesRequest, func(ctx context.Context, request listEpisodesRequest) (episodeListResponse, error) {
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
	}).Permission(authorizer, readEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(append([]APIParameterContract{tenantIDParameter(), spaceIDParameter()}, paginationParameters()...)...).Responds(http.StatusOK, "EpisodeList", episodeListResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidSpaceID, apiErrorInvalidPageSize, apiErrorInvalidCursor, apiErrorSpaceNotFound, apiErrorEpisodeNotFound)...).ErrorRules(episodeLifecycleRules)
}

func getEpisodeEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[getEpisodeRequest, episodeResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}", "getEpisode", decodeGetEpisodeRequest, func(ctx context.Context, request getEpisodeRequest) (episodeResponse, error) {
		episode, err := service.GetEpisode(ctx, request.TenantID, request.SpaceID, request.EpisodeID)
		if err != nil {
			return episodeResponse{}, err
		}
		return newEpisodeResponse(episode), nil
	}).Permission(authorizer, readEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter()).Responds(http.StatusOK, "Episode", episodeResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorSpaceNotFound, apiErrorEpisodeNotFound)...).ErrorRules(episodeLifecycleRules)
}

func issueSyncTokenEndpoint(service SyncTokenRefreshIssuer, authorizer TenantAuthorizer) Endpoint[issueSyncTokenEndpointRequest, syncTokenResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/sync-token", "issueEpisodeParticipantSyncToken", decodeIssueSyncTokenRequest, func(ctx context.Context, request issueSyncTokenEndpointRequest) (syncTokenResponse, error) {
		token, err := service.IssueForParticipant(ctx, synctokens.SubjectKey{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID})
		if err != nil {
			return syncTokenResponse{}, err
		}
		return syncTokenResponse{SyncToken: token.Value, ExpiresAt: token.ExpiresAt.UTC().Format(time.RFC3339)}, nil
	}).Permission(authorizer, writeEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), participantIDParameter()).Responds(http.StatusCreated, "SyncToken", syncTokenResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorParticipantNotFound, apiErrorRateLimited)...).ErrorRules(episodeLifecycleRules)
}

func admitParticipantEndpoint(service EpisodeLifecycleService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, mediaTokens ParticipantMediaIssuer, generations ParticipantGenerationAuthorizer, spacesService SpaceService, tenantsService TenantService, media MediaPlaneResolver, authorizer TenantAuthorizer) Endpoint[admitParticipantEndpointRequest, participantLifecycleResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants", "admitEpisodeParticipant", decodeAdmitParticipantRequest, func(ctx context.Context, request admitParticipantEndpointRequest) (participantLifecycleResponse, error) {
		// Refuse an SDK that cannot run the Episode's media before admission stores
		// the Participant and takes a join seat. Other resolution failures surface
		// from the join below, as before, so a waiting-room request needs no media.
		if _, err := resolveMediaPlaneForClients(ctx, media, spacesService, tenantsService, request.TenantID, request.SpaceID, request.EpisodeID, request.MediaClients); errors.Is(err, mediaplane.ErrClientUnsupported) {
			return participantLifecycleResponse{}, err
		}
		admission, err := service.AdmitParticipant(ctx, episodes.AdmitParticipantInput{Admission: request.Body.Admission, TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID, Name: request.Body.Name, Metadata: request.Body.Metadata.Value, Role: request.Body.Role, IdentityID: request.IdentityID, IdentityExternalID: request.Body.IdentityExternalID, Request: episodes.Request{Key: request.RequestKey}})
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
			token, err := tokens.Issue(ctx, synctokens.Input{TenantID: admission.Participant.TenantID, SpaceID: admission.Participant.SpaceID, EpisodeID: admission.Participant.EpisodeID, StartedAt: &admission.Episode.StartedAt, ParticipantID: admission.Participant.ID, ParticipantGeneration: admission.Participant.Generation, AdmissionLifecycleIntentID: admission.Intent.ID, DisplayName: request.Body.Name, Role: admission.Participant.Role, Capabilities: append([]string(nil), admission.Participant.Capabilities...)})
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
		join, err := createParticipantJoin(ctx, spacesService, tenantsService, media, admission.Participant, request.MediaClients)
		if err != nil {
			return participantLifecycleResponse{}, err
		}
		if join.Provider != "" {
			response.MediaPlane = &mediaPlaneResponse{Provider: string(join.Provider), ClientPayload: join.ClientPayload}
		}
		if grantProvider(join.Provider) {
			if generations == nil {
				return participantLifecycleResponse{}, apiErrorServiceUnavailable
			}
			accessRequest := issueAccessGrantRequest{TenantID: admission.Participant.TenantID, SpaceID: admission.Participant.SpaceID, EpisodeID: admission.Participant.EpisodeID, ParticipantID: admission.Participant.ID, Body: issueAccessGrantBody{ParticipantGeneration: admission.Participant.Generation}}
			subject, err := accessGrantSubjectForJoin(accessRequest, join)
			if err != nil {
				return participantLifecycleResponse{}, err
			}
			if mediaTokens != nil && syncCredential.Value != "" {
				mediaCredential, err := mediaTokens.Issue(observability.ContextWithAccessGrantClientProviders(ctx, request.MediaClients), subject)
				if err != nil {
					return participantLifecycleResponse{}, err
				}
				response.Access = func() *accessGrantResponse {
					grant := newAccessGrantResponse(subject, syncCredential, mediaCredential, join)

					return &grant
				}()
			}
			if err := generations.BindParticipantMediaConnection(ctx, subject); err != nil {
				return participantLifecycleResponse{}, err
			}
		}
		return response, nil
	}).Permission(authorizer, writeEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), idempotencyKeyParameter(), mediaProvidersParameter()).RequestBody("AdmitEpisodeParticipantRequest", admitParticipantRequest{}).
		Responds(http.StatusCreated, "ParticipantLifecycle", participantLifecycleResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorInvalidRequestKey, apiErrorSpaceNotFound, apiErrorEpisodeNotFound, apiErrorEpisodeNotActive, apiErrorParticipantNotActive, apiErrorIdempotencyConflict, apiErrorEpisodeCapacityExceeded, apiErrorMediaPlaneUnavailable, apiErrorMediaClientUnsupported, apiErrorRateLimited)...).ErrorRules(episodeLifecycleRules)
}

func createParticipantJoin(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, participant episodes.Participant, clients mediaplane.ClientProviders) (mediaplane.Join, error) {
	service, episode, err := resolveMediaEpisode(ctx, spacesService, tenantsService, resolver, participant.TenantID, participant.SpaceID, participant.EpisodeID, clients)
	if err != nil || service == nil {
		return mediaplane.Join{}, err
	}
	return service.CreateJoin(ctx, mediaplane.CreateJoinInput{Provider: service.Provider(), Scope: participantScope(participant), Episode: episode, ParticipantName: participant.ID.String(), ExternalParticipantID: participant.ID.String(), ParticipantPreset: "contributor", AllowRelay: true})
}

func participantScope(participant episodes.Participant) mediaplane.Scope {
	return mediaplane.Scope{
		TenantID: participant.TenantID.String(), EpisodeID: participant.EpisodeID.String(),
		ParticipantID: participant.ID.String(), Generation: participant.Generation,
	}
}

func removeParticipantEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[removeParticipantEndpointRequest, participantRemovalResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/remove", "removeEpisodeParticipant", decodeRemoveParticipantRequest, func(ctx context.Context, request removeParticipantEndpointRequest) (participantRemovalResponse, error) {
		removal, err := service.RequestParticipantRemoval(ctx, episodes.RequestParticipantRemovalInput{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, ParticipantID: request.ParticipantID, ParticipantGeneration: request.Body.ParticipantGeneration, Request: episodes.Request{Key: request.RequestKey}})
		if err != nil {
			return participantRemovalResponse{}, err
		}
		return participantRemovalResponse{Participant: newParticipantResponse(removal.Participant), Operation: newExternalOperationResponseFromIntent(removal.Intent)}, nil
	}).Permission(authorizer, writeEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), participantIDParameter(), idempotencyKeyParameter()).RequestBody("RemoveEpisodeParticipantRequest", removeParticipantRequest{}).
		Responds(http.StatusAccepted, "ParticipantRemoval", participantRemovalResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorInvalidRequestKey, apiErrorEpisodeNotFound, apiErrorEpisodeNotActive, apiErrorParticipantNotFound, apiErrorParticipantNotActive, apiErrorParticipantGenerationMismatch, apiErrorIdempotencyConflict, apiErrorEpisodeControlBusy, apiErrorRateLimited)...).ErrorRules(episodeLifecycleRules)
}

func endEpisodeEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[endEpisodeEndpointRequest, episodeControlResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/end", "endEpisode", decodeEndEpisodeRequest, func(ctx context.Context, request endEpisodeEndpointRequest) (episodeControlResponse, error) {
		end, err := service.RequestEpisodeEnd(ctx, episodes.RequestEpisodeEndInput{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, Request: episodes.Request{Key: request.RequestKey}})
		if err != nil {
			return episodeControlResponse{}, err
		}
		return episodeControlResponse{EpisodeID: end.Episode.ID.String(), Status: end.Episode.Status, Operation: newExternalOperationResponseFromIntent(end.Intent)}, nil
	}).Permission(authorizer, writeEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), idempotencyKeyParameter()).Responds(http.StatusAccepted, "EpisodeEnd", episodeControlResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidRequestKey, apiErrorEpisodeNotFound, apiErrorEpisodeNotActive, apiErrorIdempotencyConflict, apiErrorEpisodeControlBusy, apiErrorEpisodeCapacityExceeded, apiErrorRateLimited)...).ErrorRules(episodeLifecycleRules)
}

func setDeadlineEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[setDeadlineEndpointRequest, episodeControlResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/deadline", "setEpisodeDeadline", decodeSetDeadlineRequest, func(ctx context.Context, request setDeadlineEndpointRequest) (episodeControlResponse, error) {
		control, err := service.SetDeadline(ctx, episodes.SetDeadlineInput{TenantID: request.TenantID, SpaceID: request.SpaceID, EpisodeID: request.EpisodeID, Deadline: request.Body.DeadlineAt, Request: episodes.Request{Key: request.RequestKey}})
		if err != nil {
			return episodeControlResponse{}, err
		}
		return episodeControlResponse{EpisodeID: control.Episode.ID.String(), Status: control.Episode.Status, Operation: newExternalOperationResponse(control.Operation)}, nil
	}).Permission(authorizer, writeEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), idempotencyKeyParameter()).RequestBody("SetEpisodeDeadlineRequest", setDeadlineRequest{}).Responds(http.StatusAccepted, "EpisodeDeadline", episodeControlResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidRequestKey, apiErrorEpisodeNotFound, apiErrorEpisodeNotActive, apiErrorIdempotencyConflict, apiErrorEpisodeControlBusy, apiErrorRateLimited)...).ErrorRules(episodeLifecycleRules)
}

func resolveMediaPlane(ctx context.Context, resolver MediaPlaneResolver, spacesService SpaceService, tenantsService TenantService, tenantID, spaceID, episodeID utilities.ID) (*mediaplane.Service, error) {
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
	return resolver.ResolveEpisode(ctx, tenant, space, episodeID)
}

// resolveMediaPlaneForClients is the compatibility preflight of admission, join
// and grant: it resolves the Episode's bound media plane and refuses an SDK that
// cannot run its provider. It does no provider work and writes nothing.
func resolveMediaPlaneForClients(ctx context.Context, resolver MediaPlaneResolver, spacesService SpaceService, tenantsService TenantService, tenantID, spaceID, episodeID utilities.ID, clients mediaplane.ClientProviders) (*mediaplane.Service, error) {
	service, err := resolveMediaPlane(ctx, resolver, spacesService, tenantsService, tenantID, spaceID, episodeID)
	if err != nil || service == nil {
		return service, err
	}
	if !clients.Runs(service.Provider()) {
		return nil, mediaplane.ErrClientUnsupported
	}
	return service, nil
}

// resolveMediaEpisode refuses before any provider work when the caller's SDK
// cannot run the Episode's provider.
func resolveMediaEpisode(ctx context.Context, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, tenantID, spaceID, episodeID utilities.ID, clients mediaplane.ClientProviders) (*mediaplane.Service, mediaplane.Episode, error) {
	service, err := resolveMediaPlaneForClients(ctx, resolver, spacesService, tenantsService, tenantID, spaceID, episodeID, clients)
	if err != nil || service == nil {
		return service, mediaplane.Episode{}, err
	}
	episode, err := service.EnsureEpisode(ctx, mediaplane.EnsureEpisodeInput{Provider: service.Provider(), EpisodeKey: episodeID.String(), Metadata: map[string]string{"tenant_id": tenantID.String(), "space_id": spaceID.String()}})
	return service, episode, err
}

func lifecycleWriteErrors(extra ...APIError) []APIError {
	return append([]APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInternal}, extra...)
}

func lifecycleReadErrors(extra ...APIError) []APIError {
	return append([]APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInternal}, extra...)
}

var episodeLifecycleRules = errorRules{
	ruleFor(apiErrorTenantLiveEpisodeLimit, tenantlimits.ErrLiveEpisodeLimitReached),
	ruleFor(apiErrorMediaConnectionNotFound, mediaplane.ErrConnectionNotFound),
	ruleFor(apiErrorMediaClientUnsupported, mediaplane.ErrClientUnsupported),
	ruleFor(apiErrorEpisodeControlBusy, episodes.ErrEpisodeControlBusy),
	ruleFor(apiErrorInvalidRequest, mediapublications.ErrInvalidPublication, mediaplane.ErrInvalidSignalRequest),
	ruleFor(apiErrorMediaPlaneUnavailable, mediapublications.ErrUnavailable, mediaplaneproviders.ErrUnknownProvider, mediaplaneproviders.ErrInvalidMode, mediaplaneproviders.ErrMissingProviderConfig, mediaplaneproviders.ErrInvalidProviderConfig, mediaplaneproviders.ErrAdapterUnavailable, mediaplane.ErrPlaneUnavailable, mediaplane.ErrProviderFailed),
	ruleFor(apiErrorInvalidTenantID, episodes.ErrInvalidTenantID),
	ruleFor(apiErrorInvalidSpaceID, episodes.ErrInvalidSpaceID),
	ruleFor(apiErrorInvalidEpisodeID, episodes.ErrInvalidEpisodeID),
	ruleFor(apiErrorInvalidParticipantID, episodes.ErrInvalidParticipantID),
	ruleFor(apiErrorSpaceNotFound, episodes.ErrSpaceNotFound),
	ruleFor(apiErrorEpisodeNotFound, episodes.ErrEpisodeNotFound),
	ruleFor(apiErrorEpisodeNotActive, episodes.ErrEpisodeNotActive),
	ruleFor(apiErrorParticipantNotFound, episodes.ErrParticipantNotFound, synctokens.ErrSubjectNotFound),
	ruleFor(apiErrorParticipantNotActive, episodes.ErrParticipantNotActive),
	ruleFor(apiErrorParticipantGenerationMismatch, episodes.ErrParticipantGenerationMismatch),
	ruleFor(apiErrorInvalidRequestKey, episodes.ErrInvalidRequestKey),
	ruleFor(apiErrorIdempotencyConflict, episodes.ErrIdempotencyConflict),
	ruleFor(apiErrorEpisodeCapacityExceeded, episodes.ErrEpisodeAlreadyExists),
	ruleFor(apiErrorEpisodeCapacityExceeded, episodes.ErrCapacityExceeded),
	ruleFor(apiErrorInvalidRequest, episodes.ErrInvalidIdentityMode, episodes.ErrAdmissionClosed, episodes.ErrInvalidAdmissionPolicy, episodes.ErrInvalidRole, episodes.ErrInvalidRoleCapabilities, episodes.ErrInvalidConfigSnapshot, episodes.ErrInvalidParticipantName, episodes.ErrInvalidParticipantGeneration, episodes.ErrInvalidIntentPayload, episodes.ErrInvalidInitialControlState, episodes.ErrInvalidMaximumDuration, episodes.ErrInvalidMaximumDurationCeiling, episodes.ErrInvalidDeadline, episodes.ErrDeadlineExceedsCeiling, episodes.ErrDeadlineChangePending),
}
