package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	readSpacesPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeSpacesRead,
		MinimumRole: memberships.RoleObserver,
	}
	writeSpacesPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeSpacesWrite,
		MinimumRole: memberships.RoleCollaborator,
	}
	apiErrorInvalidSpaceArtifactPolicy = APIError{Status: http.StatusBadRequest, Code: "space.invalid_artifact_policy", Message: "Invalid Space Artifact policy"}
)

type SpaceService interface {
	CreateSpace(ctx context.Context, input spaces.CreateSpaceInput) (spaces.Space, error)
	GetSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (spaces.Space, error)
	ListSpaces(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (spaces.SpaceList, error)
	UpdateSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, input spaces.UpdateSpaceInput) (spaces.Space, error)
}

type SpaceArchiveService interface {
	ArchiveSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (spaces.Space, error)
	RestoreSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (spaces.Space, error)
}

type SpaceFilterService interface {
	ListSpacesFiltered(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest, archived *bool) (spaces.SpaceList, error)
}

func spaceEndpoints(service SpaceService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createSpaceEndpoint(service, authorizer),
		listSpacesEndpoint(service, authorizer),
		getSpaceEndpoint(service, authorizer),
		updateSpaceEndpoint(service, authorizer),
		archiveSpaceEndpoint(service, authorizer),
		restoreSpaceEndpoint(service, authorizer),
	}
}

func createSpaceEndpoint(service SpaceService, authorizer TenantAuthorizer) Endpoint[createSpaceEndpointRequest, spaceResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces", "createSpace", decodeCreateSpaceRequest, func(ctx context.Context, request createSpaceEndpointRequest) (spaceResponse, error) {

		input, err := request.Body.toCreateInput(request.TenantID, createdByUserID(ctx), request.RequestKey)
		if err != nil {
			return spaceResponse{}, err
		}
		space, err := service.CreateSpace(ctx, input)
		if err != nil {
			return spaceResponse{}, err
		}
		return singleSpaceResponse(ctx, service, request.TenantID, space)
	}).Needs(service).Permission(authorizer, writeSpacesPermission).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), idempotencyKeyParameter()).
		RequestBody("CreateSpaceRequest", createSpaceRequest{}).
		Responds(http.StatusCreated, "Space", spaceResponse{}).
		Errors(spaceWriteErrors(apiErrorInvalidRequest, apiErrorInvalidMediaPlane, apiErrorSpaceMediaPlaneNotPermitted, apiErrorInvalidSpaceArtifactPolicy, apiErrorInvalidRequestKey, apiErrorIdempotencyConflict, apiErrorSpaceSlugAlreadyUsed, apiErrorRateLimited)...).
		ErrorRules(spaceRules)
}

func listSpacesEndpoint(service SpaceService, authorizer TenantAuthorizer) Endpoint[listSpacesRequest, spaceListResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces", "listSpaces", decodeListSpacesRequest, func(ctx context.Context, request listSpacesRequest) (spaceListResponse, error) {

		var list spaces.SpaceList
		var err error
		if request.Archived != nil {
			if filtered, ok := service.(SpaceFilterService); ok {
				list, err = filtered.ListSpacesFiltered(ctx, request.TenantID, request.Page, request.Archived)
			} else {
				list, err = service.ListSpaces(ctx, request.TenantID, request.Page)
			}
		} else {
			list, err = service.ListSpaces(ctx, request.TenantID, request.Page)
		}
		if err != nil {
			return spaceListResponse{}, err
		}
		return newSpaceListResponse(ctx, service, request.TenantID, list)
	}).Needs(service).Permission(authorizer, readSpacesPermission).
		Auth(APIAuthSessionOrBearer).
		Responds(http.StatusOK, "SpaceList", spaceListResponse{}).
		Parameters(append([]APIParameterContract{tenantIDParameter(), {Name: "archived", In: "query", Type: "boolean", Required: false}}, paginationParameters()...)...).
		Errors(spaceReadErrors(apiErrorInvalidPageSize, apiErrorInvalidCursor, apiErrorInvalidSpaceArchiveFilter)...).
		ErrorRules(spaceRules)
}

func getSpaceEndpoint(service SpaceService, authorizer TenantAuthorizer) Endpoint[getSpaceRequest, spaceResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}", "getSpace", decodeGetSpaceRequest, func(ctx context.Context, request getSpaceRequest) (spaceResponse, error) {

		space, err := service.GetSpace(ctx, request.TenantID, request.SpaceID)
		if err != nil {
			return spaceResponse{}, err
		}
		return singleSpaceResponse(ctx, service, request.TenantID, space)
	}).Needs(service).Permission(authorizer, readSpacesPermission).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter(), spaceIDParameter()).
		Responds(http.StatusOK, "Space", spaceResponse{}).
		Errors(spaceReadErrors(apiErrorInvalidSpaceID, apiErrorSpaceNotFound)...).
		ErrorRules(spaceRules)
}

