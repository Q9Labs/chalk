package recorderfleetissuer

import (
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const maximumRequestBytes = 32 << 10

type HTTPHandler struct {
	controllerVerifier recorderfleet.ControllerVerifier
	logger             *slog.Logger
	metrics            *issuerMetrics
	service            *Service
	workerVerifier     workeridentity.Verifier
	diagnosticMu       sync.Mutex
	nextDiagnosticAt   time.Time
}

func NewHTTPHandler(service *Service, controllerVerifier recorderfleet.ControllerVerifier, workerVerifier workeridentity.Verifier, logger *slog.Logger) (http.Handler, error) {
	if service == nil || logger == nil {
		return nil, ErrInvalidConfig
	}
	handler := &HTTPHandler{
		controllerVerifier: controllerVerifier, logger: logger, metrics: newIssuerMetrics(), service: service, workerVerifier: workerVerifier,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handler.health)
	mux.HandleFunc("GET /readyz", handler.ready)
	mux.HandleFunc("GET /metrics", handler.metricsHTTP)
	mux.HandleFunc("GET /v1/recorder-fleet/crl.pem", handler.crl)
	mux.HandleFunc("POST "+recorderbootstrapprotocol.ControllerBootstrapPath, handler.register)
	mux.HandleFunc("POST "+recorderbootstrapprotocol.ControllerAbandonPath, handler.abandon)
	mux.HandleFunc("POST "+recorderbootstrapprotocol.ControllerRevokePath, handler.revoke)
	mux.HandleFunc("POST "+recorderbootstrapprotocol.ChallengePath, handler.challenge)
	mux.HandleFunc("POST "+recorderbootstrapprotocol.BootstrapPath, handler.bootstrap)
	mux.HandleFunc("POST "+recorderbootstrapprotocol.DiagnosticPath, handler.diagnostic)
	mux.HandleFunc("POST "+recorderbootstrapprotocol.RenewPath, handler.renew)
	return handler.observe(mux), nil
}

func (handler *HTTPHandler) abandon(response http.ResponseWriter, request *http.Request) {
	if _, err := handler.controllerVerifier.Verify(request); err != nil {
		writeError(response, fmt.Errorf("%w: controller identity: %v", ErrUnauthorized, err))
		return
	}
	var input abandonRequest
	if decodeJSON(response, request, &input) != nil || input.SchemaVersion != recorderbootstrapprotocol.ControllerAbandonSchemaVersion {
		writeError(response, recorderbootstrapprotocol.ErrInvalidProtocol)
		return
	}
	if err := handler.service.AbandonBootstrap(input.BootstrapRequest); err != nil {
		writeError(response, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *HTTPHandler) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		started := time.Now()
		writer := &statusWriter{ResponseWriter: response, status: http.StatusOK}
		next.ServeHTTP(writer, request)
		operation := operationName(request.URL.Path)
		outcome := outcomeName(writer.status)
		handler.metrics.increment(operation, outcome)
		handler.logger.Info("recorder fleet issuer request",
			"operation", operation, "outcome", outcome, "status", writer.status, "reason", writer.reason,
			"duration_ms", time.Since(started).Milliseconds())
	})
}

func (handler *HTTPHandler) health(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write([]byte("{\"status\":\"ok\"}\n"))
}

func (handler *HTTPHandler) ready(response http.ResponseWriter, _ *http.Request) {
	err := handler.service.store.read(func(state persistedState) error {
		if state.SchemaVersion != stateSchemaVersion {
			return ErrInvalidConfig
		}
		return nil
	})
	response.Header().Set("Content-Type", "application/json")
	if err != nil {
		response.WriteHeader(http.StatusServiceUnavailable)
		_, _ = response.Write([]byte("{\"status\":\"unavailable\"}\n"))
		return
	}
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write([]byte("{\"status\":\"ready\"}\n"))
}

func (handler *HTTPHandler) register(response http.ResponseWriter, request *http.Request) {
	if _, err := handler.controllerVerifier.Verify(request); err != nil {
		writeError(response, fmt.Errorf("%w: controller identity: %v", ErrUnauthorized, err))
		return
	}
	var input registerRequest
	if decodeJSON(response, request, &input) != nil || input.SchemaVersion != recorderbootstrapprotocol.ControllerBootstrapSchemaVersion {
		writeError(response, recorderbootstrapprotocol.ErrInvalidProtocol)
		return
	}
	identity, delivered, err := handler.service.Register(request.Context(), input.BootstrapRequest)
	if err != nil {
		handler.logger.WarnContext(request.Context(), "recorder fleet bootstrap registration failed",
			"operation", "register", "provider_node_id", input.ProviderID, "error", err)
		writeError(response, err)
		return
	}
	status := http.StatusAccepted
	if delivered {
		status = http.StatusOK
	}
	result := registerResponse{SchemaVersion: recorderbootstrapprotocol.ControllerBootstrapSchemaVersion, Identity: identity}
	if !delivered {
		if registration, lookupErr := handler.service.registration(input.ProviderID); lookupErr == nil {
			result.Diagnostic = registration.BootstrapDiagnostic
		}
	}
	writeJSON(response, status, result)
}

