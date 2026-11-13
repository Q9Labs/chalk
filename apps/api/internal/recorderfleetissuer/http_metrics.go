package recorderfleetissuer

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
)

type statusWriter struct {
	http.ResponseWriter
	status int
	reason string
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
	case recorderbootstrapprotocol.ControllerAbandonPath:
		return "abandon"
	case recorderbootstrapprotocol.ControllerRevokePath:
		return "revoke"
	case recorderbootstrapprotocol.ChallengePath:
		return "challenge"
	case recorderbootstrapprotocol.BootstrapPath:
		return "bootstrap"
	case recorderbootstrapprotocol.DiagnosticPath:
		return "diagnostic"
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
	case status == http.StatusConflict:
		return "inventory_pending"
	case status == http.StatusServiceUnavailable:
		return "dependency_unavailable"
	default:
		return "failure"
	}
}
