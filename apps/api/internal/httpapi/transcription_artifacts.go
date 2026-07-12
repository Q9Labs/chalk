package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TranscriptArtifactService interface {
	Request(context.Context, transcripts.RequestInput) (transcripts.Transcript, transcripts.Job, error)
	Get(context.Context, utilities.ID, utilities.ID) (transcripts.Transcript, error)
	List(context.Context, utilities.ID, utilities.ID, pagination.PageRequest) (transcripts.TranscriptList, error)
	Delete(context.Context, utilities.ID, utilities.ID) (transcripts.Transcript, error)
}

type transcriptArtifactResponse struct {
	ID                  string   `json:"id"`
	TenantID            string   `json:"tenant_id"`
	RecordingID         string   `json:"recording_id"`
	RoomID              string   `json:"room_id"`
	SessionID           string   `json:"session_id"`
	Status              string   `json:"status"`
	Languages           []string `json:"languages"`
	Provider            string   `json:"provider,omitempty"`
	Model               string   `json:"model,omitempty"`
	ArtifactSize        *int64   `json:"artifact_size,omitempty"`
	ArtifactContentType *string  `json:"artifact_content_type,omitempty"`
	Generation          int64    `json:"generation"`
	CompletedAt         *string  `json:"completed_at,omitempty"`
	DeletedAt           *string  `json:"deleted_at,omitempty"`
	UpdatedAt           string   `json:"updated_at"`
	CreatedAt           string   `json:"created_at"`
}

type transcriptArtifactListResponse struct {
	Transcripts []transcriptArtifactResponse `json:"transcripts"`
	Pagination  paginationResponse           `json:"pagination"`
}
type requestTranscriptResponse struct {
	Transcript transcriptArtifactResponse `json:"transcript"`
	JobID      string                     `json:"job_id"`
	Status     string                     `json:"status"`
}

type requestTranscriptBody struct {
	IdempotencyKey string   `json:"idempotency_key"`
	Language       string   `json:"language"`
	Languages      []string `json:"languages"`
}

func mountTranscriptArtifactRoutes(r chi.Router, service TranscriptArtifactService, downloads RecordingDownloadService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range transcriptArtifactEndpoints(service, downloads, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func transcriptArtifactEndpoints(service TranscriptArtifactService, downloads RecordingDownloadService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		requestTranscriptEndpoint(service, authorizer),
		listTranscriptArtifactEndpoint(service, authorizer),
		getTranscriptArtifactEndpoint(service, authorizer),
		deleteTranscriptArtifactEndpoint(service, authorizer),
		transcriptArtifactDownloadEndpoint(service, downloads, authorizer),
	}
}

func requestTranscriptEndpoint(service TranscriptArtifactService, authorizer TenantAuthorizer) Endpoint[requestTranscriptEndpointRequest, requestTranscriptResponse] {
	return Post("/v1/tenants/{tenant_id}/recordings/{recording_id}/transcripts", "/tenants/{tenant_id}/recordings/{recording_id}/transcripts", "requestTranscript", decodeRequestTranscriptEndpointRequest, func(ctx context.Context, request requestTranscriptEndpointRequest) (requestTranscriptResponse, error) {
		if service == nil {
			return requestTranscriptResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, authorization.TenantPermission{Scope: authentication.ScopeTranscriptionsWrite, MinimumRole: memberships.RoleMember}); err != nil {
			return requestTranscriptResponse{}, err
		}
		input, err := request.Body.input(request.TenantID, request.RecordingID)
		if err != nil {
			return requestTranscriptResponse{}, err
		}
		input.JourneyID, input.Traceparent, input.Tracestate = request.JourneyID, request.Traceparent, request.Tracestate
		transcript, job, err := service.Request(ctx, input)
		if err != nil {
			return requestTranscriptResponse{}, err
		}
		status := job.State
		if job.ID.IsZero() {
			status = transcript.Status
		}
		return requestTranscriptResponse{Transcript: newTranscriptArtifactResponse(transcript), JobID: job.ID.String(), Status: status}, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), recordingIDParameter()).RequestBody("RequestTranscriptRequest", requestTranscriptBody{}).Responds(http.StatusAccepted, "TranscriptRequestAcceptedResponse", requestTranscriptResponse{}).Errors(transcriptArtifactErrors(apiErrorInvalidRequest, apiErrorInvalidTranscriptID, apiErrorInvalidRecordingID, apiErrorRecordingNotFound, apiErrorRecordingNotReady, apiErrorRateLimited)...).MapErrors(transcriptArtifactAPIError)
}

type requestTranscriptEndpointRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
	JourneyID   utilities.ID
	Traceparent string
	Tracestate  string
	Body        requestTranscriptBody
}