func (handler *HTTPHandler) diagnostic(response http.ResponseWriter, request *http.Request) {
	// A fixed-size global limiter bounds parsing, inventory calls, and durable
	// writes without keeping an attacker-controlled map of peer addresses.
	handler.diagnosticMu.Lock()
	now := time.Now()
	limited := now.Before(handler.nextDiagnosticAt)
	if !limited {
		handler.nextDiagnosticAt = now.Add(250 * time.Millisecond)
	}
	handler.diagnosticMu.Unlock()
	if limited {
		response.Header().Set("Retry-After", "1")
		response.WriteHeader(http.StatusTooManyRequests)
		return
	}
	peerIP, err := directPeerIP(request)
	if err != nil {
		writeError(response, fmt.Errorf("%w: peer address: %v", ErrUnauthorized, err))
		return
	}
	var input recorderbootstrapprotocol.DiagnosticRequest
	if decodeJSON(response, request, &input) != nil {
		writeError(response, recorderbootstrapprotocol.ErrInvalidProtocol)
		return
	}
	if err := handler.service.RecordDiagnostic(request.Context(), peerIP, input); err != nil {
		writeError(response, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *HTTPHandler) revoke(response http.ResponseWriter, request *http.Request) {
	if _, err := handler.controllerVerifier.Verify(request); err != nil {
		writeError(response, fmt.Errorf("%w: controller identity: %v", ErrUnauthorized, err))
		return
	}
	var input revokeRequest
	if decodeJSON(response, request, &input) != nil || input.SchemaVersion != recorderbootstrapprotocol.ControllerRevokeSchemaVersion {
		writeError(response, recorderbootstrapprotocol.ErrInvalidProtocol)
		return
	}
	if err := handler.service.Revoke(input.Identity); err != nil {
		writeError(response, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *HTTPHandler) challenge(response http.ResponseWriter, request *http.Request) {
	peerIP, err := directPeerIP(request)
	if err != nil {
		handler.logger.Warn("recorder fleet issuer challenge rejected", "remote_addr", request.RemoteAddr, "error", err.Error())
		writeError(response, fmt.Errorf("%w: peer address: %v", ErrUnauthorized, err))
		return
	}
	var input recorderbootstrapprotocol.ChallengeRequest
	if decodeJSON(response, request, &input) != nil {
		writeError(response, recorderbootstrapprotocol.ErrInvalidProtocol)
		return
	}
	result, err := handler.service.Challenge(request.Context(), peerIP, input)
	if err != nil {
		handler.logger.Warn("recorder fleet issuer challenge rejected", "provider_id", input.ProviderID, "peer_ip", peerIP.String(), "error", err.Error())
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (handler *HTTPHandler) bootstrap(response http.ResponseWriter, request *http.Request) {
	peerIP, err := directPeerIP(request)
	if err != nil {
		writeError(response, fmt.Errorf("%w: peer address: %v", ErrUnauthorized, err))
		return
	}
	var input recorderbootstrapprotocol.BootstrapRequest
	if decodeJSON(response, request, &input) != nil {
		writeError(response, recorderbootstrapprotocol.ErrInvalidProtocol)
		return
	}
	result, err := handler.service.Bootstrap(request.Context(), peerIP, input)
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (handler *HTTPHandler) renew(response http.ResponseWriter, request *http.Request) {
	identity, err := handler.workerVerifier.Verify(request)
	if err != nil {
		writeError(response, fmt.Errorf("%w: worker identity: %v", ErrUnauthorized, err))
		return
	}
	peerIP, err := directPeerIP(request)
	if err != nil {
		writeError(response, fmt.Errorf("%w: peer address: %v", ErrUnauthorized, err))
		return
	}
	var input recorderbootstrapprotocol.RenewRequest
	if decodeJSON(response, request, &input) != nil {
		writeError(response, recorderbootstrapprotocol.ErrInvalidProtocol)
		return
	}
	result, err := handler.service.Renew(request.Context(), peerIP, identity, input)
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (handler *HTTPHandler) crl(response http.ResponseWriter, _ *http.Request) {
	result, err := handler.service.RevocationList()
	if err != nil {
		writeError(response, err)
		return
	}
	response.Header().Set("Content-Type", "application/pkix-crl")
	response.Header().Set("Cache-Control", "public, max-age=60")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(result)
}

func (handler *HTTPHandler) metricsHTTP(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Content-Type", "text/plain; version=0.0.4")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write([]byte(handler.metrics.render()))
}
