package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	providerOperationBodyLimit = 16 * 1024
	providerObservationLimit   = 100
)

type ProviderBridgeService interface {
	Execute(context.Context, provideroperations.OperationInput) (providerbridge.Result, error)
	ListObservations(context.Context, utilities.ID, utilities.ID, *provideroperations.Cursor, int) (provideroperations.ObservationPage, error)
}

type SyncPeerVerifier interface {
	Verify(*http.Request) error
}

type providerOperationRequest struct {
	Effect                       provideroperations.Effect `json:"effect"`
	TenantID                     string                    `json:"tenant_id"`
	SessionID                    string                    `json:"session_id"`
	ParticipantSessionID         *string                   `json:"participant_session_id,omitempty"`
	ParticipantSessionGeneration *int64                    `json:"participant_session_generation,omitempty"`
	PublicationSource            *string                   `json:"publication_source,omitempty"`
	RecordingID                  *string                   `json:"recording_id,omitempty"`
}

type providerOperationResponse struct {
	OperationID string                     `json:"operation_id"`
	Effect      provideroperations.Effect  `json:"effect"`
	Outcome     provideroperations.Outcome `json:"outcome"`
	Reason      string                     `json:"reason,omitempty"`
}

type providerObservationResponse struct {
	Incarnation  int64                         `json:"incarnation"`
	Sequence     int64                         `json:"sequence"`
	Publications []providerPublicationResponse `json:"publications"`
}

type providerPublicationResponse struct {
	ParticipantSessionID string  `json:"participant_session_id"`
	Source               string  `json:"source"`
	Enabled              bool    `json:"enabled"`
	PublicationID        *string `json:"publication_id"`
}

type providerObservationCursorResponse struct {
	Incarnation int64 `json:"incarnation"`
	Sequence    int64 `json:"sequence"`
}

type providerObservationPageResponse struct {
	Observations []providerObservationResponse      `json:"observations"`
	HasMore      bool                               `json:"has_more"`
	NextCursor   *providerObservationCursorResponse `json:"next_cursor"`
}

// NewProviderBridgeHandler returns the complete private v1 contract without
// mounting it on the public API listener. The composition root must expose it
// only through a mutually authenticated private listener.
func NewProviderBridgeHandler(service ProviderBridgeService, verifier SyncPeerVerifier) http.Handler {
	router := chi.NewRouter()
	router.Use(requireSyncPeer(verifier))
	router.Post("/internal/v1/sync/provider-operations/{operation_id}", handleProviderOperation(service))
	router.Get("/internal/v1/sync/media-observations", handleProviderObservations(service))
	return router
}

func requireSyncPeer(verifier SyncPeerVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			if verifier == nil {
				writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is unavailable")
				return
			}
			if err := verifier.Verify(request); err != nil {
				writeError(w, http.StatusUnauthorized, "sync_unauthorized", "Sync authentication required")
				return
			}
			next.ServeHTTP(w, request)
		})
	}
}

func handleProviderOperation(service ProviderBridgeService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is unavailable")
			return
		}

		body, err := decodeProviderOperationBody(w, request)
		if err != nil {
			writeProviderBridgeError(w, err)
			return
		}
		input, err := providerOperationInput(chi.URLParam(request, "operation_id"), body)
		if err != nil {
			writeProviderBridgeError(w, err)
			return
		}

		result, err := service.Execute(request.Context(), input)
		if err != nil {
			writeProviderBridgeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, newProviderOperationResponse(result))
	}
}

func handleProviderObservations(service ProviderBridgeService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is unavailable")
			return
		}

		tenantID, sessionID, after, limit, err := providerObservationQuery(request)
		if err != nil {
			writeProviderBridgeError(w, err)
			return
		}
		page, err := service.ListObservations(request.Context(), tenantID, sessionID, after, limit)
		if err != nil {
			writeProviderBridgeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, newProviderObservationPageResponse(page))
	}
}

