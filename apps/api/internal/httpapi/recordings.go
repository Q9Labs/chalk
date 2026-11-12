package httpapi

import (
	"context"
	"mime"
	"net/http"
	"time"

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

const maximumArtifactDownloadURLLifetime = 5 * time.Minute

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
	StopReason string  `json:"stop_reason,omitempty"`
	Status     string  `json:"status"`
	ExpiresAt  *string `json:"expires_at,omitempty"`
}

type recordingTranscriptionPreparationResponse struct {
	Status      recordingpipeline.TranscriptionPreparationStatus `json:"status"`
	ExpiresAt   *string                                          `json:"expires_at,omitempty"`
	FailureCode string                                           `json:"failure_code,omitempty"`
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

func recordingEndpoints(service RecordingService, exports RecordingExportService, downloads RecordingDownloadService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		listRecordingsEndpoint(service, exports, authorizer),
		getRecordingEndpoint(service, exports, authorizer),
		requestRecordingExportEndpoint(service, exports, authorizer),
		createRecordingDownloadURLEndpoint(service, exports, downloads, authorizer),
	}
}

func requestRecordingExportEndpoint(service RecordingService, exports RecordingExportService, authorizer TenantAuthorizer) Endpoint[requestRecordingExportEndpointRequest, requestRecordingExportResponse] {
	return Post("/v1/tenants/{tenant_id}/recordings/{recording_id}/export", "requestRecordingExport", decodeRequestRecordingExportEndpointRequest, func(ctx context.Context, request requestRecordingExportEndpointRequest) (requestRecordingExportResponse, error) {
		recording, err := service.Get(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return requestRecordingExportResponse{}, err
		}
		state, err := exports.GetArtifactState(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return requestRecordingExportResponse{}, err
		}
		if state.ExportStatus != recordingpipeline.ExportStatusReady && state.ExportStatus != recordingpipeline.ExportStatusUnavailable {
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
	}).Needs(service, exports).Permission(authorizer, readRecordingsPermission).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), recordingIDParameter()).RequestBody("RequestRecordingExportRequest", struct{}{}).Responds(http.StatusAccepted, "RecordingExportRequestAcceptedResponse", requestRecordingExportResponse{}).Errors(recordingReadErrors(apiErrorInvalidRecordingID, apiErrorRecordingNotFound, apiErrorRecordingNotReady, apiErrorRecordingExportRetryLimit, apiErrorRateLimited)...).ErrorRules(recordingRules)
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
	return Get("/v1/tenants/{tenant_id}/recordings", "listRecordings", decodeListRecordingsRequest, func(ctx context.Context, request listRecordingsRequest) (recordingListResponse, error) {

		list, err := service.List(ctx, request.TenantID, request.SpaceID, request.EpisodeID, request.Page)
		if err != nil {
			return recordingListResponse{}, err
		}
		return newRecordingListResponse(ctx, list, artifacts)
	}).Needs(service, artifacts).Permission(authorizer, readRecordingsPermission).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter(), spaceIDQueryParameter(), episodeIDQueryParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "RecordingList", recordingListResponse{}).
		Errors(recordingReadErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
		ErrorRules(recordingRules)
}

func getRecordingEndpoint(service RecordingService, artifacts RecordingExportService, authorizer TenantAuthorizer) Endpoint[getRecordingRequest, recordingResponse] {
	return Get("/v1/tenants/{tenant_id}/recordings/{recording_id}", "getRecording", decodeGetRecordingRequest, func(ctx context.Context, request getRecordingRequest) (recordingResponse, error) {

		recording, err := service.Get(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return recordingResponse{}, err
		}
		state, err := artifacts.GetArtifactState(ctx, request.TenantID, request.RecordingID)
		if err != nil {
			return recordingResponse{}, err
		}
		return newRecordingResponse(recording, state), nil
	}).Needs(service, artifacts).Permission(authorizer, readRecordingsPermission).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter(), recordingIDParameter()).
		Responds(http.StatusOK, "Recording", recordingResponse{}).
		Errors(recordingReadErrors(apiErrorInvalidRecordingID, apiErrorRecordingNotFound)...).
		ErrorRules(recordingRules)
}

