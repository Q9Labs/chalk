package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type RecorderFleetControllerService interface {
	ObserveIdentity(context.Context, recorderfleet.NodeIdentity) (recorderfleet.NodeObservation, error)
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

func NewRecorderFleetControllerRouter(service RecorderFleetControllerService, verifier RecorderFleetControllerVerifier, environment string, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	router := chi.NewRouter()
	if service == nil || verifier == nil || strings.TrimSpace(environment) == "" {
		return router
	}
	router.Route("/internal/v1/recorder/fleet", func(router chi.Router) {
		router.Use(func(next http.Handler) http.Handler { return requireRecorderFleetController(verifier, next) })
		router.Get("/demand", recorderFleetDemandHandler(service, environment, logger))
		router.Get("/nodes", recorderFleetNodesHandler(service, environment, logger))
		router.Post("/nodes/{providerID}/leases", recorderFleetIdentityLeasesHandler(service, environment, logger))
		router.Post("/nodes/{providerID}/bootstrap", recorderFleetBootstrapHandler(service, environment, logger))
		router.Post("/nodes/{providerID}/bootstrap/abandon", recorderFleetBootstrapAbandonHandler(service, environment, logger))
		router.Post("/nodes/{providerID}/admission/close", recorderFleetCommandHandler(service, environment, false, logger))
		router.Post("/nodes/{providerID}/identity/revoke", recorderFleetCommandHandler(service, environment, true, logger))
		router.Put("/pool", recorderFleetPoolHandler(service, environment, logger))
	})
	return router
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

func recorderFleetDemandHandler(service RecorderFleetControllerService, environment string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		key, ok := recorderFleetRequestKey(w, request, environment, true)
		if !ok {
			return
		}
		demand, err := service.GetDemand(request.Context(), key)
		if err != nil {
			writeRecorderFleetError(w, request, logger, "get_demand", err)
			return
		}
		// The private listener's 10 s WriteTimeout bounds the whole response.
		if request.URL.Query().Get("wait") == "8" && demand.DesiredNodes == 0 {
			demand, err = waitForRecorderFleetDemand(request.Context(), service, key, demand, 8*time.Second, 500*time.Millisecond)
			if err != nil {
				if request.Context().Err() == nil {
					writeRecorderFleetError(w, request, logger, "get_demand", err)
				}
				return
			}
		}
		schema := recorderfleet.DemandSchemaVersion
		if request.Header.Get("X-Chalk-Fleet-Slot-Demand") == "1" && key.Role == workeridentity.RoleCapture && demand.CaptureCapacity != nil {
			schema = recorderfleet.SlotDemandSchemaVersion
		} else {
			demand.CaptureCapacity = nil
		}
		writeJSON(w, http.StatusOK, recorderFleetDemandResponse{
			SchemaVersion: schema, Environment: environment,
			Role: key.Role, Demand: demand,
		})
	}
}

// Rechecking the authoritative query also catches scheduled starts becoming
// due, and works across API replicas without process-local notification state.
func waitForRecorderFleetDemand(ctx context.Context, service RecorderFleetControllerService, key recorderfleet.PoolKey, demand recorderfleet.Demand, timeout, interval time.Duration) (recorderfleet.Demand, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return recorderfleet.Demand{}, ctx.Err()
		case <-timer.C:
			return demand, nil
		case <-ticker.C:
			var err error
			demand, err = service.GetDemand(ctx, key)
			if err != nil || demand.DesiredNodes > 0 {
				return demand, err
			}
		}
	}
}
