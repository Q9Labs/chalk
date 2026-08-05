package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
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
)

type SpaceService interface {
	CreateSpace(ctx context.Context, input spaces.CreateSpaceInput) (spaces.Space, error)
	GetSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID) (spaces.Space, error)
	ListSpaces(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (spaces.SpaceList, error)
	UpdateSpace(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, input spaces.UpdateSpaceInput) (spaces.Space, error)
}

type spaceRoleResponse struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Capabilities []string `json:"capabilities"`
}

type spaceResponse struct {
	ID                            string              `json:"id"`
	Name                          string              `json:"name"`
	TenantID                      string              `json:"tenant_id"`
	Slug                          string              `json:"slug"`
	MediaPlane                    string              `json:"media_plane"`
	Metadata                      any                 `json:"metadata"`
	RecurringPolicy               any                 `json:"recurring_policy"`
	AdmissionPolicy               any                 `json:"admission_policy"`
	DefaultEpisodeDurationSeconds int32               `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds int32               `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           int32               `json:"linger_window_seconds"`
	Roles                         []spaceRoleResponse `json:"roles"`
	CreatedByUserID               *string             `json:"created_by_user_id"`
	UpdatedAt                     string              `json:"updated_at"`
	CreatedAt                     string              `json:"created_at"`
}

type spaceListResponse struct {
	Spaces     []spaceResponse    `json:"spaces"`
	Pagination paginationResponse `json:"pagination"`
}

type createSpaceRequest struct {
	Name                          string                 `json:"name"`
	Slug                          string                 `json:"slug"`
	MediaPlane                    string                 `json:"media_plane"`
	Metadata                      utilities.OptionalJSON `json:"metadata"`
	RecurringPolicy               utilities.OptionalJSON `json:"recurring_policy"`
	AdmissionPolicy               utilities.OptionalJSON `json:"admission_policy"`
	DefaultEpisodeDurationSeconds int32                  `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds int32                  `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           int32                  `json:"linger_window_seconds"`
}

type updateSpaceRequest struct {
	Name                          utilities.OptionalString `json:"name"`
	Slug                          utilities.OptionalString `json:"slug"`
	MediaPlane                    utilities.OptionalString `json:"media_plane"`
	Metadata                      utilities.OptionalJSON   `json:"metadata"`
	RecurringPolicy               utilities.OptionalJSON   `json:"recurring_policy"`
	AdmissionPolicy               utilities.OptionalJSON   `json:"admission_policy"`
	DefaultEpisodeDurationSeconds spaces.OptionalInt32     `json:"default_episode_duration_seconds"`
	MaximumEpisodeDurationSeconds spaces.OptionalInt32     `json:"maximum_episode_duration_seconds"`
	LingerWindowSeconds           spaces.OptionalInt32     `json:"linger_window_seconds"`
}

type createSpaceEndpointRequest struct {
	TenantID utilities.ID
	Body     createSpaceRequest
}

type listSpacesRequest struct {
	TenantID utilities.ID
	Page     pagination.PageRequest
}

type getSpaceRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
}

type updateSpaceEndpointRequest struct {
	TenantID utilities.ID
	SpaceID  utilities.ID
	Body     updateSpaceRequest
}

func mountSpaceRoutes(r chi.Router, service SpaceService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range spaceEndpoints(service, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func spaceEndpoints(service SpaceService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createSpaceEndpoint(service, authorizer),
		listSpacesEndpoint(service, authorizer),
		getSpaceEndpoint(service, authorizer),
		updateSpaceEndpoint(service, authorizer),
	}
}

func createSpaceEndpoint(service SpaceService, authorizer TenantAuthorizer) Endpoint[createSpaceEndpointRequest, spaceResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces", "/tenants/{tenant_id}/spaces", "createSpace", decodeCreateSpaceRequest, func(ctx context.Context, request createSpaceEndpointRequest) (spaceResponse, error) {
		if service == nil {
			return spaceResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSpacesPermission); err != nil {
			return spaceResponse{}, err
		}

		space, err := service.CreateSpace(ctx, request.Body.toCreateInput(request.TenantID, createdByUserID(ctx)))
		if err != nil {
			return spaceResponse{}, err
		}
		return newSpaceResponse(space), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter()).
		RequestBody("CreateSpaceRequest", createSpaceRequest{}).
		Responds(http.StatusCreated, "Space", spaceResponse{}).
		Errors(spaceWriteErrors(apiErrorInvalidRequest, apiErrorSpaceSlugAlreadyUsed, apiErrorRateLimited)...).
		MapErrors(spaceEndpointAPIError)
}

