package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recordings"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const maximumRecordingDownloadURLLifetime = 5 * time.Minute

var (
	readRecordingsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeRecordingsRead,
		MinimumRole: memberships.RoleObserver,
	}
)

type RecordingService interface {
	Get(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID) (recordings.Recording, error)
	List(ctx context.Context, tenantID utilities.ID, episodeID utilities.ID, page pagination.PageRequest) (recordings.RecordingList, error)
}

type RecordingDownloadService interface {
	CreateDownloadURL(ctx context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error)
}

type recordingResponse struct {
	ID              string  `json:"id"`
	TenantID        string  `json:"tenant_id"`
	SpaceID         string  `json:"space_id"`
	EpisodeID       string  `json:"episode_id"`
	Status          string  `json:"status"`
	StorageProvider string  `json:"storage_provider"`
	StorageKey      *string `json:"storage_key"`
	Metadata        any     `json:"metadata"`
	UpdatedAt       string  `json:"updated_at"`
	CreatedAt       string  `json:"created_at"`
}

type recordingListResponse struct {
	Recordings []recordingResponse `json:"recordings"`
	Pagination paginationResponse  `json:"pagination"`
}

type recordingDownloadURLResponse struct {
	Method       string              `json:"method"`
	URL          string              `json:"url"`
	SignedAt     string              `json:"signed_at"`
	ExpiresAt    string              `json:"expires_at"`
	SignedHeader map[string][]string `json:"signed_headers"`
}

type createRecordingDownloadURLRequest struct {
	ExpiresInSeconds int `json:"expires_in_seconds"`
}

type listRecordingsRequest struct {
	TenantID  utilities.ID
	EpisodeID utilities.ID
	Page      pagination.PageRequest
}

type getRecordingRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
}

type createRecordingDownloadURLEndpointRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
	Body        createRecordingDownloadURLRequest
}

