package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

type bootstrapFailureService struct {
	RecorderFleetControllerService
	err error
}

func (service bootstrapFailureService) EnsureBootstrap(context.Context, recorderfleet.BootstrapRequest) (recorderfleet.NodeIdentity, error) {
	return recorderfleet.NodeIdentity{}, service.err
}

func TestRecorderFleetBootstrapConflictDiagnostics(t *testing.T) {
	diagnostic := recorderfleet.BootstrapDiagnostic{
		SchemaVersion: recorderfleet.BootstrapDiagnosticSchemaVersion,
		Step:          "certificate", AttemptCount: 2, LastReasonCode: "http_status", LastHTTPStatus: 503,
	}
	invalidDiagnostic := diagnostic
	invalidDiagnostic.Step = "sensitive-stage"
	invalidDiagnostic.LastReasonCode = "sensitive-reason"
	for _, test := range []struct {
		name       string
		err        error
		code       string
		message    string
		retryAfter string
		diagnostic *recorderfleet.BootstrapDiagnostic
	}{
		{name: "inventory", err: recorderfleet.ErrInventoryNotReady, code: recorderfleet.InventoryNotReadyCode,
			message: "Recorder provider inventory is not ready", retryAfter: "1"},
		{name: "pending", err: recorderfleet.ErrBootstrapPending, code: recorderfleet.BootstrapPendingCode,
			message: "Recorder worker certificate delivery is pending", retryAfter: "1"},
		{name: "admission", err: recorderfleet.ErrAdmissionClosed, code: "recorder_fleet.admission_closed",
			message: "Recorder fleet admission is closed"},
		{name: "pending stage", err: &recorderfleet.BootstrapPendingError{Diagnostic: diagnostic}, code: recorderfleet.BootstrapPendingCode,
			message: "Recorder worker certificate delivery is pending", retryAfter: "1", diagnostic: &diagnostic},
		{name: "invalid diagnostic", err: &recorderfleet.BootstrapPendingError{Diagnostic: invalidDiagnostic}, code: recorderfleet.BootstrapPendingCode,
			message: "Recorder worker certificate delivery is pending", retryAfter: "1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			service := bootstrapFailureService{err: fmt.Errorf("sensitive-error-detail: %w", test.err)}
			router := chi.NewRouter()
			router.Post("/internal/v1/recorder/fleet/nodes/{providerID}/bootstrap", recorderFleetBootstrapHandler(service, "test", logger))
			request := httptest.NewRequest(http.MethodPost, "/internal/v1/recorder/fleet/nodes/synthetic-node/bootstrap?token=sensitive-query", strings.NewReader(
				`{"schema_version":"recorder_fleet_bootstrap.v1","key":{"environment":"test","role":"capture"},"provider_id":"synthetic-node","node_name":"sensitive-body"}`))
			request.Header.Set("Authorization", "Bearer sensitive-token")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusConflict || response.Header().Get("Retry-After") != test.retryAfter {
				t.Fatalf("response = %d, headers = %v", response.Code, response.Header())
			}
			var body struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
				Diagnostic *recorderfleet.BootstrapDiagnostic `json:"diagnostic"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Error.Code != test.code || body.Error.Message != test.message || !reflect.DeepEqual(body.Diagnostic, test.diagnostic) {
				t.Fatalf("response body = %s", response.Body.String())
			}
			var event map[string]any
			if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &event); err != nil {
				t.Fatalf("expected one structured conflict event: %v; logs = %q", err, logs.String())
			}
			want := map[string]any{
				"event": "recorder_fleet.operation_failed", "operation": "bootstrap",
				"error_code": test.code, "http_status": float64(http.StatusConflict), "level": "INFO",
			}
			if test.diagnostic != nil {
				want["stage"] = test.diagnostic.Step
			}
			for key, value := range want {
				if event[key] != value {
					t.Errorf("%s = %v, want %v", key, event[key], value)
				}
			}
			delete(event, "time")
			delete(event, "msg")
			if !reflect.DeepEqual(event, want) || strings.Contains(logs.String(), "sensitive") || strings.Contains(logs.String(), "synthetic-node") {
				t.Errorf("unexpected or unsafe event fields: %s", logs.String())
			}
		})
	}
}