func decodeRequestTranscriptEndpointRequest(r *http.Request) (requestTranscriptEndpointRequest, error) {
	tenantID, recordingID, err := tenantRecordingIDsRequest(r)
	if err != nil {
		return requestTranscriptEndpointRequest{}, err
	}
	body, err := decodeJSONBody[requestTranscriptBody](r)
	if err != nil {
		return requestTranscriptEndpointRequest{}, err
	}
	journeyID, _ := utilities.ParseID(r.Header.Get("X-Chalk-Journey-ID"))
	return requestTranscriptEndpointRequest{TenantID: tenantID, RecordingID: recordingID, JourneyID: journeyID, Traceparent: r.Header.Get("traceparent"), Tracestate: r.Header.Get("tracestate"), Body: body}, nil
}

func (body requestTranscriptBody) input(tenantID, recordingID utilities.ID) (transcripts.RequestInput, error) {
	return transcripts.RequestInput{TenantID: tenantID, RecordingID: recordingID, IdempotencyKey: body.IdempotencyKey, Language: body.Language, Languages: body.Languages}, nil
}

func listTranscriptArtifactEndpoint(service TranscriptArtifactService, authorizer TenantAuthorizer) Endpoint[listTranscriptsRequest, transcriptArtifactListResponse] {
	return Get("/v1/tenants/{tenant_id}/transcripts", "/tenants/{tenant_id}/transcripts", "listTranscripts", decodeListTranscriptsRequest, func(ctx context.Context, request listTranscriptsRequest) (transcriptArtifactListResponse, error) {
		if service == nil {
			return transcriptArtifactListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, authorization.TenantPermission{Scope: authentication.ScopeTranscriptionsRead, MinimumRole: memberships.RoleViewer}); err != nil {
			return transcriptArtifactListResponse{}, err
		}
		list, err := service.List(ctx, request.TenantID, request.RecordingID, request.Page)
		if err != nil {
			return transcriptArtifactListResponse{}, err
		}
		page, err := newPaginationResponse(list.Page)
		if err != nil {
			return transcriptArtifactListResponse{}, err
		}
		response := transcriptArtifactListResponse{Transcripts: make([]transcriptArtifactResponse, 0, len(list.Transcripts)), Pagination: page}
		for _, transcript := range list.Transcripts {
			response.Transcripts = append(response.Transcripts, newTranscriptArtifactResponse(transcript))
		}
		return response, nil
	}).Auth(APIAuthSessionOrBearer).Parameters(append([]APIParameterContract{tenantIDParameter(), recordingIDQueryParameter()}, paginationParameters()...)...).Responds(http.StatusOK, "TranscriptList", transcriptArtifactListResponse{}).Errors(transcriptReadErrors(apiErrorInvalidRecordingID, apiErrorInvalidPageSize, apiErrorInvalidCursor)...).MapErrors(transcriptArtifactAPIError)
}