func mountRecordingRoutes(r chi.Router, service RecordingService, downloads RecordingDownloadService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range recordingEndpoints(service, downloads, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func recordingEndpoints(service RecordingService, downloads RecordingDownloadService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		listRecordingsEndpoint(service, authorizer),
		getRecordingEndpoint(service, authorizer),
		createRecordingDownloadURLEndpoint(service, downloads, authorizer),
	}
}

func listRecordingsEndpoint(service RecordingService, authorizer TenantAuthorizer) Endpoint[listRecordingsRequest, recordingListResponse] {
	return Get("/v1/tenants/{tenant_id}/recordings", "/tenants/{tenant_id}/recordings", "listRecordings", decodeListRecordingsRequest, func(ctx context.Context, request listRecordingsRequest) (recordingListResponse, error) {
		if service == nil {
			return recordingListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRecordingsPermission); err != nil {
			return recordingListResponse{}, err
		}

		list, err := service.List(ctx, request.TenantID, request.EpisodeID, request.Page)
		if err != nil {
			return recordingListResponse{}, err
		}
		return newRecordingListResponse(list)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter(), episodeIDQueryParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "RecordingList", recordingListResponse{}).
		Errors(recordingReadErrors(apiErrorInvalidEpisodeID, apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
		MapErrors(recordingEndpointAPIError)
}

func getRecordingEndpoint(service RecordingService, authorizer TenantAuthorizer) Endpoint[getRecordingRequest, recordingResponse] {
	return Get("/v1/tenants/{tenant_id}/recordings/{recording_id}", "/tenants/{tenant_id}/recordings/{recording_id}", "getRecording", decodeGetRecordingRequest, func(ctx context.Context, request getRecordingRequest) (recordingResponse, error) {
		if service == nil {
			return recordingResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRecordingsPermission); err != nil {
			return recordingResponse{}, err
		}

		recording, err := service.Get(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return recordingResponse{}, err
		}
		return newRecordingResponse(recording), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter(), recordingIDParameter()).
		Responds(http.StatusOK, "Recording", recordingResponse{}).
		Errors(recordingReadErrors(apiErrorInvalidRecordingID, apiErrorRecordingNotFound)...).
		MapErrors(recordingEndpointAPIError)
}

func createRecordingDownloadURLEndpoint(service RecordingService, downloads RecordingDownloadService, authorizer TenantAuthorizer) Endpoint[createRecordingDownloadURLEndpointRequest, recordingDownloadURLResponse] {
	return Post("/v1/tenants/{tenant_id}/recordings/{recording_id}/download-url", "/tenants/{tenant_id}/recordings/{recording_id}/download-url", "createRecordingDownloadURL", decodeCreateRecordingDownloadURLRequest, func(ctx context.Context, request createRecordingDownloadURLEndpointRequest) (recordingDownloadURLResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRecordingsPermission); err != nil {
			return recordingDownloadURLResponse{}, err
		}
		if service == nil || downloads == nil {
			return recordingDownloadURLResponse{}, apiErrorServiceUnavailable
		}
		if request.Body.ExpiresInSeconds <= 0 || request.Body.ExpiresInSeconds > int(maximumRecordingDownloadURLLifetime/time.Second) {
			return recordingDownloadURLResponse{}, apiErrorInvalidURLExpiration
		}

		recording, err := service.Get(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return recordingDownloadURLResponse{}, err
		}
		if recording.Status != recordings.StatusCompleted || recording.StorageKey == nil {
			return recordingDownloadURLResponse{}, apiErrorRecordingNotReady
		}
		if recording.StorageProvider != recordings.StorageProviderR2 {
			return recordingDownloadURLResponse{}, apiErrorInvalidStorageProvider
		}
		if !recordings.TenantStorageKey(request.TenantID, recording.StorageKey) {
			return recordingDownloadURLResponse{}, apiErrorInvalidStorageKey
		}

		expiresIn := time.Duration(request.Body.ExpiresInSeconds) * time.Second
		url, err := downloads.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{Key: *recording.StorageKey, ExpiresIn: expiresIn})
		if err != nil {
			return recordingDownloadURLResponse{}, err
		}

		return recordingDownloadURLResponse{
			Method:       url.Method,
			URL:          url.URL,
			SignedAt:     utilities.FormatTimestamp(url.SignedAt),
			ExpiresAt:    utilities.FormatTimestamp(url.ExpiresAt),
			SignedHeader: url.SignedHeader,
		}, nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), recordingIDParameter()).
		RequestBody("CreateRecordingDownloadURLRequest", createRecordingDownloadURLRequest{}).
		Responds(http.StatusOK, "RecordingDownloadURL", recordingDownloadURLResponse{}).
		Errors(recordingReadErrors(apiErrorInvalidRequest, apiErrorInvalidRecordingID, apiErrorRecordingNotFound, apiErrorRecordingNotReady, apiErrorInvalidStorageProvider, apiErrorInvalidStorageKey, apiErrorInvalidURLExpiration, apiErrorRecordingArtifactNotFound, apiErrorRateLimited)...).
		MapErrors(recordingDownloadEndpointAPIError)
}

func decodeListRecordingsRequest(r *http.Request) (listRecordingsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listRecordingsRequest{}, err
	}
	episodeID, err := optionalEpisodeIDQuery(r)
	if err != nil {
		return listRecordingsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listRecordingsRequest{}, paginationAPIError(err)
	}
	return listRecordingsRequest{TenantID: tenantID, EpisodeID: episodeID, Page: page}, nil
}

func decodeGetRecordingRequest(r *http.Request) (getRecordingRequest, error) {
	tenantID, recordingID, err := tenantRecordingIDsRequest(r)
	if err != nil {
		return getRecordingRequest{}, err
	}
	return getRecordingRequest{TenantID: tenantID, RecordingID: recordingID}, nil
}

func decodeCreateRecordingDownloadURLRequest(r *http.Request) (createRecordingDownloadURLEndpointRequest, error) {
	tenantID, recordingID, err := tenantRecordingIDsRequest(r)
	if err != nil {
		return createRecordingDownloadURLEndpointRequest{}, err
	}
	body, err := decodeJSONBody[createRecordingDownloadURLRequest](r)
	if err != nil {
		return createRecordingDownloadURLEndpointRequest{}, err
	}
	return createRecordingDownloadURLEndpointRequest{TenantID: tenantID, RecordingID: recordingID, Body: body}, nil
}

func tenantRecordingIDsRequest(r *http.Request) (utilities.ID, utilities.ID, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	recordingID, err := recordingIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	return tenantID, recordingID, nil
}

func recordingReadErrors(extra ...APIError) []APIError {
	return append([]APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInternal,
	}, extra...)
}

func recordingEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := recordingServiceAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func recordingDownloadEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := recordingServiceAPIError(err); ok {
		return apiErr, true
	}
	if apiErr, ok := objectStorageAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func recordingServiceAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, recordings.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, recordings.ErrInvalidRecordingID):
		return apiErrorInvalidRecordingID, true
	case errors.Is(err, recordings.ErrInvalidSpaceID):
		return apiErrorInvalidSpaceID, true
	case errors.Is(err, recordings.ErrInvalidEpisodeID):
		return apiErrorInvalidEpisodeID, true
	case errors.Is(err, recordings.ErrInvalidRecordingStatus):
		return apiErrorInvalidRecordingStatus, true
	case errors.Is(err, recordings.ErrInvalidStorageProvider):
		return apiErrorInvalidStorageProvider, true
	case errors.Is(err, recordings.ErrInvalidStorageKey):
		return apiErrorInvalidStorageKey, true
	case errors.Is(err, recordings.ErrInvalidRecordingField):
		return apiErrorInvalidRecordingField, true
	case errors.Is(err, recordings.ErrEpisodeNotFound):
		return apiErrorEpisodeNotFound, true
	case errors.Is(err, recordings.ErrRecordingNotFound):
		return apiErrorRecordingNotFound, true
	default:
		return APIError{}, false
	}
}

func objectStorageAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, objectstorage.ErrInvalidObjectKey):
		return apiErrorInvalidStorageKey, true
	case errors.Is(err, objectstorage.ErrInvalidURLExpiration):
		return apiErrorInvalidURLExpiration, true
	case errors.Is(err, objectstorage.ErrStoreUnavailable):
		return apiErrorServiceUnavailable, true
	case errors.Is(err, objectstorage.ErrObjectNotFound):
		return apiErrorRecordingArtifactNotFound, true
	default:
		return APIError{}, false
	}
}

func newRecordingListResponse(list recordings.RecordingList) (recordingListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return recordingListResponse{}, err
	}

	response := recordingListResponse{Recordings: make([]recordingResponse, 0, len(list.Recordings)), Pagination: page}
	for _, recording := range list.Recordings {
		response.Recordings = append(response.Recordings, newRecordingResponse(recording))
	}
	return response, nil
}

func newRecordingResponse(recording recordings.Recording) recordingResponse {
	return recordingResponse{
		ID:              recording.ID.String(),
		TenantID:        recording.TenantID.String(),
		SpaceID:         recording.SpaceID.String(),
		EpisodeID:       recording.EpisodeID.String(),
		Status:          recording.Status,
		StorageProvider: recording.StorageProvider,
		StorageKey:      recording.StorageKey,
		Metadata:        rawJSONValue(recording.Metadata),
		UpdatedAt:       utilities.FormatTimestamp(recording.UpdatedAt),
		CreatedAt:       utilities.FormatTimestamp(recording.CreatedAt),
	}
}
