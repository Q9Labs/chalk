package httpapi

import (
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func recorderFleetBootstrapAbandonHandler(service RecorderFleetControllerService, environment string, logger *slog.Logger) http.HandlerFunc {
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
			writeRecorderFleetError(w, request, logger, "bootstrap_abandon", err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func recorderFleetNodesHandler(service RecorderFleetControllerService, environment string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		key, ok := recorderFleetRequestKey(w, request, environment, false)
		if !ok {
			return
		}
		nodes, err := service.ObserveNodes(request.Context(), key)
		if err != nil {
			writeRecorderFleetError(w, request, logger, "observe_nodes", err)
			return
		}
		if nodes == nil {
			nodes = []recorderfleet.NodeObservation{}
		}
		leaseAuthority := request.Header.Get("X-Chalk-Fleet-Lease-Authority") == "1"
		// Older controllers cannot preserve live counts under skew or decode revoked identities.
		if !leaseAuthority {
			nodes = slices.Clone(nodes)
			for index := range nodes {
				if nodes[index].ActiveLeases > 0 {
					writeRecorderFleetError(w, request, logger, "observe_nodes", fmt.Errorf("%w: legacy controller cannot safely observe live leases", recorderfleet.ErrProviderUnavailable))
					return
				}
				if request.Header.Get("X-Chalk-Fleet-Lease-Observation") != "1" {
					nodes[index].LeasesObservedAt = time.Time{}
				}
			}
			nodes = slices.DeleteFunc(nodes, func(node recorderfleet.NodeObservation) bool { return node.IdentityRevoked })
		} else {
			w.Header().Set("X-Chalk-Fleet-Lease-Authority", "1")
		}
		writeJSON(w, http.StatusOK, recorderFleetNodesResponse{
			SchemaVersion: recorderfleet.NodesSchemaVersion, Environment: environment,
			Role: key.Role, Nodes: nodes,
		})
	}
}

func recorderFleetBootstrapHandler(service RecorderFleetControllerService, environment string, logger *slog.Logger) http.HandlerFunc {
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
			writeRecorderFleetError(w, request, logger, "bootstrap", err)
			return
		}
		writeJSON(w, http.StatusOK, recorderFleetBootstrapResponse{
			SchemaVersion: recorderfleet.BootstrapSchemaVersion, Environment: environment,
			Role: body.Key.Role, Identity: identity,
		})
	}
}

func recorderFleetIdentityLeasesHandler(service RecorderFleetControllerService, environment string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		body, ok := decodeRecorderWorkerBody[recorderFleetCommandRequest](w, request)
		if !ok {
			return
		}
		// Version 2 also promises that managed claims require a fleet row.
		capability := request.Header.Get("X-Chalk-Fleet-Identity-Leases")
		if body.SchemaVersion != recorderfleet.CommandSchemaVersion || body.Environment != environment || body.Identity.ProviderID != chi.URLParam(request, "providerID") || (capability != "1" && capability != "2") {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recorder identity lease request")
			return
		}
		observation, err := service.ObserveIdentity(request.Context(), body.Identity)
		if err != nil {
			writeRecorderFleetError(w, request, logger, "observe_identity_leases", err)
			return
		}
		w.Header().Set("X-Chalk-Fleet-Identity-Leases", capability)
		writeJSON(w, http.StatusOK, struct {
			SchemaVersion string                        `json:"schema_version"`
			Environment   string                        `json:"environment"`
			Observation   recorderfleet.NodeObservation `json:"observation"`
		}{recorderfleet.CommandSchemaVersion, environment, observation})
	}
}

func recorderFleetCommandHandler(service RecorderFleetControllerService, environment string, revoke bool, logger *slog.Logger) http.HandlerFunc {
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
		operation := "close_admission"
		if revoke {
			operation = "revoke_identity"
			err = service.RevokeIdentity(request.Context(), body.Identity)
		} else {
			err = service.CloseAdmission(request.Context(), body.Identity)
		}
		if err != nil {
			writeRecorderFleetError(w, request, logger, operation, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func recorderFleetPoolHandler(service RecorderFleetControllerService, environment string, logger *slog.Logger) http.HandlerFunc {
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
			writeRecorderFleetError(w, request, logger, "publish_pool", err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
