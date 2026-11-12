package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const (
	testTenantID  = "0198a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b"
	testJourneyID = "0198a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5c"
)

func decodeLogLines(t *testing.T, out *bytes.Buffer) []map[string]any {
	t.Helper()
	var lines []map[string]any
	for _, raw := range bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n")) {
		var line map[string]any
		if err := json.Unmarshal(raw, &line); err != nil {
			t.Fatalf("log line is not JSON: %v", err)
		}
		lines = append(lines, line)
	}
	return lines
}

func spanAttributes(span tracetest.SpanStub) map[string]string {
	attributes := map[string]string{}
	for _, kv := range span.Attributes {
		attributes[string(kv.Key)] = kv.Value.String()
	}
	return attributes
}

func TestFailedRequestLogNamesJourneyRouteTenantAndErrorCode(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previous) })

	var out bytes.Buffer
	logger := slog.New(correlationHandler{next: slog.NewJSONHandler(&out, nil)})
	router := chi.NewRouter()
	router.Post("/v1/tenants/{tenant_id}/episodes/{episode_id}/join", func(w http.ResponseWriter, r *http.Request) {
		RecordErrorCode(w, "episode.full")
		w.WriteHeader(http.StatusConflict)
	})
	handler := OTelHTTPMiddleware()(JourneyMiddleware(RequestMiddleware(logger)(router)))

	request := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+testTenantID+"/episodes/ep-1/join", nil)
	request.Header.Set(journeyHeader, testJourneyID)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	lines := decodeLogLines(t, &out)
	if len(lines) != 1 {
		t.Fatalf("got %d log lines, want 1: %s", len(lines), out.String())
	}
	line := lines[0]
	want := map[string]any{
		"journey_id": testJourneyID,
		"route":      "/v1/tenants/{tenant_id}/episodes/{episode_id}/join",
		"error_code": "episode.full",
		"tenant_id":  testTenantID,
		"status":     float64(http.StatusConflict),
	}
	for key, value := range want {
		if line[key] != value {
			t.Errorf("log %s = %v, want %v", key, line[key], value)
		}
	}
	if response.Header().Get(journeyHeader) != testJourneyID {
		t.Errorf("response journey header = %q", response.Header().Get(journeyHeader))
	}

	routed := 0
	for _, span := range exporter.GetSpans() {
		attributes := spanAttributes(span)
		if attributes["http.route"] == "" {
			continue
		}
		routed++
		if attributes["http.route"] != want["route"] || attributes[TenantIDKey] != testTenantID {
			t.Errorf("span %s attributes = %v", span.Name, attributes)
		}
	}
	if routed != 2 {
		t.Errorf("%d spans carry http.route, want the server span and the journey span", routed)
	}
}

func TestSuccessfulAndUnmatchedRequestsCarryNoErrorCodeOrRoute(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previous) })

	var out bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&out, nil))
	router := chi.NewRouter()
	router.Get("/v1/tenants/{tenant_id}/ping", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	handler := OTelHTTPMiddleware()(JourneyMiddleware(RequestMiddleware(logger)(router)))

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/tenants/not-a-uuid/ping", nil))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/nowhere", nil))

	for _, line := range decodeLogLines(t, &out) {
		if _, ok := line["error_code"]; ok {
			t.Errorf("log has error_code: %v", line)
		}
		if _, ok := line["tenant_id"]; ok {
			t.Errorf("log has tenant_id from a path that is not an ID: %v", line)
		}
	}
	for _, span := range exporter.GetSpans() {
		attributes := spanAttributes(span)
		if _, ok := attributes[TenantIDKey]; ok {
			t.Errorf("span %s has a tenant from a path that is not an ID", span.Name)
		}
		if route := attributes["http.route"]; route != "" && route != "/v1/tenants/{tenant_id}/ping" {
			t.Errorf("span %s route = %q", span.Name, route)
		}
	}
}

