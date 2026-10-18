package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"

	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	readTenantPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeTenantsRead,
		MinimumRole: memberships.RoleObserver,
	}
	writeTenantPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeTenantsWrite,
		MinimumRole: memberships.RoleCollaborator,
	}
	apiErrorInvalidTenantArtifactPolicy  = APIError{Status: http.StatusBadRequest, Code: "tenant.invalid_artifact_policy", Message: "Invalid Tenant Artifact policy"}
	apiErrorTenantArtifactPolicyConflict = APIError{Status: http.StatusConflict, Code: "tenant.artifact_policy_conflict", Message: "Tenant Artifact policy conflicts with its ceiling"}
)

type TenantService interface {
	CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error)
	GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error)
	ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error)
	ListServiceTenants(context.Context, string, pagination.PageRequest) (tenants.TenantList, error)
	FindServiceTenant(context.Context, string, string) (tenants.Tenant, error)
	UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error)
}

type tenantResponse struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	ExternalID *string `json:"external_id"`

	DefaultMediaPlane                *string                          `json:"default_media_plane"`
	MediaPlaneProviderConfig         any                              `json:"media_plane_provider_config"`
	StorageProviderConfig            any                              `json:"storage_provider_config"`
	CORSAllowedOrigins               []string                         `json:"cors_allowed_origins"`
	LogoKey                          *string                          `json:"logo_key"`
	Website                          *string                          `json:"website"`
	TranscriptionCeiling             artifactpolicy.TranscriptionMode `json:"transcription_ceiling"`
	TranscriptionDefaultMode         artifactpolicy.TranscriptionMode `json:"transcription_default_mode"`
	ProviderPolicyVersion            string                           `json:"provider_policy_version"`
	RecordingRetentionSeconds        int64                            `json:"recording_retention_seconds"`
	TranscriptRetentionSeconds       int64                            `json:"transcript_retention_seconds"`
	TranscriptionSourceWindowSeconds int64                            `json:"transcription_source_window_seconds"`
	UpdatedAt                        string                           `json:"updated_at"`
	CreatedAt                        string                           `json:"created_at"`
}

type tenantListResponse struct {
	Tenants    []tenantResponse   `json:"tenants"`
	Pagination paginationResponse `json:"pagination"`
}

type createTenantRequest struct {
	Name       string  `json:"name"`
	ExternalID *string `json:"external_id"`

	DefaultMediaPlane        *string         `json:"default_media_plane"`
	MediaPlaneProviderConfig json.RawMessage `json:"media_plane_provider_config"`
	StorageProviderConfig    json.RawMessage `json:"storage_provider_config"`
	CORSAllowedOrigins       []string        `json:"cors_allowed_origins,omitempty"`
	LogoKey                  *string         `json:"logo_key"`
	Website                  *string         `json:"website"`
}

type updateTenantRequest struct {
	Name utilities.OptionalString `json:"name"`

	DefaultMediaPlane                utilities.OptionalString    `json:"default_media_plane"`
	MediaPlaneProviderConfig         utilities.OptionalJSON      `json:"media_plane_provider_config"`
	StorageProviderConfig            utilities.OptionalJSON      `json:"storage_provider_config"`
	CORSAllowedOrigins               tenants.OptionalCORSOrigins `json:"cors_allowed_origins"`
	LogoKey                          utilities.OptionalString    `json:"logo_key"`
	Website                          utilities.OptionalString    `json:"website"`
	TranscriptionCeiling             utilities.OptionalString    `json:"transcription_ceiling"`
	TranscriptionDefaultMode         utilities.OptionalString    `json:"transcription_default_mode"`
	ProviderPolicyVersion            utilities.OptionalString    `json:"provider_policy_version"`
	RecordingRetentionSeconds        tenants.OptionalInt64       `json:"recording_retention_seconds"`
	TranscriptRetentionSeconds       tenants.OptionalInt64       `json:"transcript_retention_seconds"`
	TranscriptionSourceWindowSeconds tenants.OptionalInt64       `json:"transcription_source_window_seconds"`
}

type listTenantsRequest struct {
	Page pagination.PageRequest
}

type getTenantRequest struct {
	TenantID utilities.ID
}

type updateTenantEndpointRequest struct {
	TenantID utilities.ID
	Body     updateTenantRequest
}