func createRecordingDownloadURLEndpoint(service RecordingService, exports RecordingExportService, downloads RecordingDownloadService, authorizer TenantAuthorizer) Endpoint[createRecordingDownloadURLEndpointRequest, recordingDownloadURLResponse] {
	return Post("/v1/tenants/{tenant_id}/recordings/{recording_id}/download-url", "createRecordingDownloadURL", decodeCreateRecordingDownloadURLRequest, func(ctx context.Context, request createRecordingDownloadURLEndpointRequest) (recordingDownloadURLResponse, error) {
		if request.Body.ExpiresInSeconds <= 0 || request.Body.ExpiresInSeconds > int(maximumArtifactDownloadURLLifetime/time.Second) {
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
			SignedHeader: cloneSignedHeaders(url),
		}, nil
	}).Permission(authorizer, readRecordingsPermission).Needs(service, exports, downloads).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), recordingIDParameter()).
		RequestBody("CreateRecordingDownloadURLRequest", createRecordingDownloadURLRequest{}).
		Responds(http.StatusOK, "RecordingDownloadURL", recordingDownloadURLResponse{}).
		Errors(recordingReadErrors(apiErrorInvalidRequest, apiErrorInvalidRecordingID, apiErrorRecordingNotFound, apiErrorRecordingNotReady, apiErrorInvalidStorageProvider, apiErrorInvalidStorageKey, apiErrorInvalidURLExpiration, apiErrorRecordingArtifactNotFound, apiErrorRateLimited)...).
		ErrorRules(recordingRules, objectStorageRules)
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

var recordingRules = errorRules{
	ruleFor(apiErrorInvalidTenantID, recordings.ErrInvalidTenantID),
	ruleFor(apiErrorInvalidRecordingID, recordings.ErrInvalidRecordingID),
	ruleFor(apiErrorInvalidSpaceID, recordings.ErrInvalidSpaceID),
	ruleFor(apiErrorInvalidEpisodeID, recordings.ErrInvalidEpisodeID),
	ruleFor(apiErrorInvalidRecordingStatus, recordings.ErrInvalidRecordingStatus),
	ruleFor(apiErrorInvalidStorageProvider, recordings.ErrInvalidStorageProvider),
	ruleFor(apiErrorInvalidStorageKey, recordings.ErrInvalidStorageKey),
	ruleFor(apiErrorInvalidRecordingField, recordings.ErrInvalidRecordingField),
	ruleFor(apiErrorEpisodeNotFound, recordings.ErrEpisodeNotFound),
	ruleFor(apiErrorRecordingNotFound, recordings.ErrRecordingNotFound),
	ruleFor(apiErrorInvalidTenantID, recordingpipeline.ErrInvalidTenantID),
	ruleFor(apiErrorInvalidRecordingID, recordingpipeline.ErrInvalidRecordingID),
	ruleFor(apiErrorRecordingNotFound, recordingpipeline.ErrPipelineNotFound),
	ruleFor(apiErrorRecordingNotReady, recordingpipeline.ErrExportUnavailable),
	ruleFor(apiErrorRecordingExportRetryLimit, recordingpipeline.ErrExportRetryLimit),
}

var objectStorageRules = errorRules{
	ruleFor(apiErrorInvalidStorageKey, objectstorage.ErrInvalidObjectKey),
	ruleFor(apiErrorInvalidURLExpiration, objectstorage.ErrInvalidURLExpiration),
	ruleFor(apiErrorServiceUnavailable, objectstorage.ErrStoreUnavailable),
	ruleFor(apiErrorRecordingArtifactNotFound, objectstorage.ErrObjectNotFound),
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
		TranscriptionPreparation: newRecordingTranscriptionPreparationResponse(state),
		UpdatedAt:                utilities.FormatTimestamp(recording.UpdatedAt),
		CreatedAt:                utilities.FormatTimestamp(recording.CreatedAt),
	}
}

func newRecordingTranscriptionPreparationResponse(state recordingpipeline.ArtifactState) recordingTranscriptionPreparationResponse {
	response := recordingTranscriptionPreparationResponse{Status: state.TranscriptionPreparationStatus, FailureCode: state.TranscriptionFailureCode}
	if state.TranscriptionSourceExpiresAt != nil {
		expiresAt := utilities.FormatTimestamp(*state.TranscriptionSourceExpiresAt)
		response.ExpiresAt = &expiresAt
	}
	return response
}

func newRecordingSourceResponse(state recordingpipeline.ArtifactState) recordingSourceResponse {
	response := recordingSourceResponse{Status: string(state.SourceStatus), StopReason: state.CaptureStopReason}
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
