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

func mountRecordingRoutes(r chi.Router, service RecordingService, downloads RecordingDownloadService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Post("/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/recordings", handleCreateRecording(service, authorizer))
	r.Get("/tenants/{tenant_id}/recordings", handleListRecordings(service, authorizer))
	r.Get("/tenants/{tenant_id}/recordings/{recording_id}", handleGetRecording(service, authorizer))
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Patch("/tenants/{tenant_id}/recordings/{recording_id}", handleUpdateRecording(service, authorizer))
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Post("/tenants/{tenant_id}/recordings/{recording_id}/download-url", handleCreateRecordingDownloadURL(service, downloads, authorizer))
}

func handleCreateRecording(service RecordingService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, roomID, sessionID, ok := tenantRoomSessionIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, writeRecordingsPermission) {
			return
		}

		var request createRecordingRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		recording, err := service.Create(r.Context(), request.toCreateInput(tenantID, roomID, sessionID))
		if writeRecordingServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusCreated, newRecordingResponse(recording))
	}
}

func handleListRecordings(service RecordingService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readRecordingsPermission) {
			return
		}

		sessionID, ok := optionalQueryID(w, r, "session_id", "invalid_session_id", "Invalid session id")
		if !ok {
			return
		}
		page, err := parsePageRequest(r)
		if writePaginationError(w, err) {
			return
		}

		list, err := service.List(r.Context(), tenantID, sessionID, page)
		if writeRecordingServiceError(w, err) {
			return
		}

		response, err := newRecordingListResponse(list)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

func handleGetRecording(service RecordingService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, recordingID, ok := tenantRecordingIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readRecordingsPermission) {
			return
		}

		recording, err := service.Get(r.Context(), tenantID, recordingID)
		if writeRecordingServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newRecordingResponse(recording))
	}
}

func handleUpdateRecording(service RecordingService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, recordingID, ok := tenantRecordingIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, writeRecordingsPermission) {
			return
		}

		var request updateRecordingRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		recording, err := service.Update(r.Context(), tenantID, recordingID, request.toUpdateInput())
		if writeRecordingServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newRecordingResponse(recording))
	}
}

func handleCreateRecordingDownloadURL(service RecordingService, downloads RecordingDownloadService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenantID, recordingID, ok := tenantRecordingIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readRecordingsPermission) {
			return
		}
		if service == nil || downloads == nil {
			writeServiceUnavailable(w)
			return
		}

		var request createRecordingDownloadURLRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		recording, err := service.Get(r.Context(), tenantID, recordingID)
		if writeRecordingServiceError(w, err) {
			return
		}
		if recording.Status != recordings.StatusCompleted || recording.StorageKey == nil {
			writeError(w, http.StatusBadRequest, "recording_not_ready", "Recording is not ready for download")
			return
		}
		if recording.StorageProvider != recordings.StorageProviderR2 {
			writeError(w, http.StatusBadRequest, "invalid_storage_provider", "Invalid storage provider")
			return
		}
		if !recordings.TenantStorageKey(tenantID, recording.StorageKey) {
			writeError(w, http.StatusBadRequest, "invalid_storage_key", "Invalid storage key")
			return
		}

		expiresIn := time.Duration(request.ExpiresInSeconds) * time.Second
		url, err := downloads.CreateDownloadURL(r.Context(), objectstorage.CreateDownloadURLInput{Key: *recording.StorageKey, ExpiresIn: expiresIn})
		if writeObjectStorageError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, recordingDownloadURLResponse{
			Method:       url.Method,
			URL:          url.URL,
			SignedAt:     utilities.FormatTimestamp(url.SignedAt),
			ExpiresAt:    utilities.FormatTimestamp(url.ExpiresAt),
			SignedHeader: url.SignedHeader,
		})
	}
}

func writeRecordingServiceError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, recordings.ErrInvalidTenantID):
		writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
	case errors.Is(err, recordings.ErrInvalidRecordingID):
		writeError(w, http.StatusBadRequest, "invalid_recording_id", "Invalid recording id")
	case errors.Is(err, recordings.ErrInvalidRoomID):
		writeError(w, http.StatusBadRequest, "invalid_room_id", "Invalid room id")
	case errors.Is(err, recordings.ErrInvalidSessionID):
		writeError(w, http.StatusBadRequest, "invalid_session_id", "Invalid session id")
	case errors.Is(err, recordings.ErrInvalidRecordingStatus):
		writeError(w, http.StatusBadRequest, "invalid_recording_status", "Invalid recording status")
	case errors.Is(err, recordings.ErrInvalidStorageProvider):
		writeError(w, http.StatusBadRequest, "invalid_storage_provider", "Invalid storage provider")
	case errors.Is(err, recordings.ErrInvalidStorageKey):
		writeError(w, http.StatusBadRequest, "invalid_storage_key", "Invalid storage key")
	case errors.Is(err, recordings.ErrInvalidRecordingField):
		writeError(w, http.StatusBadRequest, "invalid_recording_field", "Invalid recording field")
	case errors.Is(err, recordings.ErrSessionNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Room session not found")
	case errors.Is(err, recordings.ErrRecordingNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Recording not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}
	return true
}

func writeObjectStorageError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, objectstorage.ErrInvalidObjectKey):
		writeError(w, http.StatusBadRequest, "invalid_storage_key", "Invalid storage key")
	case errors.Is(err, objectstorage.ErrInvalidURLExpiration):
		writeError(w, http.StatusBadRequest, "invalid_url_expiration", "Invalid url expiration")
	case errors.Is(err, objectstorage.ErrStoreUnavailable):
		writeServiceUnavailable(w)
	case errors.Is(err, objectstorage.ErrObjectNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Recording artifact not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}
	return true
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

func (r createRecordingRequest) toCreateInput(tenantID utilities.ID, roomID utilities.ID, sessionID utilities.ID) recordings.CreateInput {
	return recordings.CreateInput{
		TenantID:        tenantID,
		RoomID:          roomID,
		SessionID:       sessionID,
		Status:          r.Status,
		StorageProvider: r.StorageProvider,
		StorageKey:      r.StorageKey,
		Metadata:        r.Metadata.Value,
	}
}

func (r updateRecordingRequest) toUpdateInput() recordings.UpdateInput {
	return recordings.UpdateInput{
		Status:          r.Status,
		StorageProvider: r.StorageProvider,
		StorageKey:      r.StorageKey,
		Metadata:        r.Metadata,
	}
}

func tenantRecordingIDs(w http.ResponseWriter, r *http.Request) (utilities.ID, utilities.ID, bool) {
	tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
	if !ok {
		return utilities.ID{}, utilities.ID{}, false
	}
	recordingID, ok := parseRouteID(w, r, "recording_id", "invalid_recording_id", "Invalid recording id")
	if !ok {
		return utilities.ID{}, utilities.ID{}, false
	}
	return tenantID, recordingID, true
}