func listSpacesEndpoint(service SpaceService, authorizer TenantAuthorizer) Endpoint[listSpacesRequest, spaceListResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces", "/tenants/{tenant_id}/spaces", "listSpaces", decodeListSpacesRequest, func(ctx context.Context, request listSpacesRequest) (spaceListResponse, error) {
		if service == nil {
			return spaceListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readSpacesPermission); err != nil {
			return spaceListResponse{}, err
		}

		list, err := service.ListSpaces(ctx, request.TenantID, request.Page)
		if err != nil {
			return spaceListResponse{}, err
		}
		return newSpaceListResponse(list)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "SpaceList", spaceListResponse{}).
		Errors(spaceReadErrors(apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
		MapErrors(spaceEndpointAPIError)
}

func getSpaceEndpoint(service SpaceService, authorizer TenantAuthorizer) Endpoint[getSpaceRequest, spaceResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}", "/tenants/{tenant_id}/spaces/{space_id}", "getSpace", decodeGetSpaceRequest, func(ctx context.Context, request getSpaceRequest) (spaceResponse, error) {
		if service == nil {
			return spaceResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readSpacesPermission); err != nil {
			return spaceResponse{}, err
		}

		space, err := service.GetSpace(ctx, request.TenantID, request.SpaceID)
		if err != nil {
			return spaceResponse{}, err
		}
		return newSpaceResponse(space), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter(), spaceIDParameter()).
		Responds(http.StatusOK, "Space", spaceResponse{}).
		Errors(spaceReadErrors(apiErrorInvalidSpaceID, apiErrorSpaceNotFound)...).
		MapErrors(spaceEndpointAPIError)
}

func updateSpaceEndpoint(service SpaceService, authorizer TenantAuthorizer) Endpoint[updateSpaceEndpointRequest, spaceResponse] {
	return Patch("/v1/tenants/{tenant_id}/spaces/{space_id}", "/tenants/{tenant_id}/spaces/{space_id}", "updateSpace", decodeUpdateSpaceRequest, func(ctx context.Context, request updateSpaceEndpointRequest) (spaceResponse, error) {
		if service == nil {
			return spaceResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeSpacesPermission); err != nil {
			return spaceResponse{}, err
		}

		space, err := service.UpdateSpace(ctx, request.TenantID, request.SpaceID, request.Body.toUpdateInput())
		if err != nil {
			return spaceResponse{}, err
		}
		return newSpaceResponse(space), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter()).
		RequestBody("UpdateSpaceRequest", updateSpaceRequest{}).
		Responds(http.StatusOK, "Space", spaceResponse{}).
		Errors(spaceWriteErrors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorSpaceSlugAlreadyUsed, apiErrorSpaceNotFound, apiErrorRateLimited)...).
		MapErrors(spaceEndpointAPIError)
}

func decodeCreateSpaceRequest(r *http.Request) (createSpaceEndpointRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return createSpaceEndpointRequest{}, err
	}
	body, err := decodeJSONBody[createSpaceRequest](r)
	if err != nil {
		return createSpaceEndpointRequest{}, err
	}
	return createSpaceEndpointRequest{TenantID: tenantID, Body: body}, nil
}

func decodeListSpacesRequest(r *http.Request) (listSpacesRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listSpacesRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listSpacesRequest{}, paginationAPIError(err)
	}
	return listSpacesRequest{TenantID: tenantID, Page: page}, nil
}

func decodeGetSpaceRequest(r *http.Request) (getSpaceRequest, error) {
	tenantID, spaceID, err := tenantSpaceIDsRequest(r)
	if err != nil {
		return getSpaceRequest{}, err
	}
	return getSpaceRequest{TenantID: tenantID, SpaceID: spaceID}, nil
}

func decodeUpdateSpaceRequest(r *http.Request) (updateSpaceEndpointRequest, error) {
	tenantID, spaceID, err := tenantSpaceIDsRequest(r)
	if err != nil {
		return updateSpaceEndpointRequest{}, err
	}
	body, err := decodeJSONBody[updateSpaceRequest](r)
	if err != nil {
		return updateSpaceEndpointRequest{}, err
	}
	return updateSpaceEndpointRequest{TenantID: tenantID, SpaceID: spaceID, Body: body}, nil
}