func getTranscriptArtifactEndpoint(service TranscriptArtifactService, authorizer TenantAuthorizer) Endpoint[getTranscriptRequest, transcriptArtifactResponse] {
	return Get("/v1/tenants/{tenant_id}/transcripts/{transcript_id}", "/tenants/{tenant_id}/transcripts/{transcript_id}", "getTranscript", decodeGetTranscriptRequest, func(ctx context.Context, request getTranscriptRequest) (transcriptArtifactResponse, error) {
		if service == nil {
			return transcriptArtifactResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, authorization.TenantPermission{Scope: authentication.ScopeTranscriptionsRead, MinimumRole: memberships.RoleViewer}); err != nil {
			return transcriptArtifactResponse{}, err
		}
		transcript, err := service.Get(ctx, request.TenantID, request.TranscriptID)
		if err != nil {
			return transcriptArtifactResponse{}, err
		}
		return newTranscriptArtifactResponse(transcript), nil
	}).Auth(APIAuthSessionOrBearer).Parameters(tenantIDParameter(), transcriptIDParameter()).Responds(http.StatusOK, "Transcript", transcriptArtifactResponse{}).Errors(transcriptReadErrors(apiErrorInvalidTranscriptID, apiErrorTranscriptNotFound)...).MapErrors(transcriptArtifactAPIError)
}

