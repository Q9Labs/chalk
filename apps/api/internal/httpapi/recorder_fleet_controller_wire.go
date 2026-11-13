package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func recorderFleetRequestKey(w http.ResponseWriter, request *http.Request, environment string, allowWait bool) (recorderfleet.PoolKey, bool) {
	query := request.URL.Query()
	roles, exists := query["role"]
	if !exists || len(roles) != 1 || len(query) != 1 && (!allowWait || len(query) != 2 || len(query["wait"]) != 1 || query.Get("wait") != "8") {
		writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder fleet role")
		return recorderfleet.PoolKey{}, false
	}
	key := recorderfleet.PoolKey{Environment: environment, Role: workeridentity.Role(roles[0])}
	if err := key.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder fleet role")
		return recorderfleet.PoolKey{}, false
	}
	return key, true
}

func writeRecorderFleetError(w http.ResponseWriter, request *http.Request, logger *slog.Logger, operation string, err error) {
	switch {
	case errors.Is(err, recorderfleet.ErrInventoryNotReady):
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusConflict, recorderfleet.InventoryNotReadyCode, "Recorder provider inventory is not ready")
	case errors.Is(err, recorderfleet.ErrBootstrapPending):
		w.Header().Set("Retry-After", "1")
		if diagnostic, ok := recorderfleet.BootstrapDiagnosticFromError(err); ok {
			writeJSON(w, http.StatusConflict, struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
				Diagnostic recorderfleet.BootstrapDiagnostic `json:"diagnostic"`
			}{Error: struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}{Code: recorderfleet.BootstrapPendingCode, Message: "Recorder worker certificate delivery is pending"}, Diagnostic: diagnostic})
			return
		}
		writeError(w, http.StatusConflict, recorderfleet.BootstrapPendingCode, "Recorder worker certificate delivery is pending")
	case errors.Is(err, recorderfleet.ErrNodeNotFound):
		writeError(w, http.StatusNotFound, "recorder_fleet.node_not_found", "Recorder fleet node not found")
	case errors.Is(err, recorderfleet.ErrAdmissionClosed):
		writeError(w, http.StatusConflict, "recorder_fleet.admission_closed", "Recorder fleet admission is closed")
	case errors.Is(err, recorderfleet.ErrRoleFence), errors.Is(err, recorderfleet.ErrInventoryDrift), errors.Is(err, recorderfleet.ErrInvalidConfig), errors.Is(err, recorderfleet.ErrInvalidDemand):
		writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder fleet request")
	default:
		logger.WarnContext(request.Context(), "recorder fleet operation failed",
			"operation", operation, "provider_node_id", chi.URLParam(request, "providerID"), "error", err)
		writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recorder fleet service is unavailable")
	}
}

type recorderFleetDemandResponse struct {
	SchemaVersion string              `json:"schema_version"`
	Environment   string              `json:"environment"`
	Role          workeridentity.Role `json:"role"`
	recorderfleet.Demand
}

type recorderFleetNodesResponse struct {
	SchemaVersion string                          `json:"schema_version"`
	Environment   string                          `json:"environment"`
	Role          workeridentity.Role             `json:"role"`
	Nodes         []recorderfleet.NodeObservation `json:"nodes"`
}

type recorderFleetBootstrapRequest struct {
	SchemaVersion string `json:"schema_version"`
	recorderfleet.BootstrapRequest
}

type recorderFleetBootstrapResponse struct {
	SchemaVersion string                     `json:"schema_version"`
	Environment   string                     `json:"environment"`
	Role          workeridentity.Role        `json:"role"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}

type recorderFleetCommandRequest struct {
	SchemaVersion string                     `json:"schema_version"`
	Environment   string                     `json:"environment"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}

type recorderFleetPoolRequest struct {
	SchemaVersion string `json:"schema_version"`
	recorderfleet.PoolProjection
}