func mountTenantRoutes(r chi.Router, service TenantService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range tenantEndpoints(service, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func tenantEndpoints(service TenantService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createTenantEndpoint(service),
		findServiceTenantEndpoint(service),
		listTenantsEndpoint(service),
		getTenantEndpoint(service, authorizer),
		updateTenantEndpoint(service, authorizer),
	}
}

func createTenantEndpoint(service TenantService) Endpoint[createTenantRequest, tenantResponse] {
	return Post("/v1/tenants", "/tenants", "createTenant", decodeJSONBody[createTenantRequest], func(ctx context.Context, request createTenantRequest) (tenantResponse, error) {
		if service == nil {
			return tenantResponse{}, apiErrorServiceUnavailable
		}
		serviceID, err := authorizeTenantCollection(ctx, authentication.ScopeTenantsWrite)
		if err != nil {
			return tenantResponse{}, err
		}
		input := request.input()
		input.CreatedByServiceID = serviceID
		input.ExternalID = request.ExternalID
		tenant, err := service.CreateTenant(ctx, input)
		if err != nil {
			return tenantResponse{}, err
		}

		return newTenantResponse(tenant), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		RequestBody("CreateTenantRequest", createTenantRequest{}).
		Responds(http.StatusCreated, "Tenant", tenantResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidTenantName,
			apiErrorInvalidTenantField,
			apiErrorInvalidTenantCORSOrigin,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(tenantEndpointAPIError)
}

func listTenantsEndpoint(service TenantService) Endpoint[listTenantsRequest, tenantListResponse] {
	return Get("/v1/tenants", "/tenants", "listTenants", decodeListTenantsRequest, func(ctx context.Context, request listTenantsRequest) (tenantListResponse, error) {
		if service == nil {
			return tenantListResponse{}, apiErrorServiceUnavailable
		}

		serviceID, err := authorizeTenantCollection(ctx, authentication.ScopeTenantsRead)
		if err != nil {
			return tenantListResponse{}, err
		}
		var list tenants.TenantList
		if serviceID == nil {
			list, err = service.ListTenants(ctx, request.Page)
		} else {
			list, err = service.ListServiceTenants(ctx, *serviceID, request.Page)
		}
		if err != nil {
			return tenantListResponse{}, err
		}

		response, err := newTenantListResponse(list)
		if err != nil {
			return tenantListResponse{}, err
		}

		return response, nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(
			APIParameterContract{Name: "page_size", In: "query", Type: "integer", Required: false},
			APIParameterContract{Name: "cursor", In: "query", Type: "string", Required: false},
		).
		Responds(http.StatusOK, "TenantList", tenantListResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidPageSize,
			apiErrorInvalidCursor,
			apiErrorInternal,
		).
		MapErrors(tenantEndpointAPIError)
}

func getTenantEndpoint(service TenantService, authorizer TenantAuthorizer) Endpoint[getTenantRequest, tenantResponse] {
	return Get("/v1/tenants/{tenant_id}", "/tenants/{tenant_id}", "getTenant", decodeGetTenantRequest, func(ctx context.Context, request getTenantRequest) (tenantResponse, error) {
		if service == nil {
			return tenantResponse{}, apiErrorServiceUnavailable
		}

		if err := authorizeTenant(ctx, authorizer, request.TenantID, readTenantPermission); err != nil {
			return tenantResponse{}, err
		}

		tenant, err := service.GetTenant(ctx, request.TenantID)
		if err != nil {
			return tenantResponse{}, err
		}

		return newTenantResponse(tenant), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(APIParameterContract{Name: "tenant_id", In: "path", Type: "string", Required: true}).
		Responds(http.StatusOK, "Tenant", tenantResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidTenantID,
			apiErrorTenantNotFound,
			apiErrorInternal,
		).
		MapErrors(tenantEndpointAPIError)
}

func updateTenantEndpoint(service TenantService, authorizer TenantAuthorizer) Endpoint[updateTenantEndpointRequest, tenantResponse] {
	return Patch("/v1/tenants/{tenant_id}", "/tenants/{tenant_id}", "updateTenant", decodeUpdateTenantRequest, func(ctx context.Context, request updateTenantEndpointRequest) (tenantResponse, error) {
		if service == nil {
			return tenantResponse{}, apiErrorServiceUnavailable
		}

		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeTenantPermission); err != nil {
			return tenantResponse{}, err
		}

		tenant, err := service.UpdateTenant(ctx, request.TenantID, request.Body.input())
		if err != nil {
			return tenantResponse{}, err
		}

		return newTenantResponse(tenant), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(APIParameterContract{Name: "tenant_id", In: "path", Type: "string", Required: true}).
		RequestBody("UpdateTenantRequest", updateTenantRequest{}).
		Responds(http.StatusOK, "Tenant", tenantResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidRequest,
			apiErrorInvalidTenantID,
			apiErrorInvalidTenantName,
			apiErrorInvalidTenantField,
			apiErrorInvalidTenantCORSOrigin,
			apiErrorTenantNotFound,
			apiErrorInvalidTenantArtifactPolicy,
			apiErrorTenantArtifactPolicyConflict,
			apiErrorRateLimited,
			apiErrorInternal,
		).
		MapErrors(tenantEndpointAPIError)
}

func decodeListTenantsRequest(r *http.Request) (listTenantsRequest, error) {
	page, err := parsePageRequest(r)
	if err != nil {
		return listTenantsRequest{}, paginationAPIError(err)
	}
	return listTenantsRequest{Page: page}, nil
}

func decodeGetTenantRequest(r *http.Request) (getTenantRequest, error) {
	tenantID, err := tenantIDFromRequest(r)
	if err != nil {
		return getTenantRequest{}, err
	}
	return getTenantRequest{TenantID: tenantID}, nil
}

func decodeUpdateTenantRequest(r *http.Request) (updateTenantEndpointRequest, error) {
	tenantID, err := tenantIDFromRequest(r)
	if err != nil {
		return updateTenantEndpointRequest{}, err
	}

	body, err := decodeJSONBody[updateTenantRequest](r)
	if err != nil {
		return updateTenantEndpointRequest{}, err
	}

	return updateTenantEndpointRequest{TenantID: tenantID, Body: body}, nil
}

func tenantIDFromRequest(r *http.Request) (utilities.ID, error) {
	id, err := utilities.ParseID(chi.URLParam(r, "tenant_id"))
	if err != nil {
		return utilities.ID{}, apiErrorInvalidTenantID
	}
	return id, nil
}

func tenantEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := errorAsAPIError(err); ok {
		return apiErr, true
	}
	if apiErr, ok := tenantServiceAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func tenantServiceAPIError(err error) (APIError, bool) {
	switch {
	case errors.Is(err, tenants.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, tenants.ErrInvalidTenantName):
		return apiErrorInvalidTenantName, true
	case errors.Is(err, tenants.ErrInvalidTenantField):
		return apiErrorInvalidTenantField, true
	case errors.Is(err, tenants.ErrInvalidCORSOrigin):
		return apiErrorInvalidTenantCORSOrigin, true
	case errors.Is(err, artifactpolicy.ErrDefaultExceedsCeiling):
		return apiErrorTenantArtifactPolicyConflict, true
	case errors.Is(err, artifactpolicy.ErrInvalidRecordingMode),
		errors.Is(err, artifactpolicy.ErrInvalidTranscriptionMode),
		errors.Is(err, artifactpolicy.ErrInvalidRetention),
		errors.Is(err, artifactpolicy.ErrInvalidSourceWindow),
		errors.Is(err, artifactpolicy.ErrMissingProviderPolicy),
		errors.Is(err, tenants.ErrInvalidArtifactPolicy):
		return apiErrorInvalidTenantArtifactPolicy, true
	case errors.Is(err, tenants.ErrTenantNotFound):
		return apiErrorTenantNotFound, true
	default:
		return APIError{}, false
	}
}

func newTenantListResponse(list tenants.TenantList) (tenantListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return tenantListResponse{}, err
	}

	response := tenantListResponse{
		Tenants:    make([]tenantResponse, 0, len(list.Tenants)),
		Pagination: page,
	}
	for _, tenant := range list.Tenants {
		response.Tenants = append(response.Tenants, newTenantResponse(tenant))
	}

	return response, nil
}

func newTenantResponse(tenant tenants.Tenant) tenantResponse {
	return tenantResponse{
		ID:         tenant.ID.String(),
		Name:       tenant.Name,
		ExternalID: tenant.ExternalID,

		DefaultMediaPlane:                tenant.DefaultMediaPlane,
		MediaPlaneProviderConfig:         utilities.RedactJSONSecrets(tenant.MediaPlaneProviderConfig),
		StorageProviderConfig:            utilities.RedactJSONSecrets(tenant.StorageProviderConfig),
		CORSAllowedOrigins:               append(make([]string, 0, len(tenant.CORSAllowedOrigins)), tenant.CORSAllowedOrigins...),
		LogoKey:                          tenant.LogoKey,
		Website:                          tenant.Website,
		TranscriptionCeiling:             tenant.ArtifactPolicy.TranscriptionCeiling,
		TranscriptionDefaultMode:         tenant.ArtifactPolicy.TranscriptionDefault,
		ProviderPolicyVersion:            tenant.ArtifactPolicy.ProviderPolicyVersion,
		RecordingRetentionSeconds:        int64(tenant.ArtifactPolicy.RecordingRetention / time.Second),
		TranscriptRetentionSeconds:       int64(tenant.ArtifactPolicy.TranscriptRetention / time.Second),
		TranscriptionSourceWindowSeconds: int64(tenant.ArtifactPolicy.TranscriptionSourceWindow / time.Second),
		UpdatedAt:                        utilities.FormatTimestamp(tenant.UpdatedAt),
		CreatedAt:                        utilities.FormatTimestamp(tenant.CreatedAt),
	}
}

func (r createTenantRequest) input() tenants.CreateTenantInput {
	return tenants.CreateTenantInput{
		Name: r.Name,

		DefaultMediaPlane:        r.DefaultMediaPlane,
		MediaPlaneProviderConfig: r.MediaPlaneProviderConfig,
		StorageProviderConfig:    r.StorageProviderConfig,
		CORSAllowedOrigins:       r.CORSAllowedOrigins,
		LogoKey:                  r.LogoKey,
		Website:                  r.Website,
	}
}

func (r updateTenantRequest) input() tenants.UpdateTenantInput {
	return tenants.UpdateTenantInput{
		Name: r.Name,

		DefaultMediaPlane:        r.DefaultMediaPlane,
		MediaPlaneProviderConfig: r.MediaPlaneProviderConfig,
		StorageProviderConfig:    r.StorageProviderConfig,
		CORSAllowedOrigins:       r.CORSAllowedOrigins,
		LogoKey:                  r.LogoKey,
		Website:                  r.Website,
		ArtifactPolicy: tenants.ArtifactPolicyUpdate{
			TranscriptionCeiling:             r.TranscriptionCeiling,
			TranscriptionDefaultMode:         r.TranscriptionDefaultMode,
			ProviderPolicyVersion:            r.ProviderPolicyVersion,
			RecordingRetentionSeconds:        r.RecordingRetentionSeconds,
			TranscriptRetentionSeconds:       r.TranscriptRetentionSeconds,
			TranscriptionSourceWindowSeconds: r.TranscriptionSourceWindowSeconds,
		},
	}
}

// Only System may enumerate all Tenants. Services always use their authenticated ID.
func authorizeTenantCollection(ctx context.Context, scope authentication.Scope) (*string, error) {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok || !principal.IsAuthenticated() {
		return nil, apiErrorUnauthenticated
	}
	if principal.Kind == authentication.PrincipalSystem {
		return nil, nil
	}
	if principal.Kind != authentication.PrincipalService || !principal.HasScope(scope) {
		return nil, apiErrorForbidden
	}
	return &principal.ServiceID, nil
}

type findServiceTenantRequest struct{ ExternalID string }

func findServiceTenantEndpoint(service TenantService) Endpoint[findServiceTenantRequest, tenantResponse] {
	return Get("/v1/tenants/by-external-id", "/tenants/by-external-id", "findTenantByExternalID", func(r *http.Request) (findServiceTenantRequest, error) {
		externalID := r.URL.Query().Get("external_id")
		if !tenants.ValidExternalID(externalID) {
			return findServiceTenantRequest{}, apiErrorInvalidTenantField
		}
		return findServiceTenantRequest{ExternalID: externalID}, nil
	}, func(ctx context.Context, request findServiceTenantRequest) (tenantResponse, error) {
		if service == nil {
			return tenantResponse{}, apiErrorServiceUnavailable
		}
		serviceID, err := authorizeTenantCollection(ctx, authentication.ScopeTenantsRead)
		if err != nil {
			return tenantResponse{}, err
		}
		if serviceID == nil {
			return tenantResponse{}, apiErrorForbidden
		}
		tenant, err := service.FindServiceTenant(ctx, *serviceID, request.ExternalID)
		if err != nil {
			return tenantResponse{}, err
		}
		return newTenantResponse(tenant), nil
	}).Auth(APIAuthSessionOrBearer).
		Parameters(APIParameterContract{Name: "external_id", In: "query", Type: "string", Required: true, MinLength: 1, MaxLength: 512}).
		Responds(http.StatusOK, "Tenant", tenantResponse{}).
		Errors(apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantField, apiErrorTenantNotFound, apiErrorInternal).
		MapErrors(tenantEndpointAPIError)
}