func deleteTranscriptArtifactEndpoint(service TranscriptArtifactService, authorizer TenantAuthorizer) Endpoint[deleteTranscriptRequest, struct{}] {
	return Delete("/v1/tenants/{tenant_id}/transcripts/{transcript_id}", "/tenants/{tenant_id}/transcripts/{transcript_id}", "deleteTranscript", decodeDeleteTranscriptRequest, func(ctx context.Context, request deleteTranscriptRequest) (struct{}, error) {
		if service == nil {
			return struct{}{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, authorization.TenantPermission{Scope: authentication.ScopeTranscriptionsDelete, MinimumRole: memberships.RoleMember}); err != nil {
			return struct{}{}, err
		}
		if _, err := service.Delete(ctx, request.TenantID, request.TranscriptID); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), transcriptIDParameter()).RespondsNoBody(http.StatusNoContent).Errors(transcriptWriteErrors(apiErrorInvalidTranscriptID, apiErrorTranscriptNotFound, apiErrorRateLimited)...).MapErrors(transcriptArtifactAPIError)
}

type deleteTranscriptRequest struct {
	TenantID     utilities.ID
	TranscriptID utilities.ID
}

func decodeDeleteTranscriptRequest(r *http.Request) (deleteTranscriptRequest, error) {
	tenantID, transcriptID, err := tenantTranscriptIDsRequest(r)
	return deleteTranscriptRequest{TenantID: tenantID, TranscriptID: transcriptID}, err
}

func transcriptArtifactDownloadEndpoint(service TranscriptArtifactService, downloads RecordingDownloadService, authorizer TenantAuthorizer) Endpoint[createTranscriptDownloadRequest, transcriptDownloadResponse] {
	return Post("/v1/tenants/{tenant_id}/transcripts/{transcript_id}/download-url", "/tenants/{tenant_id}/transcripts/{transcript_id}/download-url", "createTranscriptDownloadURL", decodeCreateTranscriptDownloadRequest, func(ctx context.Context, request createTranscriptDownloadRequest) (transcriptDownloadResponse, error) {
		if service == nil || downloads == nil {
			return transcriptDownloadResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, authorization.TenantPermission{Scope: authentication.ScopeTranscriptionsRead, MinimumRole: memberships.RoleViewer}); err != nil {
			return transcriptDownloadResponse{}, err
		}
		transcript, err := service.Get(ctx, request.TenantID, request.TranscriptID)
		if err != nil {
			return transcriptDownloadResponse{}, err
		}
		if transcript.Status != transcripts.StatusComplete || transcript.ArtifactKey == nil {
			return transcriptDownloadResponse{}, apiErrorTranscriptNotReady
		}
		signed, err := downloads.CreateDownloadURL(ctx, objectstorage.CreateDownloadURLInput{Key: *transcript.ArtifactKey, ExpiresIn: time.Duration(request.Body.ExpiresInSeconds) * time.Second})
		if err != nil {
			return transcriptDownloadResponse{}, err
		}
		return transcriptDownloadResponse{Method: signed.Method, URL: signed.URL, SignedAt: utilities.FormatTimestamp(signed.SignedAt), ExpiresAt: utilities.FormatTimestamp(signed.ExpiresAt), SignedHeaders: signed.SignedHeader}, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedWriteRateLimit).Parameters(tenantIDParameter(), transcriptIDParameter()).RequestBody("CreateTranscriptDownloadURLRequest", createTranscriptDownloadBody{}).Responds(http.StatusOK, "TranscriptDownloadURL", transcriptDownloadResponse{}).Errors(transcriptReadErrors(apiErrorTranscriptNotFound, apiErrorTranscriptNotReady, apiErrorInvalidURLExpiration)...).MapErrors(transcriptArtifactAPIError)
}

type createTranscriptDownloadBody struct {
	ExpiresInSeconds int `json:"expires_in_seconds"`
}
type createTranscriptDownloadRequest struct {
	TenantID     utilities.ID
	TranscriptID utilities.ID
	Body         createTranscriptDownloadBody
}
type transcriptDownloadResponse struct {
	Method        string              `json:"method"`
	URL           string              `json:"url"`
	SignedAt      string              `json:"signed_at"`
	ExpiresAt     string              `json:"expires_at"`
	SignedHeaders map[string][]string `json:"signed_headers"`
}

func decodeCreateTranscriptDownloadRequest(r *http.Request) (createTranscriptDownloadRequest, error) {
	tenantID, transcriptID, err := tenantTranscriptIDsRequest(r)
	if err != nil {
		return createTranscriptDownloadRequest{}, err
	}
	body, err := decodeJSONBody[createTranscriptDownloadBody](r)
	return createTranscriptDownloadRequest{TenantID: tenantID, TranscriptID: transcriptID, Body: body}, err
}

func newTranscriptArtifactResponse(value transcripts.Transcript) transcriptArtifactResponse {
	return transcriptArtifactResponse{ID: value.ID.String(), TenantID: value.TenantID.String(), RecordingID: value.RecordingID.String(), RoomID: value.RoomID.String(), SessionID: value.SessionID.String(), Status: value.Status, Languages: value.Languages, Provider: value.Provider, Model: value.Model, ArtifactSize: value.ArtifactSize, ArtifactContentType: value.ArtifactContentType, Generation: value.Generation, CompletedAt: optionalTimestampString(value.CompletedAt), DeletedAt: optionalTimestampString(value.DeletedAt), UpdatedAt: utilities.FormatTimestamp(value.UpdatedAt), CreatedAt: utilities.FormatTimestamp(value.CreatedAt)}
}

func decodeChecksum(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if len(value) != sha256.Size*2 {
		return nil, errors.New("checksum length")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return nil, err
	}
	return decoded, nil
}

func transcriptArtifactErrors(extra ...APIError) []APIError {
	return append([]APIError{apiErrorUnauthenticated, apiErrorForbidden, apiErrorServiceUnavailable, apiErrorInvalidTenantID, apiErrorInternal}, extra...)
}
func transcriptArtifactAPIError(err error) (APIError, bool) {
	if value, ok := errorAsAPIError(err); ok {
		return value, true
	}
	switch {
	case errors.Is(err, transcripts.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, transcripts.ErrInvalidTranscriptID):
		return apiErrorInvalidTranscriptID, true
	case errors.Is(err, transcripts.ErrInvalidRecordingID):
		return apiErrorInvalidRecordingID, true
	case errors.Is(err, transcripts.ErrRecordingNotFound):
		return apiErrorRecordingNotFound, true
	case errors.Is(err, transcripts.ErrSourceNotReady):
		return apiErrorRecordingNotReady, true
	case errors.Is(err, transcripts.ErrTranscriptNotFound):
		return apiErrorTranscriptNotFound, true
	case errors.Is(err, transcripts.ErrInvalidIdempotencyKey), errors.Is(err, transcripts.ErrInvalidManifest), errors.Is(err, transcripts.ErrInvalidChunk), errors.Is(err, transcripts.ErrInvalidArtifact):
		return apiErrorInvalidRequest, true
	case errors.Is(err, transcripts.ErrArtifactRepository):
		return apiErrorServiceUnavailable, true
	default:
		return APIError{}, false
	}
}
