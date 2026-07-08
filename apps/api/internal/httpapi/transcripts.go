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
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	readTranscriptsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeTranscriptionsRead,
		MinimumRole: memberships.RoleViewer,
	}
	writeTranscriptsPermission = authorization.TenantPermission{
		Scope:       authentication.ScopeTranscriptionsWrite,
		MinimumRole: memberships.RoleMember,
	}
)

type TranscriptService interface {
	Create(ctx context.Context, input transcripts.CreateInput) (transcripts.Transcript, error)
	Get(ctx context.Context, tenantID utilities.ID, transcriptID utilities.ID) (transcripts.Transcript, error)
	List(ctx context.Context, tenantID utilities.ID, recordingID utilities.ID, page pagination.PageRequest) (transcripts.TranscriptList, error)
	Update(ctx context.Context, tenantID utilities.ID, transcriptID utilities.ID, input transcripts.UpdateInput) (transcripts.Transcript, error)
}

type transcriptResponse struct {
	ID          string   `json:"id"`
	TenantID    string   `json:"tenant_id"`
	RecordingID string   `json:"recording_id"`
	RoomID      string   `json:"room_id"`
	SessionID   string   `json:"session_id"`
	Status      string   `json:"status"`
	Provider    string   `json:"provider"`
	Model       string   `json:"model"`
	Languages   []string `json:"languages"`
	Text        *string  `json:"text"`
	Metadata    any      `json:"metadata"`
	CompletedAt *string  `json:"completed_at"`
	UpdatedAt   string   `json:"updated_at"`
	CreatedAt   string   `json:"created_at"`
}

type transcriptListResponse struct {
	Transcripts []transcriptResponse `json:"transcripts"`
	Pagination  paginationResponse   `json:"pagination"`
}

type createTranscriptRequest struct {
	RoomID      string                 `json:"room_id"`
	SessionID   string                 `json:"session_id"`
	Status      string                 `json:"status"`
	Provider    string                 `json:"provider"`
	Model       string                 `json:"model"`
	Languages   []string               `json:"languages"`
	Text        *string                `json:"text"`
	Metadata    utilities.OptionalJSON `json:"metadata"`
	CompletedAt *time.Time             `json:"completed_at"`
}

type updateTranscriptRequest struct {
	Status      utilities.OptionalString    `json:"status"`
	Provider    utilities.OptionalString    `json:"provider"`
	Model       utilities.OptionalString    `json:"model"`
	Languages   transcripts.OptionalStrings `json:"languages"`
	Text        utilities.OptionalString    `json:"text"`
	Metadata    utilities.OptionalJSON      `json:"metadata"`
	CompletedAt optionalTimeRequest         `json:"completed_at"`
}

type createTranscriptEndpointRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
	Body        createTranscriptRequest
}

type listTranscriptsRequest struct {
	TenantID    utilities.ID
	RecordingID utilities.ID
	Page        pagination.PageRequest
}

type getTranscriptRequest struct {
	TenantID     utilities.ID
	TranscriptID utilities.ID
}

type updateTranscriptEndpointRequest struct {
	TenantID     utilities.ID
	TranscriptID utilities.ID
	Body         updateTranscriptRequest
}