func updateSpaceEndpoint(service SpaceService, authorizer TenantAuthorizer) Endpoint[updateSpaceEndpointRequest, spaceResponse] {
	return Patch("/v1/tenants/{tenant_id}/spaces/{space_id}", "updateSpace", decodeUpdateSpaceRequest, func(ctx context.Context, request updateSpaceEndpointRequest) (spaceResponse, error) {

		input, err := request.Body.toUpdateInput()
		if err != nil {
			return spaceResponse{}, err
		}
		space, err := service.UpdateSpace(ctx, request.TenantID, request.SpaceID, input)
		if err != nil {
			return spaceResponse{}, err
		}
		return singleSpaceResponse(ctx, service, request.TenantID, space)
	}).Needs(service).Permission(authorizer, writeSpacesPermission).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).
		RequestBody("UpdateSpaceRequest", updateSpaceRequest{}).
		Responds(http.StatusOK, "Space", spaceResponse{}).
		Errors(spaceWriteErrors(apiErrorInvalidRequest, apiErrorInvalidMediaPlane, apiErrorSpaceMediaPlaneNotPermitted, apiErrorInvalidSpaceID, apiErrorInvalidSpaceArtifactPolicy, apiErrorSpaceSlugAlreadyUsed, apiErrorSpaceNotFound, apiErrorRateLimited)...).
		ErrorRules(spaceRules)
}

func archiveSpaceEndpoint(service SpaceService, authorizer TenantAuthorizer) Endpoint[getSpaceRequest, spaceResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/archive", "archiveSpace", decodeGetSpaceRequest, func(ctx context.Context, request getSpaceRequest) (spaceResponse, error) {
		archive, ok := service.(SpaceArchiveService)
		if !ok {
			return spaceResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSpacesPermission); err != nil {
			return spaceResponse{}, err
		}
		space, err := archive.ArchiveSpace(ctx, request.TenantID, request.SpaceID)
		if err != nil {
			return spaceResponse{}, err
		}
		return singleSpaceResponse(ctx, service, request.TenantID, space)
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).Responds(http.StatusOK, "Space", spaceResponse{}).
		Errors(spaceWriteErrors(apiErrorInvalidSpaceID, apiErrorSpaceNotFound, apiErrorRateLimited)...).ErrorRules(spaceRules)
}

func restoreSpaceEndpoint(service SpaceService, authorizer TenantAuthorizer) Endpoint[getSpaceRequest, spaceResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/restore", "restoreSpace", decodeGetSpaceRequest, func(ctx context.Context, request getSpaceRequest) (spaceResponse, error) {
		restore, ok := service.(SpaceArchiveService)
		if !ok {
			return spaceResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSpacesPermission); err != nil {
			return spaceResponse{}, err
		}
		space, err := restore.RestoreSpace(ctx, request.TenantID, request.SpaceID)
		if err != nil {
			return spaceResponse{}, err
		}
		return singleSpaceResponse(ctx, service, request.TenantID, space)
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).Responds(http.StatusOK, "Space", spaceResponse{}).
		Errors(spaceWriteErrors(apiErrorInvalidSpaceID, apiErrorSpaceNotFound, apiErrorRateLimited)...).ErrorRules(spaceRules)
}

func spaceReadErrors(extra ...APIError) []APIError {
	return append([]APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInternal,
	}, extra...)
}

func spaceWriteErrors(extra ...APIError) []APIError {
	return append([]APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInternal,
	}, extra...)
}

var spaceRules = errorRules{
	ruleFor(apiErrorInvalidTenantID, spaces.ErrInvalidTenantID),
	ruleFor(apiErrorInvalidSpaceID, spaces.ErrInvalidSpaceID),
	ruleFor(apiErrorInvalidSpaceName, spaces.ErrInvalidSpaceName),
	ruleFor(apiErrorInvalidSpaceSlug, spaces.ErrInvalidSpaceSlug),
	ruleFor(apiErrorInvalidMediaPlane, spaces.ErrInvalidMediaPlane),
	ruleFor(apiErrorSpaceMediaPlaneNotPermitted, spaces.ErrMediaPlaneNotPermitted),
	ruleFor(apiErrorInvalidSpaceField, spaces.ErrInvalidAdmissionPolicy, spaces.ErrInvalidEpisodeDuration, spaces.ErrInvalidEpisodeCeiling, spaces.ErrInvalidLingerWindow, spaces.ErrInvalidSpaceField),
	ruleFor(apiErrorInvalidSpaceArtifactPolicy, spaces.ErrInvalidRecordingPolicy, spaces.ErrInvalidTranscriptionPolicy),
	ruleFor(apiErrorSpaceNotFound, spaces.ErrSpaceNotFound),
	ruleFor(apiErrorSpaceSlugAlreadyUsed, spaces.ErrSpaceSlugAlreadyUsed),
	ruleFor(apiErrorInvalidRequestKey, spaces.ErrInvalidRequestKey),
	ruleFor(apiErrorIdempotencyConflict, spaces.ErrIdempotencyConflict),
}

// SpacePlaneService reports the plane a new Episode would start on in each Space.
type SpacePlaneService interface {
	EffectiveMediaPlanes(ctx context.Context, tenantID utilities.ID, list []spaces.Space) ([]*spaces.MediaPlaneProvider, error)
}
