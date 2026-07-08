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

func mountTranscriptRoutes(r chi.Router, service TranscriptService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Post("/tenants/{tenant_id}/recordings/{recording_id}/transcripts", handleCreateTranscript(service, authorizer))
	r.Get("/tenants/{tenant_id}/transcripts", handleListTranscripts(service, authorizer))
	r.Get("/tenants/{tenant_id}/transcripts/{transcript_id}", handleGetTranscript(service, authorizer))
	r.With(rateLimit(limits, authenticatedWriteRateLimit)).Patch("/tenants/{tenant_id}/transcripts/{transcript_id}", handleUpdateTranscript(service, authorizer))
}

func handleCreateTranscript(service TranscriptService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, recordingID, ok := tenantRecordingIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, writeTranscriptsPermission) {
			return
		}

		var request createTranscriptRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		input, ok := request.toCreateInput(w, tenantID, recordingID)
		if !ok {
			return
		}
		transcript, err := service.Create(r.Context(), input)
		if writeTranscriptServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusCreated, newTranscriptResponse(transcript))
	}
}

func handleListTranscripts(service TranscriptService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readTranscriptsPermission) {
			return
		}

		recordingID, ok := optionalQueryID(w, r, "recording_id", "invalid_recording_id", "Invalid recording id")
		if !ok {
			return
		}
		page, err := parsePageRequest(r)
		if writePaginationError(w, err) {
			return
		}

		list, err := service.List(r.Context(), tenantID, recordingID, page)
		if writeTranscriptServiceError(w, err) {
			return
		}

		response, err := newTranscriptListResponse(list)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

func handleGetTranscript(service TranscriptService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, transcriptID, ok := tenantTranscriptIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readTranscriptsPermission) {
			return
		}

		transcript, err := service.Get(r.Context(), tenantID, transcriptID)
		if writeTranscriptServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newTranscriptResponse(transcript))
	}
}

func handleUpdateTranscript(service TranscriptService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, transcriptID, ok := tenantTranscriptIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, writeTranscriptsPermission) {
			return
		}

		var request updateTranscriptRequest
		if err := decodeRequest(r, &request); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "Invalid request body")
			return
		}

		transcript, err := service.Update(r.Context(), tenantID, transcriptID, request.toUpdateInput())
		if writeTranscriptServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newTranscriptResponse(transcript))
	}
}

func writeTranscriptServiceError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, transcripts.ErrInvalidTenantID):
		writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
	case errors.Is(err, transcripts.ErrInvalidTranscriptID):
		writeError(w, http.StatusBadRequest, "invalid_transcript_id", "Invalid transcript id")
	case errors.Is(err, transcripts.ErrInvalidRecordingID):
		writeError(w, http.StatusBadRequest, "invalid_recording_id", "Invalid recording id")
	case errors.Is(err, transcripts.ErrInvalidRoomID):
		writeError(w, http.StatusBadRequest, "invalid_room_id", "Invalid room id")
	case errors.Is(err, transcripts.ErrInvalidSessionID):
		writeError(w, http.StatusBadRequest, "invalid_session_id", "Invalid session id")
	case errors.Is(err, transcripts.ErrInvalidTranscriptStatus):
		writeError(w, http.StatusBadRequest, "invalid_transcript_status", "Invalid transcript status")
	case errors.Is(err, transcripts.ErrInvalidProvider):
		writeError(w, http.StatusBadRequest, "invalid_transcript_provider", "Invalid transcript provider")
	case errors.Is(err, transcripts.ErrInvalidModel):
		writeError(w, http.StatusBadRequest, "invalid_transcript_model", "Invalid transcript model")
	case errors.Is(err, transcripts.ErrInvalidLanguages):
		writeError(w, http.StatusBadRequest, "invalid_transcript_languages", "Invalid transcript languages")
	case errors.Is(err, transcripts.ErrInvalidTranscriptField):
		writeError(w, http.StatusBadRequest, "invalid_transcript_field", "Invalid transcript field")
	case errors.Is(err, transcripts.ErrRecordingNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Recording not found")
	case errors.Is(err, transcripts.ErrTranscriptNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Transcript not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}
	return true
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

func (r createTranscriptRequest) toCreateInput(w http.ResponseWriter, tenantID utilities.ID, recordingID utilities.ID) (transcripts.CreateInput, bool) {
	roomID, err := utilities.ParseID(r.RoomID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_room_id", "Invalid room id")
		return transcripts.CreateInput{}, false
	}
	sessionID, err := utilities.ParseID(r.SessionID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_session_id", "Invalid session id")
		return transcripts.CreateInput{}, false
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
	}, true
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

func tenantTranscriptIDs(w http.ResponseWriter, r *http.Request) (utilities.ID, utilities.ID, bool) {
	tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
	if !ok {
		return utilities.ID{}, utilities.ID{}, false
	}
	transcriptID, ok := parseRouteID(w, r, "transcript_id", "invalid_transcript_id", "Invalid transcript id")
	if !ok {
		return utilities.ID{}, utilities.ID{}, false
	}
	return tenantID, transcriptID, true
}
