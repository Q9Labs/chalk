package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/synctokens"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type DashboardSpaceJoinService interface {
	JoinSelf(context.Context, episodes.SelfJoinInput) (episodes.SelfJoinResult, error)
	FindSelf(context.Context, episodes.SelfAccessInput) (episodes.SelfJoinResult, error)
	LeaveSelf(context.Context, episodes.SelfLeaveInput) (episodes.SelfLeaveResult, error)
}

type dashboardSpaceSelfJoinBody struct {
	DisplayName string `json:"display_name"`
}

type dashboardSpaceSelfJoinRequest struct {
	TenantID   utilities.ID
	SpaceSlug  string
	RequestKey string
	Body       dashboardSpaceSelfJoinBody
}

type dashboardSpaceSelfAccessRequest struct {
	TenantID  utilities.ID
	SpaceSlug string
	Body      issueAccessGrantBody
}

type dashboardSpaceSelfLeaveRequest struct {
	TenantID              utilities.ID
	SpaceSlug             string
	RequestKey            string
	ParticipantGeneration int64
}

const dashboardJoinCleanupRequestPrefix = "dashboard-join-cleanup-"

func dashboardSpaceSelfEndpoints(service DashboardSpaceJoinService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, mediaTokens ParticipantMediaIssuer, diagnosticsTokens ParticipantDiagnosticsIssuer, mediaVerifier ParticipantMediaVerifier, active ActiveParticipantAuthorizer, generations ParticipantGenerationAuthorizer, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		dashboardSpaceSelfJoinEndpoint(service, tokens, refresh, mediaTokens, diagnosticsTokens, spacesService, tenantsService, resolver, authorizer),
		dashboardSpaceSelfAccessEndpoint(service, refresh, mediaTokens, diagnosticsTokens, mediaVerifier, active, generations, spacesService, tenantsService, resolver, authorizer),
		dashboardSpaceSelfLeaveEndpoint(service, authorizer),
	}
}

