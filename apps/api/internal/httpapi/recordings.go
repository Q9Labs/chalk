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

var (
	readRecordingsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeRecordingsRead,
		MinimumRole: memberships.RoleViewer,
	}
	writeRecordingsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeRecordingsWrite,
		MinimumRole: memberships.RoleMember,
	}
)

type RecordingService interface {
	Create(ctx context.Context, input recordings.CreateInput) (recordings.Recording, error)
	Get(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID) (recordings.Recording, error)
	List(ctx context.Context, tenantID utilities.ID, sessionID utilities.ID, page pagination.PageRequest) (recordings.RecordingList, error)
	Update(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, input recordings.UpdateInput) (recordings.Recording, error)
}

type RecordingDownloadService interface {
	CreateDownloadURL(ctx context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error)
}

type recordingResponse struct {
	ID              string  `json:"id"`
	TenantID        string  `json:"tenant_id"`
	RoomID          string  `json:"room_id"`
	SessionID       string  `json:"session_id"`
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

type createRecordingRequest struct {
	Status          string                 `json:"status"`
	StorageProvider string                 `json:"storage_provider"`
	StorageKey      *string                `json:"storage_key"`
	Metadata        utilities.OptionalJSON `json:"metadata"`
}

type updateRecordingRequest struct {
	Status          utilities.OptionalString `json:"status"`
	StorageProvider utilities.OptionalString `json:"storage_provider"`
	StorageKey      utilities.OptionalString `json:"storage_key"`
	Metadata        utilities.OptionalJSON   `json:"metadata"`
}

type createRecordingDownloadURLRequest struct {
	ExpiresInSeconds int `json:"expires_in_seconds"`
}

type createRecordingEndpointRequest struct {
	TenantID  utilities.ID
	RoomID    utilities.ID
	SessionID utilities.ID
	Body      createRecordingRequest
}

type listRecordingsRequest struct {
	TenantID  utilities.ID
	SessionID utilities.ID
	Page      pagination.PageRequest
}

type getRecordingRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
}

type updateRecordingEndpointRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
	Body        updateRecordingRequest
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
		createRecordingEndpoint(service, authorizer),
		listRecordingsEndpoint(service, authorizer),
		getRecordingEndpoint(service, authorizer),
		updateRecordingEndpoint(service, authorizer),
		createRecordingDownloadURLEndpoint(service, downloads, authorizer),
	}
}

func createRecordingEndpoint(service RecordingService, authorizer TenantAuthorizer) Endpoint[createRecordingEndpointRequest, recordingResponse] {
	return Post("/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/recordings", "/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/recordings", "createRecording", decodeCreateRecordingRequest, func(ctx context.Context, request createRecordingEndpointRequest) (recordingResponse, error) {
		if service == nil {
			return recordingResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeRecordingsPermission); err != nil {
			return recordingResponse{}, err
		}

		recording, err := service.Create(ctx, recordings.CreateInput{
			TenantID:        request.TenantID,
			RoomID:          request.RoomID,
			SessionID:       request.SessionID,
			Status:          request.Body.Status,
			StorageProvider: request.Body.StorageProvider,
			StorageKey:      request.Body.StorageKey,
			Metadata:        request.Body.Metadata.Value,
		})
		if err != nil {
			return recordingResponse{}, err
		}
		return newRecordingResponse(recording), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), roomIDParameter(), sessionIDParameter()).
		RequestBody("CreateRecordingRequest", createRecordingRequest{}).
		Responds(http.StatusCreated, "Recording", recordingResponse{}).
		Errors(recordingWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidRecordingStatus, apiErrorInvalidStorageProvider, apiErrorInvalidStorageKey, apiErrorInvalidRecordingField, apiErrorSessionNotFound, apiErrorRateLimited)...).
		MapErrors(recordingEndpointAPIError)
}

