package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	providerOperationBodyLimit = 16 * 1024
	providerObservationLimit   = 100
)

type ProviderBridgeService interface {
	Execute(context.Context, provideroperations.OperationInput) (providerbridge.Result, error)
	ListObservations(context.Context, utilities.ID, utilities.ID, *provideroperations.Cursor, int) (provideroperations.ObservationPage, error)
	LatestObservation(context.Context, utilities.ID, utilities.ID) (provideroperations.ObservationPage, error)
	Ready(context.Context) error
}

type SyncPeerVerifier interface {
	Verify(*http.Request) error
}

// NewProviderBridgeHandler returns the complete private v1 contract without
// mounting it on the public API listener. The composition root must expose it
// only through a mutually authenticated private listener.
func NewProviderBridgeHandler(service ProviderBridgeService, verifier SyncPeerVerifier) http.Handler {
	router := chi.NewRouter()
	router.Use(requireSyncPeer(verifier))
	router.Post("/internal/v1/sync/provider-operations/{operation_id}", handleProviderOperation(service))
	router.Get("/internal/v1/sync/media-observations", handleProviderObservations(service))
	router.Get("/internal/v1/sync/provider-bridge/ready", handleProviderBridgeReadiness(service))
	return router
}

func handleProviderBridgeReadiness(service ProviderBridgeService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if service == nil || service.Ready(request.Context()) != nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Service is unavailable")
			return
		}
		writeJSON(w, http.StatusOK, struct {
			Status string `json:"status"`
		}{Status: "ready"})
	}
}

func requireSyncPeer(verifier SyncPeerVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			if verifier == nil {
				writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Service is unavailable")
				return
			}
			if err := verifier.Verify(request); err != nil {
				writeError(w, http.StatusUnauthorized, "sync.unauthorized", "Sync authentication required")
				return
			}
			next.ServeHTTP(w, request)
		})
	}
}

func handleProviderOperation(service ProviderBridgeService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Service is unavailable")
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
		if result.Outcome == provideroperations.OutcomeTerminalFailure && result.Reason == tenantlimits.RecordingLimitReason {
			// Sync decodes the top-level reason on non-2xx bridge responses.
			writeJSON(w, apiErrorTenantRecordingLimit.Status, map[string]any{
				"error":  map[string]string{"code": apiErrorTenantRecordingLimit.Code, "message": apiErrorTenantRecordingLimit.Message},
				"reason": result.Reason,
			})
			return
		}
		writeJSON(w, http.StatusOK, newProviderOperationResponse(result))
	}
}

func handleProviderObservations(service ProviderBridgeService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if service == nil {
			writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Service is unavailable")
			return
		}

		tenantID, episodeID, after, limit, err := providerObservationQuery(request)
		if err != nil {
			writeProviderBridgeError(w, err)
			return
		}
		latest := false
		if value := request.URL.Query().Get("latest"); value != "" {
			latest, err = strconv.ParseBool(value)
			if err != nil || (latest && after != nil) {
				writeProviderBridgeError(w, provideroperations.ErrInvalidObservationCursor)
				return
			}
		}
		var page provideroperations.ObservationPage
		if latest {
			page, err = service.LatestObservation(request.Context(), tenantID, episodeID)
		} else {
			page, err = service.ListObservations(request.Context(), tenantID, episodeID, after, limit)
		}
		if err != nil {
			writeProviderBridgeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, newProviderObservationPageResponse(page))
	}
}

func writeProviderBridgeError(w http.ResponseWriter, err error) {
	var maxBytesError *http.MaxBytesError
	switch {
	case errors.As(err, &maxBytesError):
		writeError(w, http.StatusRequestEntityTooLarge, "request.payload_too_large", "Request body is too large")
	case errors.Is(err, providerbridge.ErrUnavailable):
		writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Service is unavailable")
	case errors.Is(err, providerbridge.ErrInvalidProviderResult):
		writeError(w, http.StatusBadGateway, "provider.unavailable", "Provider result is unavailable")
	case errors.Is(err, provideroperations.ErrInvalidOperationID),
		errors.Is(err, provideroperations.ErrInvalidEffect),
		errors.Is(err, provideroperations.ErrInvalidTenantID),
		errors.Is(err, provideroperations.ErrInvalidEpisodeID),
		errors.Is(err, provideroperations.ErrInvalidParticipantID),
		errors.Is(err, provideroperations.ErrInvalidParticipantGeneration),
		errors.Is(err, provideroperations.ErrInvalidPublicationSource),
		errors.Is(err, provideroperations.ErrInvalidControlRevision),
		errors.Is(err, provideroperations.ErrInvalidRecordingID),
		errors.Is(err, provideroperations.ErrInvalidRecordingReservation),
		errors.Is(err, provideroperations.ErrInvalidObservationCursor):
		writeError(w, http.StatusBadRequest, "provider.invalid_contract", "Invalid provider bridge request")
	default:
		writeError(w, http.StatusInternalServerError, "internal.error", "Internal server error")
	}
}