func dashboardSpaceSelfJoinEndpoint(service DashboardSpaceJoinService, tokens SyncTokenIssuer, refresh SyncTokenRefreshIssuer, mediaTokens ParticipantMediaIssuer, diagnosticsTokens ParticipantDiagnosticsIssuer, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, authorizer TenantAuthorizer) Endpoint[dashboardSpaceSelfJoinRequest, accessGrantResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/by-slug/{space_slug}/participants/self", "/tenants/{tenant_id}/spaces/by-slug/{space_slug}/participants/self", "joinDashboardSpaceSelf", decodeDashboardSpaceSelfJoinRequest, func(ctx context.Context, request dashboardSpaceSelfJoinRequest) (accessGrantResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
			return accessGrantResponse{}, err
		}
		accountID, err := dashboardAccountID(ctx)
		if err != nil {
			return accessGrantResponse{}, err
		}
		if service == nil || mediaTokens == nil {
			return accessGrantResponse{}, apiErrorServiceUnavailable
		}
		joined, err := service.JoinSelf(ctx, episodes.SelfJoinInput{TenantID: request.TenantID, AccountID: accountID, SpaceSlug: request.SpaceSlug, DisplayName: request.Body.DisplayName, Request: episodes.Request{Key: request.RequestKey}})
		if err != nil {
			return accessGrantResponse{}, err
		}
		cleanupFailedJoin := func(cause error) error {
			if joined.Participant.Status != episodes.ParticipantStatusJoining {
				return cause
			}
			_, cleanupErr := service.LeaveSelf(ctx, episodes.SelfLeaveInput{
				TenantID:              request.TenantID,
				AccountID:             accountID,
				SpaceSlug:             request.SpaceSlug,
				ParticipantGeneration: joined.Participant.Generation,
				Request:               episodes.Request{Key: dashboardJoinCleanupRequestKey(request.RequestKey)},
			})
			if cleanupErr != nil {
				slog.ErrorContext(ctx, "dashboard Space join cleanup failed", "tenant_id", request.TenantID.String(), "space_slug", request.SpaceSlug, "participant_generation", joined.Participant.Generation, "error", cleanupErr)
			}
			return cause
		}
		var syncCredential synctokens.Token
		if tokens != nil {
			syncCredential, err = tokens.Issue(ctx, synctokens.Input{TenantID: joined.Participant.TenantID, SpaceID: joined.Participant.SpaceID, EpisodeID: joined.Participant.EpisodeID, ParticipantID: joined.Participant.ID, ParticipantGeneration: joined.Participant.Generation, AdmissionLifecycleIntentID: joined.Intent.ID, DisplayName: request.Body.DisplayName, Role: joined.Participant.Role, Capabilities: append([]string(nil), joined.Participant.Capabilities...)})
		} else if refresh != nil {
			syncCredential, err = refresh.IssueForParticipant(ctx, synctokens.SubjectKey{TenantID: joined.Participant.TenantID, SpaceID: joined.Participant.SpaceID, EpisodeID: joined.Participant.EpisodeID, ParticipantID: joined.Participant.ID})
		} else {
			return accessGrantResponse{}, cleanupFailedJoin(apiErrorServiceUnavailable)
		}
		if err != nil {
			return accessGrantResponse{}, cleanupFailedJoin(err)
		}
		join, err := createParticipantJoin(ctx, spacesService, tenantsService, resolver, joined.Participant)
		if err != nil {
			return accessGrantResponse{}, cleanupFailedJoin(err)
		}
		subject, err := accessGrantSubjectForJoin(issueAccessGrantRequest{TenantID: joined.Participant.TenantID, SpaceID: joined.Participant.SpaceID, EpisodeID: joined.Participant.EpisodeID, ParticipantID: joined.Participant.ID, Body: issueAccessGrantBody{ParticipantGeneration: joined.Participant.Generation}}, join)
		if err != nil {
			return accessGrantResponse{}, cleanupFailedJoin(err)
		}
		mediaCredential, err := mediaTokens.Issue(ctx, subject)
		if err != nil {
			return accessGrantResponse{}, cleanupFailedJoin(err)
		}
		response := newAccessGrantResponse(subject, syncCredential, mediaCredential, join)
		attachDiagnosticsCredential(ctx, &response, diagnosticsTokens, subject)
		return response, nil
	}).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceSlugParameter(), idempotencyKeyParameter()).RequestBody("DashboardSpaceSelfJoinRequest", dashboardSpaceSelfJoinBody{}).
		Responds(http.StatusCreated, "AccessGrant", accessGrantResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceSlug, apiErrorInvalidRequestKey, apiErrorSpaceNotFound, apiErrorEpisodeNotActive, apiErrorParticipantNotActive, apiErrorIdempotencyConflict, apiErrorEpisodeCapacityExceeded, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).MapErrors(dashboardSpaceEndpointAPIError)
}

func dashboardJoinCleanupRequestKey(requestKey string) string {
	digest := sha256.Sum256([]byte(requestKey))
	return dashboardJoinCleanupRequestPrefix + hex.EncodeToString(digest[:])
}