func mountTranscriptRoutes(r chi.Router, service TranscriptService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range transcriptEndpoints(service, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func transcriptEndpoints(service TranscriptService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		createTranscriptEndpoint(service, authorizer),
		listTranscriptsEndpoint(service, authorizer),
		getTranscriptEndpoint(service, authorizer),
		updateTranscriptEndpoint(service, authorizer),
	}
}

func createTranscriptEndpoint(service TranscriptService, authorizer TenantAuthorizer) Endpoint[createTranscriptEndpointRequest, transcriptResponse] {
	return Post("/v1/tenants/{tenant_id}/recordings/{recording_id}/transcripts", "/tenants/{tenant_id}/recordings/{recording_id}/transcripts", "createTranscript", decodeCreateTranscriptRequest, func(ctx context.Context, request createTranscriptEndpointRequest) (transcriptResponse, error) {
		if service == nil {
			return transcriptResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeTranscriptsPermission); err != nil {
			return transcriptResponse{}, err
		}

		input, err := request.Body.toCreateInputValue(request.TenantID, request.RecordingID)
		if err != nil {
			return transcriptResponse{}, err
		}
		transcript, err := service.Create(ctx, input)
		if err != nil {
			return transcriptResponse{}, err
		}
		return newTranscriptResponse(transcript), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), recordingIDParameter()).
		RequestBody("CreateTranscriptRequest", createTranscriptRequest{}).
		Responds(http.StatusCreated, "Transcript", transcriptResponse{}).
		Errors(transcriptWriteErrors(apiErrorInvalidRequest, apiErrorInvalidRecordingID, apiErrorInvalidRoomID, apiErrorInvalidSessionID, apiErrorInvalidTranscriptStatus, apiErrorInvalidTranscriptProvider, apiErrorInvalidTranscriptModel, apiErrorInvalidTranscriptLanguages, apiErrorInvalidTranscriptField, apiErrorRecordingNotFound, apiErrorRateLimited)...).
		MapErrors(transcriptEndpointAPIError)
}

func listTranscriptsEndpoint(service TranscriptService, authorizer TenantAuthorizer) Endpoint[listTranscriptsRequest, transcriptListResponse] {
	return Get("/v1/tenants/{tenant_id}/transcripts", "/tenants/{tenant_id}/transcripts", "listTranscripts", decodeListTranscriptsRequest, func(ctx context.Context, request listTranscriptsRequest) (transcriptListResponse, error) {
		if service == nil {
			return transcriptListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readTranscriptsPermission); err != nil {
			return transcriptListResponse{}, err
		}

		list, err := service.List(ctx, request.TenantID, request.RecordingID, request.Page)
		if err != nil {
			return transcriptListResponse{}, err
		}
		return newTranscriptListResponse(list)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter(), recordingIDQueryParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "TranscriptList", transcriptListResponse{}).
		Errors(transcriptReadErrors(apiErrorInvalidRecordingID, apiErrorInvalidPageSize, apiErrorInvalidCursor)...).
		MapErrors(transcriptEndpointAPIError)
}

func getTranscriptEndpoint(service TranscriptService, authorizer TenantAuthorizer) Endpoint[getTranscriptRequest, transcriptResponse] {
	return Get("/v1/tenants/{tenant_id}/transcripts/{transcript_id}", "/tenants/{tenant_id}/transcripts/{transcript_id}", "getTranscript", decodeGetTranscriptRequest, func(ctx context.Context, request getTranscriptRequest) (transcriptResponse, error) {
		if service == nil {
			return transcriptResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readTranscriptsPermission); err != nil {
			return transcriptResponse{}, err
		}

		transcript, err := service.Get(ctx, request.TenantID, request.TranscriptID)
		if err != nil {
			return transcriptResponse{}, err
		}
		return newTranscriptResponse(transcript), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter(), transcriptIDParameter()).
		Responds(http.StatusOK, "Transcript", transcriptResponse{}).
		Errors(transcriptReadErrors(apiErrorInvalidTranscriptID, apiErrorTranscriptNotFound)...).
		MapErrors(transcriptEndpointAPIError)
}

func updateTranscriptEndpoint(service TranscriptService, authorizer TenantAuthorizer) Endpoint[updateTranscriptEndpointRequest, transcriptResponse] {
	return Patch("/v1/tenants/{tenant_id}/transcripts/{transcript_id}", "/tenants/{tenant_id}/transcripts/{transcript_id}", "updateTranscript", decodeUpdateTranscriptRequest, func(ctx context.Context, request updateTranscriptEndpointRequest) (transcriptResponse, error) {
		if service == nil {
			return transcriptResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, writeTranscriptsPermission); err != nil {
			return transcriptResponse{}, err
		}

		transcript, err := service.Update(ctx, request.TenantID, request.TranscriptID, request.Body.toUpdateInput())
		if err != nil {
			return transcriptResponse{}, err
		}
		return newTranscriptResponse(transcript), nil
	}).
		Auth(APIAuthSessionOrBearer).
		RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), transcriptIDParameter()).
		RequestBody("UpdateTranscriptRequest", updateTranscriptRequest{}).
		Responds(http.StatusOK, "Transcript", transcriptResponse{}).
		Errors(transcriptWriteErrors(apiErrorInvalidRequest, apiErrorInvalidTranscriptID, apiErrorInvalidTranscriptStatus, apiErrorInvalidTranscriptProvider, apiErrorInvalidTranscriptModel, apiErrorInvalidTranscriptLanguages, apiErrorInvalidTranscriptField, apiErrorTranscriptNotFound, apiErrorRateLimited)...).
		MapErrors(transcriptEndpointAPIError)
}

func decodeCreateTranscriptRequest(r *http.Request) (createTranscriptEndpointRequest, error) {
	tenantID, recordingID, err := tenantRecordingIDsRequest(r)
	if err != nil {
		return createTranscriptEndpointRequest{}, err
	}
	body, err := decodeJSONBody[createTranscriptRequest](r)
	if err != nil {
		return createTranscriptEndpointRequest{}, err
	}
	return createTranscriptEndpointRequest{TenantID: tenantID, RecordingID: recordingID, Body: body}, nil
}

func decodeListTranscriptsRequest(r *http.Request) (listTranscriptsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listTranscriptsRequest{}, err
	}
	recordingID, err := optionalRecordingIDQuery(r)
	if err != nil {
		return listTranscriptsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listTranscriptsRequest{}, paginationAPIError(err)
	}
	return listTranscriptsRequest{TenantID: tenantID, RecordingID: recordingID, Page: page}, nil
}

func decodeGetTranscriptRequest(r *http.Request) (getTranscriptRequest, error) {
	tenantID, transcriptID, err := tenantTranscriptIDsRequest(r)
	if err != nil {
		return getTranscriptRequest{}, err
	}
	return getTranscriptRequest{TenantID: tenantID, TranscriptID: transcriptID}, nil
}