func TestHTTPFailureLogKeepsUpstreamStatusAndCodeBehindAnotherPublicStatus(t *testing.T) {
	var out bytes.Buffer
	ctx := context.Background()
	logger := slog.New(slog.NewJSONHandler(&out, nil))
	ctx = context.WithValue(ctx, requestLoggerContextKey{}, logger)

	upstream := mediaplane.UpstreamFailure{Status: http.StatusForbidden, Code: "media_token.subject_mismatch"}
	err := fmt.Errorf("%w: %w: %w", mediaplane.ErrProviderFailed, mediaplane.ErrProviderUnauthorized, upstream)
	LogHTTPError(ctx, http.MethodPost, "/v1/join", "media_provider.unavailable", err)

	line := decodeLogLines(t, &out)[0]
	if line["upstream_status"] != float64(http.StatusForbidden) || line["upstream_code"] != "media_token.subject_mismatch" {
		t.Errorf("upstream fields = %v", line)
	}
	if line["error"] != mediaplane.ErrProviderFailed.Error() {
		t.Errorf("error = %v", line["error"])
	}

	out.Reset()
	hostile := mediaplane.UpstreamFailure{Status: http.StatusForbidden, Code: "Bearer abc123 secret"}
	LogHTTPError(ctx, http.MethodPost, "/v1/join", "x", errors.Join(mediaplane.ErrProviderFailed, hostile))
	if line := decodeLogLines(t, &out)[0]; line["upstream_code"] != "unsafe" {
		t.Errorf("provider-controlled code reached the log: %v", line["upstream_code"])
	}
}

func TestRequestMediaIdentityReachesTheRequestLogFailureLogSpansAndReplacementLog(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previous) })

	var out bytes.Buffer
	logger := slog.New(correlationHandler{next: slog.NewJSONHandler(&out, nil)})
	router := chi.NewRouter()
	router.Post("/v1/media/sfu/tracks", func(w http.ResponseWriter, r *http.Request) {
		SetRequestMedia(r.Context(), "episode-1", "participant-1", "chalk_sfu")
		LogMediaConnectionReplacement(r.Context(), "access_refresh")
		LogMediaTrackClose(r.Context(), "user_mute", 2, false, true)
		LogMediaTrackClose(r.Context(), "free text with secrets", 1, true, false)
		LogHTTPError(r.Context(), r.Method, r.URL.Path, "media_provider.unavailable", errors.New("provider failed"))
		w.WriteHeader(http.StatusBadGateway)
	})
	handler := OTelHTTPMiddleware()(JourneyMiddleware(RequestMiddleware(logger)(router)))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/media/sfu/tracks", nil))

	hash := ParticipantIDHash("participant-1")
	if hash == "participant-1" || len(hash) != 64 {
		t.Fatalf("participant hash = %q", hash)
	}
	identified := map[string]bool{}
	closes := []any{}
	for _, line := range decodeLogLines(t, &out) {
		event, _ := line["event"].(string)
		if event == "media.track_close" {
			closes = append(closes, line["close_reason"])
		}
		if event == "" {
			event, _ = line["msg"].(string)
		}
		if line["episode_id"] != "episode-1" || line["participant_id_hash"] != hash || line["provider"] != "chalk_sfu" {
			t.Errorf("%s line lacks the media identity: %v", event, line)
			continue
		}
		identified[event] = true
	}
	for _, event := range []string{"media.connection_replacement", "media.track_close", "http.failure", "http.request"} {
		if !identified[event] {
			t.Errorf("no %s line carried the identity: %v", event, identified)
		}
	}
	if len(closes) != 2 || closes[0] != "user_mute" || closes[1] != "unspecified" {
		t.Errorf("close reasons = %v, want user_mute then unspecified for free text", closes)
	}

	tagged := 0
	for _, span := range exporter.GetSpans() {
		attributes := spanAttributes(span)
		if attributes["http.route"] == "" {
			continue
		}
		tagged++
		if attributes[EpisodeIDKey] != "episode-1" || attributes[ParticipantHashKey] != hash || attributes[MediaPlaneKey] != "chalk_sfu" {
			t.Errorf("span %s attributes = %v", span.Name, attributes)
		}
	}
	if tagged != 2 {
		t.Errorf("%d spans carry the identity, want the server span and the journey span", tagged)
	}
}

func TestARequestWithoutAMediaCredentialCarriesNoMediaIdentity(t *testing.T) {
	var out bytes.Buffer
	router := chi.NewRouter()
	router.Get("/v1/ping", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	RequestMiddleware(slog.New(slog.NewJSONHandler(&out, nil)))(router).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/ping", nil))
	for _, line := range decodeLogLines(t, &out) {
		if _, ok := line["participant_id_hash"]; ok {
			t.Errorf("request without a credential names a participant: %v", line)
		}
	}
}