func dashboardSpaceSelfAccessEndpoint(service DashboardSpaceJoinService, refresh SyncTokenRefreshIssuer, mediaTokens ParticipantMediaIssuer, diagnosticsTokens ParticipantDiagnosticsIssuer, mediaVerifier ParticipantMediaVerifier, active ActiveParticipantAuthorizer, generations ParticipantGenerationAuthorizer, spacesService SpaceService, tenantsService TenantService, resolver MediaPlaneResolver, authorizer TenantAuthorizer) Endpoint[dashboardSpaceSelfAccessRequest, accessGrantResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/by-slug/{space_slug}/participants/self/access-grants", "/tenants/{tenant_id}/spaces/by-slug/{space_slug}/participants/self/access-grants", "refreshDashboardSpaceSelfAccess", decodeDashboardSpaceSelfAccessRequest, func(ctx context.Context, request dashboardSpaceSelfAccessRequest) (accessGrantResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
			return accessGrantResponse{}, err
		}
		accountID, err := dashboardAccountID(ctx)
		if err != nil {
			return accessGrantResponse{}, err
		}
		if service == nil || refresh == nil || mediaTokens == nil || mediaVerifier == nil || active == nil || generations == nil {
			return accessGrantResponse{}, apiErrorServiceUnavailable
		}
		found, err := service.FindSelf(ctx, episodes.SelfAccessInput{TenantID: request.TenantID, AccountID: accountID, SpaceSlug: request.SpaceSlug})
		if err != nil {
			return accessGrantResponse{}, err
		}
		generation := request.Body.ParticipantGeneration
		if generation <= 0 {
			generation = found.Participant.Generation
		}
		if generation != found.Participant.Generation {
			return accessGrantResponse{}, apiErrorParticipantGenerationMismatch
		}
		grantRequest := issueAccessGrantRequest{TenantID: found.Participant.TenantID, SpaceID: found.Participant.SpaceID, EpisodeID: found.Participant.EpisodeID, ParticipantID: found.Participant.ID, Body: request.Body}
		var subject accessgrants.Subject
		var join mediaplane.Join
		if request.Body.ReplaceMediaConnection {
			ok, err := generations.AuthorizeActiveParticipantGeneration(ctx, synctokens.SubjectKey{TenantID: found.Participant.TenantID, SpaceID: found.Participant.SpaceID, EpisodeID: found.Participant.EpisodeID, ParticipantID: found.Participant.ID}, generation)
			if err != nil {
				return accessGrantResponse{}, err
			}
			if !ok {
				return accessGrantResponse{}, apiErrorForbidden
			}
			join, err = createAccessGrantJoin(ctx, spacesService, tenantsService, resolver, grantRequest)
			if err != nil {
				return accessGrantResponse{}, err
			}
			subject, err = accessGrantSubjectForJoin(grantRequest, join)
			if err != nil {
				return accessGrantResponse{}, accessGrantRefreshError(err)
			}
		} else {
			if strings.TrimSpace(request.Body.CurrentMediaToken) == "" {
				return accessGrantResponse{}, apiErrorInvalidRequest
			}
			subject, err = mediaVerifier.Verify(ctx, request.Body.CurrentMediaToken)
			if err == nil {
				err = accessgrants.RequireRouteSubject(subject, accessgrants.RouteSubject{TenantID: found.Participant.TenantID, SpaceID: found.Participant.SpaceID, EpisodeID: found.Participant.EpisodeID, ParticipantID: found.Participant.ID, ParticipantGeneration: generation, Provider: subject.Provider, CloudflareConnectionID: subject.CloudflareConnectionID})
			}
			if err == nil {
				ok, authErr := active.AuthorizeActiveParticipant(ctx, subject)
				if authErr != nil {
					return accessGrantResponse{}, authErr
				}
				if !ok {
					return accessGrantResponse{}, apiErrorForbidden
				}
			}
			if err == nil {
				join, err = resumeAccessGrantJoin(ctx, spacesService, tenantsService, resolver, grantRequest, subject)
			}
		}
		if err != nil {
			return accessGrantResponse{}, accessGrantRefreshError(err)
		}
		syncCredential, err := refresh.IssueForParticipant(ctx, synctokens.SubjectKey{TenantID: found.Participant.TenantID, SpaceID: found.Participant.SpaceID, EpisodeID: found.Participant.EpisodeID, ParticipantID: found.Participant.ID})
		if err != nil {
			return accessGrantResponse{}, err
		}
		mediaCredential, err := mediaTokens.Issue(ctx, subject)
		if err != nil {
			return accessGrantResponse{}, err
		}
		response := newAccessGrantResponse(subject, syncCredential, mediaCredential, join)
		attachDiagnosticsCredential(ctx, &response, diagnosticsTokens, subject)
		return response, nil
	}).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceSlugParameter()).RequestBody("IssueAccessGrantRequest", issueAccessGrantBody{}).
		Responds(http.StatusCreated, "AccessGrant", accessGrantResponse{}).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceSlug, apiErrorSpaceNotFound, apiErrorEpisodeNotFound, apiErrorParticipantNotFound, apiErrorParticipantGenerationMismatch, apiErrorMediaPlaneUnavailable, apiErrorRateLimited)...).MapErrors(dashboardSpaceEndpointAPIError)
}

