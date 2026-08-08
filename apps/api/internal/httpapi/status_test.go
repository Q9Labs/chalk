package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	statusdomain "github.com/q9labs/chalk/apps/api/internal/status"
)

type statusService struct {
	ingest   func(context.Context, statusdomain.MonitorResult) (statusdomain.IngestResult, error)
	snapshot func(context.Context) (statusdomain.PublicSnapshot, error)
}

func (s statusService) Ingest(ctx context.Context, result statusdomain.MonitorResult) (statusdomain.IngestResult, error) {
	return s.ingest(ctx, result)
}

func (s statusService) Snapshot(ctx context.Context) (statusdomain.PublicSnapshot, error) {
	return s.snapshot(ctx)
}

func TestStatusSnapshotIsAnonymousAndRedacted(t *testing.T) {
	now := time.Date(2026, 8, 8, 12, 0, 0, 0, time.UTC)
	handler := httpapi.NewRouter(httpapi.Options{StatusSnapshot: statusService{snapshot: func(context.Context) (statusdomain.PublicSnapshot, error) {
		return statusdomain.PublicSnapshot{
			SchemaVersion: 99,
			GeneratedAt:   now,
			Overall:       "private-internal-state",
			Components: []statusdomain.Component{{ID: "private-monitor", Name: "private", Description: "private", State: "private"}, {
				ID: "api", Name: "API", Description: "Chalk control plane API", State: statusdomain.StateOutage,
				CheckedAt:     func() *time.Time { value := now.Add(-time.Minute); return &value }(),
				LastChangedAt: func() *time.Time { value := now.Add(-2 * time.Minute); return &value }(),
			}},
		}, nil
	}}})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/status", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache-control = %q, want no-store", response.Header().Get("Cache-Control"))
	}
	for _, private := range []string{"monitor_key", "run_id", "private-result", "target_url", "error_message", "api.health"} {
		if strings.Contains(response.Body.String(), private) {
			t.Fatalf("public snapshot contains %q: %s", private, response.Body.String())
		}
	}
	var body struct {
		SchemaVersion int    `json:"schema_version"`
		Overall       string `json:"overall"`
		Components    []struct {
			ID    string `json:"id"`
			State string `json:"state"`
		} `json:"components"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if body.SchemaVersion != statusdomain.SchemaVersion || body.Overall != statusdomain.StateUnknown || len(body.Components) != 1 || body.Components[0].ID != "api" || body.Components[0].State != statusdomain.StateOutage {
		t.Fatalf("body = %#v", body)
	}
}

func TestStatusIngestRequiresConstantShapeTokenAndCanonicalPath(t *testing.T) {
	called := false
	service := statusService{ingest: func(context.Context, statusdomain.MonitorResult) (statusdomain.IngestResult, error) {
		called = true
		return statusdomain.IngestResult{}, nil
	}}
	handler := httpapi.NewRouter(httpapi.Options{OpsIngestToken: "ingest-secret", StatusIngestion: service})
	for _, token := range []string{"", "wrong-secret"} {
		request := httptest.NewRequest(http.MethodPost, "/v1/ops/ingest/monitor-results", bytes.NewBufferString(`{}`))
		request.Header.Set("X-Ops-Ingest-Token", token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("token %q status = %d, want 401", token, response.Code)
		}
	}
	if called {
		t.Fatal("unauthorized ingest reached service")
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/status", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("legacy status route = %d, want 404", response.Code)
	}
}

func TestStatusIngestAcceptsDuplicateAndRejectsInvalidBody(t *testing.T) {
	var got statusdomain.MonitorResult
	service := statusService{ingest: func(_ context.Context, result statusdomain.MonitorResult) (statusdomain.IngestResult, error) {
		got = result
		return statusdomain.IngestResult{ResultKey: result.ResultKey, Duplicate: true}, nil
	}}
	handler := httpapi.NewRouter(httpapi.Options{OpsIngestToken: "ingest-secret", StatusIngestion: service})
	body := `{"result_key":"run-1:api.health","run_id":"run-1","monitor_key":"api.health","status":"healthy","checked_at":"2026-08-08T11:59:00Z","event_at":"2026-08-08T11:59:00Z","latency_ms":12,"reported_source":"test","reported_emitter_id":"emitter","metadata":{"target_url":"https://private.test"},"details":{"error_message":"private"}}`
	request := httptest.NewRequest(http.MethodPost, "/v1/ops/ingest/monitor-results", bytes.NewBufferString(body))
	request.Header.Set("X-Ops-Ingest-Token", "ingest-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("duplicate status = %d, want 202: %s", response.Code, response.Body.String())
	}
	if !got.CheckedAt.Equal(time.Date(2026, 8, 8, 11, 59, 0, 0, time.UTC)) || got.MonitorKey != "api.health" {
		t.Fatalf("service input = %#v", got)
	}

	request = httptest.NewRequest(http.MethodPost, "/v1/ops/ingest/monitor-results", bytes.NewBufferString(`{"result_key":"bad"}`))
	request.Header.Set("X-Ops-Ingest-Token", "ingest-secret")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid status = %d, want 400: %s", response.Code, response.Body.String())
	}
}

func TestStatusSnapshotMapsDatabaseFailureTo503(t *testing.T) {
	handler := httpapi.NewRouter(httpapi.Options{StatusSnapshot: statusService{snapshot: func(context.Context) (statusdomain.PublicSnapshot, error) {
		return statusdomain.PublicSnapshot{}, errors.New("database down")
	}}})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/status", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("database failure = %d, want 503", response.Code)
	}

	handler = httpapi.NewRouter(httpapi.Options{StatusSnapshot: statusService{snapshot: func(context.Context) (statusdomain.PublicSnapshot, error) {
		return statusdomain.PublicSnapshot{}, statusdomain.ErrStatusUnavailable
	}}})
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/status", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("classified database failure = %d, want 503", response.Code)
	}
}
