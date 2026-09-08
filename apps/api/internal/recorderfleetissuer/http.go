package recorderfleetissuer

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"sort"
	"strings"
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
	mux.HandleFunc("POST "+recorderbootstrapprotocol.ControllerRevokePath, handler.revoke)
	mux.HandleFunc("POST "+recorderbootstrapprotocol.ChallengePath, handler.challenge)
	mux.HandleFunc("POST "+recorderbootstrapprotocol.BootstrapPath, handler.bootstrap)
	mux.HandleFunc("POST "+recorderbootstrapprotocol.RenewPath, handler.renew)
	return handler.observe(mux), nil
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
			"operation", operation, "outcome", outcome, "status", writer.status, "duration_ms", time.Since(started).Milliseconds())
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
		writeError(response, ErrUnauthorized)
		return
	}
	var input registerRequest
	if decodeJSON(response, request, &input) != nil || input.SchemaVersion != recorderbootstrapprotocol.ControllerBootstrapSchemaVersion {
		writeError(response, recorderbootstrapprotocol.ErrInvalidProtocol)
		return
	}
	identity, delivered, err := handler.service.Register(request.Context(), input.BootstrapRequest)
	if err != nil {
		writeError(response, err)
		return
	}
	status := http.StatusAccepted
	if delivered {
		status = http.StatusOK
	}
	writeJSON(response, status, registerResponse{SchemaVersion: recorderbootstrapprotocol.ControllerBootstrapSchemaVersion, Identity: identity})
}

func (handler *HTTPHandler) revoke(response http.ResponseWriter, request *http.Request) {
	if _, err := handler.controllerVerifier.Verify(request); err != nil {
		writeError(response, ErrUnauthorized)
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
		writeError(response, ErrUnauthorized)
		return
	}
	var input recorderbootstrapprotocol.ChallengeRequest
	if decodeJSON(response, request, &input) != nil {
		writeError(response, recorderbootstrapprotocol.ErrInvalidProtocol)
		return
	}
	result, err := handler.service.Challenge(request.Context(), peerIP, input)
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (handler *HTTPHandler) bootstrap(response http.ResponseWriter, request *http.Request) {
	peerIP, err := directPeerIP(request)
	if err != nil {
		writeError(response, ErrUnauthorized)
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
		writeError(response, ErrUnauthorized)
		return
	}
	peerIP, err := directPeerIP(request)
	if err != nil {
		writeError(response, ErrUnauthorized)
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

func decodeJSON(response http.ResponseWriter, request *http.Request, output any) error {
	request.Body = http.MaxBytesReader(response, request.Body, maximumRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func directPeerIP(request *http.Request) (netip.Addr, error) {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return netip.Addr{}, err
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, err
	}
	return address.Unmap(), nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, recorderbootstrapprotocol.ErrInvalidProtocol):
		status = http.StatusBadRequest
	case errors.Is(err, ErrUnauthorized), errors.Is(err, ErrConflict):
		status = http.StatusForbidden
	case errors.Is(err, recorderfleet.ErrProviderUnavailable):
		status = http.StatusServiceUnavailable
	}
	writeJSON(response, status, struct {
		Error string `json:"error"`
	}{Error: http.StatusText(status)})
}

type registerRequest struct {
	SchemaVersion string `json:"schema_version"`
	recorderfleet.BootstrapRequest
}

type registerResponse struct {
	SchemaVersion string                     `json:"schema_version"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}

type revokeRequest struct {
	SchemaVersion string                     `json:"schema_version"`
	Identity      recorderfleet.NodeIdentity `json:"identity"`
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusWriter) WriteHeader(status int) {
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

type issuerMetrics struct {
	mu       sync.Mutex
	requests map[string]uint64
}

func newIssuerMetrics() *issuerMetrics {
	return &issuerMetrics{requests: make(map[string]uint64)}
}

func (metrics *issuerMetrics) increment(operation, outcome string) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.requests[operation+"\x00"+outcome]++
}

func (metrics *issuerMetrics) render() string {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	keys := make([]string, 0, len(metrics.requests))
	for key := range metrics.requests {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var output strings.Builder
	output.WriteString("# HELP chalk_recorder_fleet_issuer_requests_total Issuer HTTP requests by bounded operation and outcome.\n")
	output.WriteString("# TYPE chalk_recorder_fleet_issuer_requests_total counter\n")
	for _, key := range keys {
		operation, outcome, _ := strings.Cut(key, "\x00")
		_, _ = fmt.Fprintf(&output, "chalk_recorder_fleet_issuer_requests_total{operation=%q,outcome=%q} %d\n", operation, outcome, metrics.requests[key])
	}
	return output.String()
}

func operationName(path string) string {
	switch path {
	case "/healthz":
		return "health"
	case "/readyz":
		return "readiness"
	case "/metrics":
		return "metrics"
	case recorderbootstrapprotocol.ControllerBootstrapPath:
		return "register"
	case recorderbootstrapprotocol.ControllerRevokePath:
		return "revoke"
	case recorderbootstrapprotocol.ChallengePath:
		return "challenge"
	case recorderbootstrapprotocol.BootstrapPath:
		return "bootstrap"
	case recorderbootstrapprotocol.RenewPath:
		return "renew"
	case "/v1/recorder-fleet/crl.pem":
		return "crl"
	default:
		return "unknown"
	}
}

func outcomeName(status int) string {
	switch {
	case status >= 200 && status < 300:
		return "success"
	case status == http.StatusBadRequest:
		return "invalid"
	case status == http.StatusForbidden || status == http.StatusUnauthorized:
		return "rejected"
	case status == http.StatusServiceUnavailable:
		return "dependency_unavailable"
	default:
		return "failure"
	}
}