func dashboardSpaceSelfLeaveEndpoint(service DashboardSpaceJoinService, authorizer TenantAuthorizer) Endpoint[dashboardSpaceSelfLeaveRequest, struct{}] {
	return Delete("/v1/tenants/{tenant_id}/spaces/by-slug/{space_slug}/participants/self", "/tenants/{tenant_id}/spaces/by-slug/{space_slug}/participants/self", "leaveDashboardSpaceSelf", decodeDashboardSpaceSelfLeaveRequest, func(ctx context.Context, request dashboardSpaceSelfLeaveRequest) (struct{}, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeEpisodesPermission); err != nil {
			return struct{}{}, err
		}
		accountID, err := dashboardAccountID(ctx)
		if err != nil {
			return struct{}{}, err
		}
		if service == nil {
			return struct{}{}, apiErrorServiceUnavailable
		}
		_, err = service.LeaveSelf(ctx, episodes.SelfLeaveInput{TenantID: request.TenantID, AccountID: accountID, SpaceSlug: request.SpaceSlug, ParticipantGeneration: request.ParticipantGeneration, Request: episodes.Request{Key: request.RequestKey}})
		return struct{}{}, err
	}).UserAuth().RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceSlugParameter(), idempotencyKeyParameter()).RequestBody("LeaveDashboardSpaceSelfRequest", removeParticipantRequest{}).RespondsNoBody(http.StatusNoContent).
		Errors(lifecycleWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceSlug, apiErrorInvalidRequestKey, apiErrorSpaceNotFound, apiErrorParticipantGenerationMismatch, apiErrorParticipantNotActive, apiErrorEpisodeNotActive, apiErrorIdempotencyConflict, apiErrorRateLimited)...).MapErrors(dashboardSpaceEndpointAPIError)
}

func decodeDashboardSpaceSelfJoinRequest(r *http.Request) (dashboardSpaceSelfJoinRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return dashboardSpaceSelfJoinRequest{}, err
	}
	body, err := decodeJSONBody[dashboardSpaceSelfJoinBody](r)
	if err != nil {
		return dashboardSpaceSelfJoinRequest{}, err
	}
	return dashboardSpaceSelfJoinRequest{TenantID: tenantID, SpaceSlug: chi.URLParam(r, "space_slug"), RequestKey: r.Header.Get(idempotencyKeyHeader), Body: body}, nil
}

func decodeDashboardSpaceSelfAccessRequest(r *http.Request) (dashboardSpaceSelfAccessRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return dashboardSpaceSelfAccessRequest{}, err
	}
	body, err := decodeJSONBody[issueAccessGrantBody](r)
	return dashboardSpaceSelfAccessRequest{TenantID: tenantID, SpaceSlug: chi.URLParam(r, "space_slug"), Body: body}, err
}

func decodeDashboardSpaceSelfLeaveRequest(r *http.Request) (dashboardSpaceSelfLeaveRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return dashboardSpaceSelfLeaveRequest{}, err
	}
	body, err := decodeJSONBody[removeParticipantRequest](r)
	return dashboardSpaceSelfLeaveRequest{TenantID: tenantID, SpaceSlug: chi.URLParam(r, "space_slug"), RequestKey: r.Header.Get(idempotencyKeyHeader), ParticipantGeneration: body.ParticipantGeneration}, err
}

func dashboardAccountID(ctx context.Context) (utilities.ID, error) {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return utilities.ID{}, apiErrorUnauthenticated
	}
	if principal.Kind != authentication.PrincipalUser || principal.UserID.IsZero() {
		return utilities.ID{}, apiErrorForbidden
	}
	return principal.UserID, nil
}

func spaceSlugParameter() APIParameterContract {
	return APIParameterContract{Name: "space_slug", In: "path", Type: "string", Required: true, Pattern: `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`, MinLength: 1, MaxLength: 128}
}

func dashboardSpaceEndpointAPIError(err error) (APIError, bool) {
	if errors.Is(err, episodes.ErrInvalidSpaceSlug) {
		return apiErrorInvalidSpaceSlug, true
	}
	if errors.Is(err, episodes.ErrInvalidAccountID) {
		return apiErrorForbidden, true
	}
	return episodeLifecycleEndpointAPIError(err)
}
