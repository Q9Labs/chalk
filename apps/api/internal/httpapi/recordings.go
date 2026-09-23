package httpapi

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
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
	List(ctx context.Context, tenantID utilities.ID, spaceID utilities.ID, episodeID utilities.ID, page pagination.PageRequest) (recordings.RecordingList, error)
}

type RecordingDownloadService interface {
	CreateDownloadURL(ctx context.Context, input objectstorage.CreateDownloadURLInput) (objectstorage.SignedURL, error)
}

// RecordingExportService owns the durable, idempotent transition from sealed
// capture inputs to the one canonical MP4 export. It is deliberately separate
// from Recording reads so Episode policy remains immutable.
type RecordingExportService interface {
	RequestExport(context.Context, recordingpipeline.ExportInput) (recordingpipeline.Job, error)
	GetArtifactState(context.Context, utilities.ID, utilities.ID) (recordingpipeline.ArtifactState, error)
}

type recordingArtifactStateBatchService interface {
	GetArtifactStates(context.Context, utilities.ID, []utilities.ID) (map[utilities.ID]recordingpipeline.ArtifactState, error)
}

type recordingResponse struct {
	ID                       string                                    `json:"id"`
	TenantID                 string                                    `json:"tenant_id"`
	SpaceID                  string                                    `json:"space_id"`
	EpisodeID                string                                    `json:"episode_id"`
	Status                   string                                    `json:"status"`
	StorageProvider          string                                    `json:"storage_provider"`
	StorageKey               *string                                   `json:"storage_key"`
	Metadata                 any                                       `json:"metadata"`
	Source                   recordingSourceResponse                   `json:"source"`
	Export                   recordingExportResponse                   `json:"export"`
	TranscriptionPolicy      artifactpolicy.TranscriptionMode          `json:"transcription_policy"`
	TranscriptionPreparation recordingTranscriptionPreparationResponse `json:"transcription_preparation"`
	UpdatedAt                string                                    `json:"updated_at"`
	CreatedAt                string                                    `json:"created_at"`
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

type recordingExportResponse struct {
	JobID           string  `json:"job_id,omitempty"`
	Status          string  `json:"status"`
	Retryable       bool    `json:"retryable"`
	SourceExpiresAt *string `json:"source_expires_at,omitempty"`
	FailureCode     *string `json:"failure_code,omitempty"`
	FailureMessage  *string `json:"failure_message,omitempty"`
}

type recordingSourceResponse struct {
	Status    string  `json:"status"`
	ExpiresAt *string `json:"expires_at,omitempty"`
}

type recordingTranscriptionPreparationResponse struct {
	Status recordingpipeline.TranscriptionPreparationStatus `json:"status"`
}

type requestRecordingExportResponse struct {
	Recording recordingResponse       `json:"recording"`
	Export    recordingExportResponse `json:"export"`
}

type createRecordingDownloadURLRequest struct {
	ExpiresInSeconds int  `json:"expires_in_seconds"`
	Download         bool `json:"download,omitempty"`
}

type listRecordingsRequest struct {
	TenantID  utilities.ID
	SpaceID   utilities.ID
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

type requestRecordingExportEndpointRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
}

func mountRecordingRoutes(r chi.Router, service RecordingService, exports RecordingExportService, downloads RecordingDownloadService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range recordingEndpoints(service, exports, downloads, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func recordingEndpoints(service RecordingService, exports RecordingExportService, downloads RecordingDownloadService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		listRecordingsEndpoint(service, exports, authorizer),
		getRecordingEndpoint(service, exports, authorizer),
		requestRecordingExportEndpoint(service, exports, authorizer),
		createRecordingDownloadURLEndpoint(service, exports, downloads, authorizer),
	}
}

func requestRecordingExportEndpoint(service RecordingService, exports RecordingExportService, authorizer TenantAuthorizer) Endpoint[requestRecordingExportEndpointRequest, requestRecordingExportResponse] {
	return Post("/v1/tenants/{tenant_id}/recordings/{recording_id}/export", "/tenants/{tenant_id}/recordings/{recording_id}/export", "requestRecordingExport", decodeRequestRecordingExportEndpointRequest, func(ctx context.Context, request requestRecordingExportEndpointRequest) (requestRecordingExportResponse, error) {
		if service == nil || exports == nil {
			return requestRecordingExportResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRecordingsPermission); err != nil {
			return requestRecordingExportResponse{}, err
		}
		recording, err := service.Get(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return requestRecordingExportResponse{}, err
		}
		state, err := exports.GetArtifactState(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return requestRecordingExportResponse{}, err
		}
		if state.ExportStatus != recordingpipeline.ExportStatusReady && state.ExportStatus != recordingpipeline.ExportStatusUnavailable && state.ExportStatus != recordingpipeline.ExportStatusFailed {
			if _, err := exports.RequestExport(ctx, recordingpipeline.ExportInput{TenantID: request.TenantID, RecordingID: request.RecordingID}); err != nil {
				return requestRecordingExportResponse{}, err
			}
			state, err = exports.GetArtifactState(ctx, request.TenantID, request.RecordingID)
			if err != nil {
				return requestRecordingExportResponse{}, err
			}
		}
		response := newRecordingResponse(recording, state)
		return requestRecordingExportResponse{Recording: response, Export: response.Export}, nil
	}).Auth(APIAuthCookieOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), recordingIDParameter()).RequestBody("RequestRecordingExportRequest", struct{}{}).Responds(http.StatusAccepted, "RecordingExportRequestAcceptedResponse", requestRecordingExportResponse{}).Errors(recordingReadErrors(apiErrorInvalidRecordingID, apiErrorRecordingNotFound, apiErrorRecordingNotReady, apiErrorRateLimited)...).MapErrors(recordingEndpointAPIError)
}

func decodeRequestRecordingExportEndpointRequest(r *http.Request) (requestRecordingExportEndpointRequest, error) {
	tenantID, recordingID, err := tenantRecordingIDsRequest(r)
	if err != nil {
		return requestRecordingExportEndpointRequest{}, err
	}
	if _, err := decodeJSONBody[struct{}](r); err != nil {
		return requestRecordingExportEndpointRequest{}, err
	}
	return requestRecordingExportEndpointRequest{TenantID: tenantID, RecordingID: recordingID}, nil
}

func listRecordingsEndpoint(service RecordingService, artifacts RecordingExportService, authorizer TenantAuthorizer) Endpoint[listRecordingsRequest, recordingListResponse] {
	return Get("/v1/tenants/{tenant_id}/recordings", "/tenants/{tenant_id}/recordings", "listRecordings", decodeListRecordingsRequest, func(ctx context.Context, request listRecordingsRequest) (recordingListResponse, error) {
		if service == nil || artifacts == nil {
			return recordingListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRecordingsPermission); err != nil {
			return recordingListResponse{}, err
		}

		list, err := service.List(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.Page)
		if err != nil {
			return recordingListResponse{}, err
		}
		return newRecordingListResponse(ctx, list, artifacts)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter(), spaceIDQueryParameter(), episodeIDQueryParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "RecordingList", recordingListResponse{}).
		Errors(recordingReadErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
		MapErrors(recordingEndpointAPIError)
}

func getRecordingEndpoint(service RecordingService, artifacts RecordingExportService, authorizer TenantAuthorizer) Endpoint[getRecordingRequest, recordingResponse] {
	return Get("/v1/tenants/{tenant_id}/recordings/{recording_id}", "/tenants/{tenant_id}/recordings/{recording_id}", "getRecording", decodeGetRecordingRequest, func(ctx context.Context, request getRecordingRequest) (recordingResponse, error) {
		if service == nil || artifacts == nil {
			return recordingResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRecordingsPermission); err != nil {
			return recordingResponse{}, err
		}

		recording, err := service.Get(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return recordingResponse{}, err
		}
		state, err := artifacts.GetArtifactState(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return recordingResponse{}, err
		}
		return newRecordingResponse(recording, state), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter(), recordingIDParameter()).
		Responds(http.StatusOK, "Recording", recordingResponse{}).
		Errors(recordingReadErrors(apiErrorInvalidRecordingID, apiErrorRecordingNotFound)...).
		MapErrors(recordingEndpointAPIError)
}

func createRecordingDownloadURLEndpoint(service RecordingService, exports RecordingExportService, downloads RecordingDownloadService, authorizer TenantAuthorizer) Endpoint[createRecordingDownloadURLEndpointRequest, recordingDownloadURLResponse] {
	return Post("/v1/tenants/{tenant_id}/recordings/{recording_id}/download-url", "/tenants/{tenant_id}/recordings/{recording_id}/download-url", "createRecordingDownloadURL", decodeCreateRecordingDownloadURLRequest, func(ctx context.Context, request createRecordingDownloadURLEndpointRequest) (recordingDownloadURLResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readRecordingsPermission); err != nil {
			return recordingDownloadURLResponse{}, err
		}
		if service == nil || exports == nil || downloads == nil {
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
		state, err := exports.GetArtifactState(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return recordingDownloadURLResponse{}, err
		}
		if state.ExportStatus != recordingpipeline.ExportStatusReady {
			return recordingDownloadURLResponse{}, apiErrorRecordingNotReady
		}
		if recording.StorageProvider != recordings.StorageProviderR2 {
			return recordingDownloadURLResponse{}, apiErrorInvalidStorageProvider
		}
		if !recordings.TenantStorageKey(request.TenantID, recording.StorageKey) {
			return recordingDownloadURLResponse{}, apiErrorInvalidStorageKey
		}

		expiresIn := time.Duration(request.Body.ExpiresInSeconds) * time.Second
		input := objectstorage.CreateDownloadURLInput{Key: *recording.StorageKey, ExpiresIn: expiresIn}
		if request.Body.Download {
			input.ContentDisposition = mime.FormatMediaType("attachment", map[string]string{"filename": "recording-" + recording.ID.String() + ".mp4"})
		}
		url, err := downloads.CreateDownloadURL(ctx, input)
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
	spaceID, err := optionalSpaceIDQuery(r)
	if err != nil {
		return listRecordingsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listRecordingsRequest{}, paginationAPIError(err)
	}
	return listRecordingsRequest{TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, Page: page}, nil
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
	case errors.Is(err, recordingpipeline.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, recordingpipeline.ErrInvalidRecordingID):
		return apiErrorInvalidRecordingID, true
	case errors.Is(err, recordingpipeline.ErrPipelineNotFound):
		return apiErrorRecordingNotFound, true
	case errors.Is(err, recordingpipeline.ErrExportUnavailable):
		return apiErrorRecordingNotReady, true
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

func newRecordingListResponse(ctx context.Context, list recordings.RecordingList, artifacts RecordingExportService) (recordingListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return recordingListResponse{}, err
	}

	states := make(map[utilities.ID]recordingpipeline.ArtifactState, len(list.Recordings))
	if batch, ok := artifacts.(recordingArtifactStateBatchService); ok && len(list.Recordings) > 0 {
		recordingIDs := make([]utilities.ID, 0, len(list.Recordings))
		for _, recording := range list.Recordings {
			recordingIDs = append(recordingIDs, recording.ID)
		}
		states, err = batch.GetArtifactStates(ctx, list.Recordings[0].TenantID, recordingIDs)
		if err != nil {
			return recordingListResponse{}, err
		}
	} else {
		for _, recording := range list.Recordings {
			state, stateErr := artifacts.GetArtifactState(ctx, recording.TenantID, recording.ID)
			if stateErr != nil {
				return recordingListResponse{}, stateErr
			}
			states[recording.ID] = state
		}
	}

	response := recordingListResponse{Recordings: make([]recordingResponse, 0, len(list.Recordings)), Pagination: page}
	for _, recording := range list.Recordings {
		state, ok := states[recording.ID]
		if !ok {
			return recordingListResponse{}, recordingpipeline.ErrPipelineNotFound
		}
		response.Recordings = append(response.Recordings, newRecordingResponse(recording, state))
	}
	return response, nil
}

func newRecordingResponse(recording recordings.Recording, state recordingpipeline.ArtifactState) recordingResponse {
	return recordingResponse{
		ID:                       recording.ID.String(),
		TenantID:                 recording.TenantID.String(),
		SpaceID:                  recording.SpaceID.String(),
		EpisodeID:                recording.EpisodeID.String(),
		Status:                   recording.Status,
		StorageProvider:          recording.StorageProvider,
		StorageKey:               recording.StorageKey,
		Metadata:                 rawJSONValue(recording.Metadata),
		Source:                   newRecordingSourceResponse(state),
		Export:                   newRecordingExportResponse(state),
		TranscriptionPolicy:      state.TranscriptionPolicy,
		TranscriptionPreparation: recordingTranscriptionPreparationResponse{Status: state.TranscriptionPreparationStatus},
		UpdatedAt:                utilities.FormatTimestamp(recording.UpdatedAt),
		CreatedAt:                utilities.FormatTimestamp(recording.CreatedAt),
	}
}

func newRecordingSourceResponse(state recordingpipeline.ArtifactState) recordingSourceResponse {
	response := recordingSourceResponse{Status: string(state.SourceStatus)}
	if state.SourceExpiresAt != nil {
		expiresAt := utilities.FormatTimestamp(*state.SourceExpiresAt)
		response.ExpiresAt = &expiresAt
	}
	return response
}

func newRecordingExportResponse(state recordingpipeline.ArtifactState) recordingExportResponse {
	response := recordingExportResponse{Status: string(state.ExportStatus), Retryable: state.Retryable}
	if state.ExportJobID != nil {
		response.JobID = state.ExportJobID.String()
	}
	if state.SourceExpiresAt != nil {
		expiresAt := utilities.FormatTimestamp(*state.SourceExpiresAt)
		response.SourceExpiresAt = &expiresAt
	}
	if state.FailureCode != "" {
		failureCode := state.FailureCode
		response.FailureCode = &failureCode
	}
	if state.FailureMessage != "" {
		failureMessage := state.FailureMessage
		response.FailureMessage = &failureMessage
	}
	return response
}
