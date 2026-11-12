package httpapi

import (
	"context"
	"mime"
	"net/http"
	"time"

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