func listRecordingsEndpoint(service RecordingService, authorizer TenantAuthorizer) Endpoint[listRecordingsRequest, recordingListResponse] {
	return Get("/v1/tenants/{tenant_id}/recordings", "/tenants/{tenant_id}/recordings", "listRecordings", decodeListRecordingsRequest, func(ctx context.Context, request listRecordingsRequest) (recordingListResponse, error) {
		if service == nil {
			return recordingListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRecordingsPermission); err != nil {
			return recordingListResponse{}, err
		}

		list, err := service.List(ctx, request.TenantID, request.SessionID, request.Page)
		if err != nil {
			return recordingListResponse{}, err
		}
		return newRecordingListResponse(list)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter(), sessionIDQueryParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "RecordingList", recordingListResponse{}).
		Errors(recordingReadErrors(apiErrorInvalidSessionID, apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
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

func updateRecordingEndpoint(service RecordingService, authorizer TenantAuthorizer) Endpoint[updateRecordingEndpointRequest, recordingResponse] {
	return Patch("/v1/tenants/{tenant_id}/recordings/{recording_id}", "/tenants/{tenant_id}/recordings/{recording_id}", "updateRecording", decodeUpdateRecordingRequest, func(ctx context.Context, request updateRecordingEndpointRequest) (recordingResponse, error) {
		if service == nil {
			return recordingResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeRecordingsPermission); err != nil {
			return recordingResponse{}, err
		}

		recording, err := service.Update(ctx, request.TenantID, request.RecordingID, recordings.UpdateInput{
			Status:          request.Body.Status,
			StorageProvider: request.Body.StorageProvider,
			StorageKey:      request.Body.StorageKey,
			Metadata:        request.Body.Metadata,
		})
		if err != nil {
			return recordingResponse{}, err
		}
		return newRecordingResponse(recording), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), recordingIDParameter()).
		RequestBody("UpdateRecordingRequest", updateRecordingRequest{}).
		Responds(http.StatusOK, "Recording", recordingResponse{}).
		Errors(recordingWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRecordingID, apiErrorInvalidRecordingStatus, apiErrorInvalidStorageProvider, apiErrorInvalidStorageKey, apiErrorInvalidRecordingField, apiErrorRecordingNotFound, apiErrorRateLimited)...).
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

func decodeCreateRecordingRequest(r *http.Request) (createRecordingEndpointRequest, error) {
	tenantID, roomID, sessionID, err := tenantRoomSessionIDsRequest(r)
	if err != nil {
		return createRecordingEndpointRequest{}, err
	}
	body, err := decodeJSONBody[createRecordingRequest](r)
	if err != nil {
		return createRecordingEndpointRequest{}, err
	}
	return createRecordingEndpointRequest{TenantID: tenantID, RoomID: roomID, SessionID: sessionID, Body: body}, nil
}

func decodeListRecordingsRequest(r *http.Request) (listRecordingsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listRecordingsRequest{}, err
	}
	sessionID, err := optionalSessionIDQuery(r)
	if err != nil {
		return listRecordingsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listRecordingsRequest{}, paginationAPIError(err)
	}
	return listRecordingsRequest{TenantID: tenantID, SessionID: sessionID, Page: page}, nil
}

func decodeGetRecordingRequest(r *http.Request) (getRecordingRequest, error) {
	tenantID, recordingID, err := tenantRecordingIDsRequest(r)
	if err != nil {
		return getRecordingRequest{}, err
	}
	return getRecordingRequest{TenantID: tenantID, RecordingID: recordingID}, nil
}

func decodeUpdateRecordingRequest(r *http.Request) (updateRecordingEndpointRequest, error) {
	tenantID, recordingID, err := tenantRecordingIDsRequest(r)
	if err != nil {
		return updateRecordingEndpointRequest{}, err
	}
	body, err := decodeJSONBody[updateRecordingRequest](r)
	if err != nil {
		return updateRecordingEndpointRequest{}, err
	}
	return updateRecordingEndpointRequest{TenantID: tenantID, RecordingID: recordingID, Body: body}, nil
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

func recordingWriteErrors(extra ...APIError) []APIError {
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
	case errors.Is(err, recordings.ErrInvalidRoomID):
		return apiErrorInvalidRoomID, true
	case errors.Is(err, recordings.ErrInvalidSessionID):
		return apiErrorInvalidSessionID, true
	case errors.Is(err, recordings.ErrInvalidRecordingStatus):
		return apiErrorInvalidRecordingStatus, true
	case errors.Is(err, recordings.ErrInvalidStorageProvider):
		return apiErrorInvalidStorageProvider, true
	case errors.Is(err, recordings.ErrInvalidStorageKey):
		return apiErrorInvalidStorageKey, true
	case errors.Is(err, recordings.ErrInvalidRecordingField):
		return apiErrorInvalidRecordingField, true
	case errors.Is(err, recordings.ErrSessionNotFound):
		return apiErrorSessionNotFound, true
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
		RoomID:          recording.RoomID.String(),
		SessionID:       recording.SessionID.String(),
		Status:          recording.Status,
		StorageProvider: recording.StorageProvider,
		StorageKey:      recording.StorageKey,
		Metadata:        rawJSONValue(recording.Metadata),
		UpdatedAt:       utilities.FormatTimestamp(recording.UpdatedAt),
		CreatedAt:       utilities.FormatTimestamp(recording.CreatedAt),
	}
}