func decodeUpdateTranscriptRequest(r *http.Request) (updateTranscriptEndpointRequest, error) {
	tenantID, transcriptID, err := tenantTranscriptIDsRequest(r)
	if err != nil {
		return updateTranscriptEndpointRequest{}, err
	}
	body, err := decodeJSONBody[updateTranscriptRequest](r)
	if err != nil {
		return updateTranscriptEndpointRequest{}, err
	}
	return updateTranscriptEndpointRequest{TenantID: tenantID, TranscriptID: transcriptID, Body: body}, nil
}

func tenantTranscriptIDsRequest(r *http.Request) (utilities.ID, utilities.ID, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	transcriptID, err := transcriptIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, err
	}
	return tenantID, transcriptID, nil
}

func transcriptReadErrors(extra ...APIError) []APIError {
	return append([]APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInternal,
	}, extra...)
}

func transcriptWriteErrors(extra ...APIError) []APIError {
	return append([]APIError{
		apiErrorUnauthenticated,
		apiErrorForbidden,
		apiErrorServiceUnavailable,
		apiErrorInvalidTenantID,
		apiErrorInternal,
	}, extra...)
}

func transcriptEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := transcriptServiceAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func transcriptServiceAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, transcripts.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, transcripts.ErrInvalidTranscriptID):
		return apiErrorInvalidTranscriptID, true
	case errors.Is(err, transcripts.ErrInvalidRecordingID):
		return apiErrorInvalidRecordingID, true
	case errors.Is(err, transcripts.ErrInvalidRoomID):
		return apiErrorInvalidRoomID, true
	case errors.Is(err, transcripts.ErrInvalidSessionID):
		return apiErrorInvalidSessionID, true
	case errors.Is(err, transcripts.ErrInvalidTranscriptStatus):
		return apiErrorInvalidTranscriptStatus, true
	case errors.Is(err, transcripts.ErrInvalidProvider):
		return apiErrorInvalidTranscriptProvider, true
	case errors.Is(err, transcripts.ErrInvalidModel):
		return apiErrorInvalidTranscriptModel, true
	case errors.Is(err, transcripts.ErrInvalidLanguages):
		return apiErrorInvalidTranscriptLanguages, true
	case errors.Is(err, transcripts.ErrInvalidTranscriptField):
		return apiErrorInvalidTranscriptField, true
	case errors.Is(err, transcripts.ErrRecordingNotFound):
		return apiErrorRecordingNotFound, true
	case errors.Is(err, transcripts.ErrTranscriptNotFound):
		return apiErrorTranscriptNotFound, true
	default:
		return APIError{}, false
	}
}

func newTranscriptListResponse(list transcripts.TranscriptList) (transcriptListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return transcriptListResponse{}, err
	}

	response := transcriptListResponse{Transcripts: make([]transcriptResponse, 0, len(list.Transcripts)), Pagination: page}
	for _, transcript := range list.Transcripts {
		response.Transcripts = append(response.Transcripts, newTranscriptResponse(transcript))
	}
	return response, nil
}

func newTranscriptResponse(transcript transcripts.Transcript) transcriptResponse {
	return transcriptResponse{
		ID:          transcript.ID.String(),
		TenantID:    transcript.TenantID.String(),
		RecordingID: transcript.RecordingID.String(),
		RoomID:      transcript.RoomID.String(),
		SessionID:   transcript.SessionID.String(),
		Status:      transcript.Status,
		Provider:    transcript.Provider,
		Model:       transcript.Model,
		Languages:   transcript.Languages,
		Text:        transcript.Text,
		Metadata:    rawJSONValue(transcript.Metadata),
		CompletedAt: optionalTimestampString(transcript.CompletedAt),
		UpdatedAt:   utilities.FormatTimestamp(transcript.UpdatedAt),
		CreatedAt:   utilities.FormatTimestamp(transcript.CreatedAt),
	}
}

func (r createTranscriptRequest) toCreateInputValue(tenantID utilities.ID, recordingID utilities.ID) (transcripts.CreateInput, error) {
	roomID, err := utilities.ParseID(r.RoomID)
	if err != nil {
		return transcripts.CreateInput{}, apiErrorInvalidRoomID
	}
	sessionID, err := utilities.ParseID(r.SessionID)
	if err != nil {
		return transcripts.CreateInput{}, apiErrorInvalidSessionID
	}

	return transcripts.CreateInput{
		TenantID:    tenantID,
		RecordingID: recordingID,
		RoomID:      roomID,
		SessionID:   sessionID,
		Status:      r.Status,
		Provider:    r.Provider,
		Model:       r.Model,
		Languages:   r.Languages,
		Text:        r.Text,
		Metadata:    r.Metadata.Value,
		CompletedAt: r.CompletedAt,
	}, nil
}

func (r updateTranscriptRequest) toUpdateInput() transcripts.UpdateInput {
	return transcripts.UpdateInput{
		Status:    r.Status,
		Provider:  r.Provider,
		Model:     r.Model,
		Languages: r.Languages,
		Text:      r.Text,
		Metadata:  r.Metadata,
		CompletedAt: transcripts.OptionalTime{
			Set:   r.CompletedAt.Set,
			Value: r.CompletedAt.Value,
		},
	}
}
