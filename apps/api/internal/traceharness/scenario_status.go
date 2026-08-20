package traceharness

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	statusdomain "github.com/q9labs/chalk/apps/api/internal/status"
)

func runRouteStatusMonitorIngest(ctx context.Context) (ScenarioResult, error) {
	now := deterministicClock()
	recorder := NewRecorder(now)
	service := &tracedStatusService{recorder: recorder, now: now}
	handler := httpapi.NewRouter(httpapi.Options{
		OpsIngestToken:  "trace-ops-token",
		RateLimit:       noRateLimits(now),
		StatusIngestion: service,
		StatusSnapshot:  service,
	})
	validBody := json.RawMessage(`{"result_key":"trace-run:api.health","run_id":"trace-run","monitor_key":"api.health","status":"healthy","checked_at":"2026-07-01T12:00:00Z","event_at":"2026-07-01T12:00:00Z","latency_ms":12,"reported_source":"trace-worker","reported_emitter_id":"trace-emitter","metadata":{"target_url":"https://private.example"},"details":{"error_message":"private detail"}}`)
	publicBody := json.RawMessage(`{"status":"healthy"}`)

	if _, err := runRouteTrace(ctx, routeTraceConfig{
		Name: RouteStatusMonitorIngestScenario, Recorder: recorder, Handler: handler,
		Method: http.MethodPost, Path: "/v1/ops/ingest/monitor-results", Body: validBody, DisplayBody: publicBody,
		Headers: map[string]string{"X-Ops-Ingest-Token": "trace-ops-token"}, ExpectedStatus: http.StatusAccepted,
	}); err != nil {
		return ScenarioResult{}, err
	}
	if _, err := runRouteTrace(ctx, routeTraceConfig{
		Name: RouteStatusMonitorIngestScenario, Recorder: recorder, Handler: handler,
		Method: http.MethodPost, Path: "/v1/ops/ingest/monitor-results", Body: validBody, DisplayBody: publicBody,
		Headers: map[string]string{"X-Ops-Ingest-Token": "wrong-token"}, ExpectedStatus: http.StatusUnauthorized,
	}); err != nil {
		return ScenarioResult{}, err
	}
	if _, err := runRouteTrace(ctx, routeTraceConfig{
		Name: RouteStatusMonitorIngestScenario, Recorder: recorder, Handler: handler,
		Method: http.MethodPost, Path: "/v1/ops/ingest/monitor-results", Body: json.RawMessage(`{}`),
		Headers: map[string]string{"X-Ops-Ingest-Token": "trace-ops-token"}, ExpectedStatus: http.StatusBadRequest,
	}); err != nil {
		return ScenarioResult{}, err
	}
	service.failSnapshot = true
	if _, err := runRouteTrace(ctx, routeTraceConfig{
		Name: RouteStatusMonitorIngestScenario, Recorder: recorder, Handler: handler,
		Method: http.MethodGet, Path: "/v1/status", ExpectedStatus: http.StatusServiceUnavailable,
	}); err != nil {
		return ScenarioResult{}, err
	}
	service.failSnapshot = false
	result, err := runRouteTrace(ctx, routeTraceConfig{
		Name: RouteStatusMonitorIngestScenario, Recorder: recorder, Handler: handler,
		Method: http.MethodGet, Path: "/v1/status", ExpectedStatus: http.StatusOK,
	})
	if err != nil {
		return result, err
	}
	return result, nil
}

type tracedStatusService struct {
	recorder     *Recorder
	now          func() time.Time
	failSnapshot bool
}

func (s *tracedStatusService) Ingest(_ context.Context, input statusdomain.MonitorResult) (statusdomain.IngestResult, error) {
	span := s.recorder.Start("service", "status.Service.Ingest", "validate monitor identity and persist an idempotent result", map[string]any{
		"monitor":    "[redacted]",
		"result_key": "[redacted]",
		"status":     input.Status,
	})
	s.recorder.Add("database", "status_monitor_results.insert", "append monitor result and atomically advance the current projection", map[string]any{
		"status": input.Status,
	})
	span.End("status result accepted", map[string]any{"duplicate": false}, nil)
	return statusdomain.IngestResult{ResultKey: input.ResultKey}, nil
}

func (s *tracedStatusService) Snapshot(_ context.Context) (statusdomain.PublicSnapshot, error) {
	span := s.recorder.Start("service", "status.Service.Snapshot", "read current monitor projection and derive public-safe component state", nil)
	if s.failSnapshot {
		s.recorder.Add("database", "status_monitor_current.select", "projection read failed; public status fails closed", nil)
		span.End("status projection unavailable", nil, statusdomain.ErrStatusUnavailable)
		return statusdomain.PublicSnapshot{}, statusdomain.ErrStatusUnavailable
	}
	now := s.now()
	span.End("public status snapshot returned", map[string]any{"overall": "operational", "component_count": 3, "private_fields": "redacted"}, nil)
	return statusdomain.PublicSnapshot{
		SchemaVersion: statusdomain.SchemaVersion,
		GeneratedAt:   now,
		Overall:       "operational",
		Components:    []statusdomain.Component{{ID: "api", Name: "API", Description: "Chalk control plane API", State: "operational"}},
	}, nil
}
