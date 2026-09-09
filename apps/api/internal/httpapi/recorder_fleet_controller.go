package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type RecorderFleetControllerService interface {
	GetDemand(context.Context, recorderfleet.PoolKey) (recorderfleet.Demand, error)
	ObserveNodes(context.Context, recorderfleet.PoolKey) ([]recorderfleet.NodeObservation, error)
	EnsureBootstrap(context.Context, recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error)
	AbandonBootstrap(context.Context, recorderfleet.BootstrapRequest) error
	CloseAdmission(context.Context, recorderfleet.NodeIdentity) error
	RevokeIdentity(context.Context, recorderfleet.NodeIdentity) error
	PublishPool(context.Context, recorderfleet.PoolProjection) error
}

type RecorderFleetControllerVerifier interface {
	Verify(*http.Request) (recorderfleet.ControllerIdentity, error)
}

type recorderFleetControllerIdentityContextKey struct{}

func NewRecorderFleetControllerRouter(service RecorderFleetControllerService, verifier RecorderFleetControllerVerifier, environment string) http.Handler {
	router := chi.NewRouter()
	if service == nil || verifier == nil || strings.TrimSpace(environment) == "" {
		return router
	}
	router.Route("/internal/v1/recorder/fleet", func(router chi.Router) {
		router.Use(func(next http.Handler) http.Handler { return requireRecorderFleetController(verifier, next) })
		router.Get("/demand", recorderFleetDemandHandler(service, environment))
		router.Get("/nodes", recorderFleetNodesHandler(service, environment))
		router.Post("/nodes/{providerID}/bootstrap", recorderFleetBootstrapHandler(service, environment))
		router.Post("/nodes/{providerID}/bootstrap/abandon", recorderFleetBootstrapAbandonHandler(service, environment))
		router.Post("/nodes/{providerID}/admission/close", recorderFleetCommandHandler(service, environment, false))
		router.Post("/nodes/{providerID}/identity/revoke", recorderFleetCommandHandler(service, environment, true))
		router.Put("/pool", recorderFleetPoolHandler(service, environment))
	})
	return router
}

func recorderFleetBootstrapAbandonHandler(service RecorderFleetControllerService, environment string) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		body, ok := decodeRecorderWorkerBody[recorderFleetBootstrapRequest](w, request)
		if !ok {
			return
		}
		providerID := chi.URLParam(request, "providerID")
		if body.SchemaVersion != recorderfleet.BootstrapAbandonSchemaVersion || body.Key.Environment != environment || body.ProviderID != providerID {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder fleet bootstrap abandonment request")
			return
		}
		if err := service.AbandonBootstrap(request.Context(), body.BootstrapRequest); err != nil {
			writeRecorderFleetError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func requireRecorderFleetController(verifier RecorderFleetControllerVerifier, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		identity, err := verifier.Verify(request)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "controller.unauthorized", "Controller authentication required")
			return
		}
		ctx := context.WithValue(request.Context(), recorderFleetControllerIdentityContextKey{}, identity)
		next.ServeHTTP(w, request.WithContext(ctx))
	})
}

func recorderFleetDemandHandler(service RecorderFleetControllerService, environment string) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		key, ok := recorderFleetRequestKey(w, request, environment)
		if !ok {
			return
		}
		demand, err := service.GetDemand(request.Context(), key)
		if err != nil {
			writeRecorderFleetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderFleetDemandResponse{
			SchemaVersion: recorderfleet.DemandSchemaVersion, Environment: environment,
			Role: key.Role, Demand: demand,
		})
	}
}

func recorderFleetNodesHandler(service RecorderFleetControllerService, environment string) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		key, ok := recorderFleetRequestKey(w, request, environment)
		if !ok {
			return
		}
		nodes, err := service.ObserveNodes(request.Context(), key)
		if err != nil {
			writeRecorderFleetError(w, err)
			return
		}
		if nodes == nil {
			nodes = []recorderfleet.NodeObservation{}
		}
		writeJSON(w, http.StatusOK, recorderFleetNodesResponse{
			SchemaVersion: recorderfleet.NodesSchemaVersion, Environment: environment,
			Role: key.Role, Nodes: nodes,
		})
	}
}

func recorderFleetBootstrapHandler(service RecorderFleetControllerService, environment string) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		body, ok := decodeRecorderWorkerBody[recorderFleetBootstrapRequest](w, request)
		if !ok {
			return
		}
		providerID := chi.URLParam(request, "providerID")
		if body.SchemaVersion != recorderfleet.BootstrapSchemaVersion || body.Key.Environment != environment || body.ProviderID != providerID {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder fleet bootstrap request")
			return
		}
		identity, err := service.EnsureBootstrap(request.Context(), body.BootstrapRequest)
		if err != nil {
			writeRecorderFleetError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderFleetBootstrapResponse{
			SchemaVersion: recorderfleet.BootstrapSchemaVersion, Environment: environment,
			Role: body.Key.Role, Identity: identity,
		})
	}
}

func recorderFleetCommandHandler(service RecorderFleetControllerService, environment string, revoke bool) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		body, ok := decodeRecorderWorkerBody[recorderFleetCommandRequest](w, request)
		if !ok {
			return
		}
		if body.SchemaVersion != recorderfleet.CommandSchemaVersion || body.Environment != environment || body.Identity.ProviderID != chi.URLParam(request, "providerID") {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder fleet command")
			return
		}
		var err error
		if revoke {
			err = service.RevokeIdentity(request.Context(), body.Identity)
		} else {
			err = service.CloseAdmission(request.Context(), body.Identity)
		}
		if err != nil {
			writeRecorderFleetError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func recorderFleetPoolHandler(service RecorderFleetControllerService, environment string) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		body, ok := decodeRecorderWorkerBody[recorderFleetPoolRequest](w, request)
		if !ok {
			return
		}
		if body.SchemaVersion != recorderfleet.PoolSchemaVersion || body.Key.Environment != environment {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder fleet pool projection")
			return
		}
		if err := service.PublishPool(request.Context(), body.PoolProjection); err != nil {
			writeRecorderFleetError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func recorderFleetRequestKey(w http.ResponseWriter, request *http.Request, environment string) (recorderfleet.PoolKey, bool) {
	query := request.URL.Query()
	roles, exists := query["role"]
	if !exists || len(query) != 1 || len(roles) != 1 {
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

func writeRecorderFleetError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, recorderfleet.ErrNodeNotFound):
		writeError(w, http.StatusNotFound, "recorder_fleet.node_not_found", "Recorder fleet node not found")
	case errors.Is(err, recorderfleet.ErrAdmissionClosed):
		writeError(w, http.StatusConflict, "recorder_fleet.admission_closed", "Recorder fleet admission is closed")
	case errors.Is(err, recorderfleet.ErrRoleFence), errors.Is(err, recorderfleet.ErrInventoryDrift), errors.Is(err, recorderfleet.ErrInvalidConfig), errors.Is(err, recorderfleet.ErrInvalidDemand):
		writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder fleet request")
	default:
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