func tenantSpaceIDsRequest(r *http.Request) (utilities.ID, utilities.ID, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	spaceID, err := spaceIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	return tenantID, spaceID, nil
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

func spaceEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := spaceServiceAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func spaceServiceAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, spaces.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, spaces.ErrInvalidSpaceID):
		return apiErrorInvalidSpaceID, true
	case errors.Is(err, spaces.ErrInvalidSpaceName):
		return apiErrorInvalidSpaceName, true
	case errors.Is(err, spaces.ErrInvalidSpaceSlug):
		return apiErrorInvalidSpaceSlug, true
	case errors.Is(err, spaces.ErrInvalidMediaPlane):
		return apiErrorInvalidMediaPlane, true
	case errors.Is(err, spaces.ErrInvalidAdmissionPolicy),
		errors.Is(err, spaces.ErrInvalidEpisodeDuration),
		errors.Is(err, spaces.ErrInvalidEpisodeCeiling),
		errors.Is(err, spaces.ErrInvalidLingerWindow),
		errors.Is(err, spaces.ErrInvalidSpaceField):
		return apiErrorInvalidSpaceField, true
	case errors.Is(err, spaces.ErrSpaceNotFound):
		return apiErrorSpaceNotFound, true
	case errors.Is(err, spaces.ErrSpaceSlugAlreadyUsed):
		return apiErrorSpaceSlugAlreadyUsed, true
	default:
		return APIError{}, false
	}
}

func newSpaceListResponse(list spaces.SpaceList) (spaceListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return spaceListResponse{}, err
	}

	response := spaceListResponse{Spaces: make([]spaceResponse, 0, len(list.Spaces)), Pagination: page}
	for _, space := range list.Spaces {
		response.Spaces = append(response.Spaces, newSpaceResponse(space))
	}
	return response, nil
}

func newSpaceResponse(space spaces.Space) spaceResponse {
	roles := make([]spaceRoleResponse, 0, len(space.Roles))
	for _, role := range space.Roles {
		roles = append(roles, spaceRoleResponse{ID: role.ID.String(), Name: role.Name, Capabilities: append([]string(nil), role.Capabilities...)})
	}
	return spaceResponse{
		ID:                            space.ID.String(),
		Name:                          space.Name,
		TenantID:                      space.TenantID.String(),
		Slug:                          space.Slug,
		MediaPlane:                    space.MediaPlane,
		Metadata:                      rawJSONValue(space.Metadata),
		RecurringPolicy:               rawJSONValue(space.RecurringPolicy),
		AdmissionPolicy:               rawJSONValue(space.AdmissionPolicy),
		DefaultEpisodeDurationSeconds: space.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: space.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           space.LingerWindowSeconds,
		Roles:                         roles,
		CreatedByUserID:               optionalIDString(space.CreatedByUserID),
		UpdatedAt:                     utilities.FormatTimestamp(space.UpdatedAt),
		CreatedAt:                     utilities.FormatTimestamp(space.CreatedAt),
	}
}

func (request createSpaceRequest) toCreateInput(tenantID utilities.ID, userID utilities.ID) spaces.CreateSpaceInput {
	return spaces.CreateSpaceInput{
		Name:                          request.Name,
		TenantID:                      tenantID,
		Slug:                          request.Slug,
		MediaPlane:                    request.MediaPlane,
		Metadata:                      request.Metadata.Value,
		RecurringPolicy:               request.RecurringPolicy.Value,
		AdmissionPolicy:               request.AdmissionPolicy.Value,
		DefaultEpisodeDurationSeconds: request.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: request.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           request.LingerWindowSeconds,
		CreatedByUserID:               userID,
	}
}

func (request updateSpaceRequest) toUpdateInput() spaces.UpdateSpaceInput {
	return spaces.UpdateSpaceInput{
		Name:                          request.Name,
		Slug:                          request.Slug,
		MediaPlane:                    request.MediaPlane,
		Metadata:                      request.Metadata,
		RecurringPolicy:               request.RecurringPolicy,
		AdmissionPolicy:               request.AdmissionPolicy,
		DefaultEpisodeDurationSeconds: request.DefaultEpisodeDurationSeconds,
		MaximumEpisodeDurationSeconds: request.MaximumEpisodeDurationSeconds,
		LingerWindowSeconds:           request.LingerWindowSeconds,
	}
}

func createdByUserID(ctx context.Context) utilities.ID {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || principal.Kind != authentication.PrincipalUser {
		return utilities.ID{}
	}
	return principal.UserID
}