func decodeProviderOperationBody(w http.ResponseWriter, request *http.Request) (providerOperationRequest, error) {
	request.Body = http.MaxBytesReader(w, request.Body, providerOperationBodyLimit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var body providerOperationRequest
	if err := decoder.Decode(&body); err != nil {
		return providerOperationRequest{}, errors.Join(provideroperations.ErrInvalidEffect, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return providerOperationRequest{}, errors.Join(
			provideroperations.ErrInvalidEffect,
			errors.New("provider operation body must contain one JSON value"),
		)
	}
	return body, nil
}

func providerOperationInput(operationID string, body providerOperationRequest) (provideroperations.OperationInput, error) {
	tenantID, err := utilities.ParseID(body.TenantID)
	if err != nil {
		return provideroperations.OperationInput{}, provideroperations.ErrInvalidTenantID
	}
	sessionID, err := utilities.ParseID(body.SessionID)
	if err != nil {
		return provideroperations.OperationInput{}, provideroperations.ErrInvalidSessionID
	}

	input := provideroperations.OperationInput{
		OperationID: operationID,
		Effect:      body.Effect,
		TenantID:    tenantID,
		SessionID:   sessionID,
	}
	if body.ParticipantSessionID != nil {
		participantID, parseErr := utilities.ParseID(*body.ParticipantSessionID)
		if parseErr != nil {
			return provideroperations.OperationInput{}, provideroperations.ErrInvalidParticipantID
		}
		input.ParticipantSessionID = participantID
	}
	if body.ParticipantSessionGeneration != nil {
		input.ParticipantSessionGeneration = *body.ParticipantSessionGeneration
	}
	if body.PublicationSource != nil {
		input.PublicationSource = *body.PublicationSource
	}
	if body.RecordingID != nil {
		recordingID, parseErr := utilities.ParseID(*body.RecordingID)
		if parseErr != nil {
			return provideroperations.OperationInput{}, provideroperations.ErrInvalidRecordingID
		}
		input.RecordingID = recordingID
	}
	_, err = input.Canonicalize()
	return input, err
}

func providerObservationQuery(request *http.Request) (utilities.ID, utilities.ID, *provideroperations.Cursor, int, error) {
	query := request.URL.Query()
	tenantID, err := utilities.ParseID(query.Get("tenant_id"))
	if err != nil {
		return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidTenantID
	}
	sessionID, err := utilities.ParseID(query.Get("session_id"))
	if err != nil {
		return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidSessionID
	}

	limit := providerObservationLimit
	if value := query.Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > providerObservationLimit {
			return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidObservationCursor
		}
	}

	afterIncarnation := query.Get("after_incarnation")
	afterSequence := query.Get("after_sequence")
	if afterIncarnation == "" && afterSequence == "" {
		return tenantID, sessionID, nil, limit, nil
	}
	if afterIncarnation == "" || afterSequence == "" {
		return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidObservationCursor
	}
	incarnation, err := strconv.ParseInt(afterIncarnation, 10, 64)
	if err != nil || incarnation < 0 {
		return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidObservationCursor
	}
	sequence, err := strconv.ParseInt(afterSequence, 10, 64)
	if err != nil || sequence < 0 {
		return utilities.ID{}, utilities.ID{}, nil, 0, provideroperations.ErrInvalidObservationCursor
	}
	return tenantID, sessionID, &provideroperations.Cursor{Incarnation: incarnation, Sequence: sequence}, limit, nil
}

func newProviderOperationResponse(result providerbridge.Result) providerOperationResponse {
	return providerOperationResponse{
		OperationID: result.OperationID,
		Effect:      result.Effect,
		Outcome:     result.Outcome,
		Reason:      result.Reason,
	}
}

func newProviderObservationPageResponse(page provideroperations.ObservationPage) providerObservationPageResponse {
	response := providerObservationPageResponse{
		Observations: make([]providerObservationResponse, 0, len(page.Observations)),
		HasMore:      page.Next != nil,
	}
	for _, observation := range page.Observations {
		publications := make([]providerPublicationResponse, 0, len(observation.Publications))
		for _, publication := range observation.Publications {
			var publicationID *string
			if publication.PublicationID != "" {
				value := publication.PublicationID
				publicationID = &value
			}
			publications = append(publications, providerPublicationResponse{
				ParticipantSessionID: publication.ParticipantSessionID.String(),
				Source:               publication.Source,
				Enabled:              publication.Enabled,
				PublicationID:        publicationID,
			})
		}
		response.Observations = append(response.Observations, providerObservationResponse{
			Incarnation:  observation.Incarnation,
			Sequence:     observation.Sequence,
			Publications: publications,
		})
	}
	if page.Next != nil {
		response.NextCursor = &providerObservationCursorResponse{
			Incarnation: page.Next.Incarnation,
			Sequence:    page.Next.Sequence,
		}
	}
	return response
}

func writeProviderBridgeError(w http.ResponseWriter, err error) {
	var maxBytesError *http.MaxBytesError
	switch {
	case errors.As(err, &maxBytesError):
		writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Request body is too large")
	case errors.Is(err, providerbridge.ErrUnavailable):
		writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is unavailable")
	case errors.Is(err, providerbridge.ErrInvalidProviderResult):
		writeError(w, http.StatusBadGateway, "provider_unavailable", "Provider result is unavailable")
	case errors.Is(err, provideroperations.ErrInvalidOperationID),
		errors.Is(err, provideroperations.ErrInvalidEffect),
		errors.Is(err, provideroperations.ErrInvalidTenantID),
		errors.Is(err, provideroperations.ErrInvalidSessionID),
		errors.Is(err, provideroperations.ErrInvalidParticipantID),
		errors.Is(err, provideroperations.ErrInvalidParticipantGeneration),
		errors.Is(err, provideroperations.ErrInvalidPublicationSource),
		errors.Is(err, provideroperations.ErrInvalidRecordingID),
		errors.Is(err, provideroperations.ErrInvalidObservationCursor):
		writeError(w, http.StatusBadRequest, "invalid_contract", "Invalid provider bridge request")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}
}
