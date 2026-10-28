package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"go.opentelemetry.io/otel/trace"
)

const connectionReportFixture = `{"version":1,"trigger":"join_failed","events":[{"event":"space_join_span","elapsed_ms":0,"step":"join","outcome":"started"},{"event":"sync_socket_close","elapsed_ms":400,"close_code":1006,"duration_ms":400},{"event":"connection_failed","elapsed_ms":401,"state":"joining","code":"sync_start_failed"}]}`

func TestMediaProjectionMismatchReport(t *testing.T) {
	const body = `{"version":1,"trigger":"media_projection_mismatch","events":[{"event":"media_projection_mismatch","elapsed_ms":3000,"source":"microphone","publication_state":"on","projection_state":"off","duration_ms":2750,"attempt":2,"outcome":"started"}]}`
	for _, test := range []struct {
		name, body string
		valid      bool
	}{
		{"microphone", body, true},
		{"camera", strings.ReplaceAll(body, "microphone", "camera"), true},
		{"private source", strings.ReplaceAll(body, "microphone", "private iPad label"), false},
		{"private state", strings.ReplaceAll(body, `"publication_state":"on"`, `"publication_state":"private"`), false},
		{"negative duration", strings.ReplaceAll(body, `"duration_ms":2750`, `"duration_ms":-1`), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
			_, err := decodeConnectionReport(request)
			if (err == nil) != test.valid {
				t.Fatalf("valid=%v, err=%v", test.valid, err)
			}
		})
	}
}

func TestConnectionReportBoundaryAndCorrelation(t *testing.T) {
	runtime, err := observability.Start(context.Background(), observability.Config{Environment: "test", Service: "connection-report-test", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := observability.TelemetryShutdownContext()
		defer cancel()
		if err := runtime.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	}()
	var logs bytes.Buffer
	verifier := &participantMediaVerifierStub{subject: participantMediaSubject(t)}
	router := chi.NewRouter()
	router.Use(observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil))))
	router.Use(observability.OTelHTTPMiddleware())
	connectionReportEndpoint(verifier).Mount(router, DefaultRateLimitOptions())
	send := func(body string, auth bool) int {
		r := httptest.NewRequest(http.MethodPost, "/tenants/11111111-1111-4111-8111-111111111111/connection-reports", strings.NewReader(body))
		if auth {
			r.Header.Set("Authorization", "Bearer "+participantMediaCredential)
		}
		r.Header.Set("traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, r)
		return response.Code
	}
	if got := send(connectionReportFixture, false); got != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", got)
	}
	mediaReport := strings.Replace(connectionReportFixture, `"code":"sync_start_failed"`, `"code":"media_start_failed","media_error_kind":"CloudflareSFUError","media_error_step":"sfu_tracks","http_status":503,"granted_audio":"granted","granted_video":"not_granted"`, 1)
	if got := send(mediaReport, true); got != http.StatusNoContent {
		t.Fatalf("report: %d", got)
	}
	participantHash := fmt.Sprintf("%x", sha256.Sum256([]byte(verifier.subject.ParticipantID.String())))
	var found bool
	for _, line := range strings.Split(logs.String(), "\n") {
		if !strings.Contains(line, `"event":"sdk.connection_report"`) {
			continue
		}
		found = true
		var logged struct {
			Report string `json:"report"`
		}
		if err := json.Unmarshal([]byte(line), &logged); err != nil {
			t.Fatal(err)
		}
		var report connectionReport
		if err := json.Unmarshal([]byte(logged.Report), &report); err != nil {
			t.Fatal(err)
		}
		if report.Events[1].CloseCode == nil || *report.Events[1].CloseCode != 1006 {
			t.Fatal("missing close code")
		}
		failure := report.Events[2]
		if failure.MediaErrorKind != "CloudflareSFUError" || failure.MediaErrorStep != "sfu_tracks" || failure.GrantedAudio != "granted" || failure.GrantedVideo != "not_granted" || failure.HTTPStatus == nil || *failure.HTTPStatus != 503 {
			t.Fatal("missing bounded media cause in production log projection")
		}
		for _, expected := range []string{participantHash, verifier.subject.EpisodeID.String(), "0af7651916cd43dd8448eb211c80319c", `"trigger":"join_failed"`} {
			if !strings.Contains(line, expected) {
				t.Errorf("missing %s in %s", expected, line)
			}
		}
		if strings.Contains(line, verifier.subject.ParticipantID.String()) || strings.Contains(line, participantMediaCredential) {
			t.Fatal("report log contains participant identity or credential")
		}
	}
	if !found {
		t.Fatal("no report log")
	}
}

func TestConnectionReportRejectsUnboundedOrPrivateInput(t *testing.T) {
	tests := []struct {
		name, body string
		status     int
	}{
		{"unknown field", strings.Replace(connectionReportFixture, `"version":1`, `"version":1,"token":"private"`, 1), 400},
		{"untrusted text", strings.Replace(connectionReportFixture, "sync_start_failed", "private@example.test", 1), 400},
		{"private media kind", strings.Replace(connectionReportFixture, `"state":"joining"`, `"state":"joining","media_error_kind":"private@example.test"`, 1), 400},
		{"private media step", strings.Replace(connectionReportFixture, `"state":"joining"`, `"state":"joining","media_error_step":"https://private.test/token"`, 1), 400},
		{"private granted audio", strings.Replace(connectionReportFixture, `"state":"joining"`, `"state":"joining","granted_audio":"device label"`, 1), 400},
		{"private granted video", strings.Replace(connectionReportFixture, `"state":"joining"`, `"state":"joining","granted_video":"device id"`, 1), 400},
		{"unknown event", strings.Replace(connectionReportFixture, "sync_socket_close", "192.0.2.1", 1), 400},
		{"version", strings.Replace(connectionReportFixture, `"version":1`, `"version":2`, 1), 400},
		{"empty", `{"version":1,"trigger":"join_failed","events":[]}`, 400},
		{"null", `null`, 400},
		{"negative time", strings.Replace(connectionReportFixture, `"elapsed_ms":0`, `"elapsed_ms":-1`, 1), 400},
		{"too large", connectionReportFixture + strings.Repeat(" ", ConnectionReportBodyLimit), 413},
		{"trailing JSON", connectionReportFixture + `{}`, 400},
	}
	var report connectionReport
	if err := json.Unmarshal([]byte(connectionReportFixture), &report); err != nil {
		t.Fatal(err)
	}
	report.Events = make([]connectionReportEvent, ConnectionReportEventLimit+1)
	for i := range report.Events {
		report.Events[i] = connectionReportEvent{Event: "state_changed"}
	}
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	tests = append(tests, struct {
		name, body string
		status     int
	}{"too many events", string(body), 400})
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			router := chi.NewRouter()
			connectionReportEndpoint(&participantMediaVerifierStub{subject: participantMediaSubject(t)}).Mount(router, DefaultRateLimitOptions())
			request := httptest.NewRequest(http.MethodPost, "/tenants/11111111-1111-4111-8111-111111111111/connection-reports", strings.NewReader(tc.body))
			request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != tc.status {
				t.Fatalf("status=%d, want=%d", response.Code, tc.status)
			}
		})
	}
}

func TestConnectionReportRateLimitUsesVerifiedParticipant(t *testing.T) {
	verifier := &participantMediaVerifierStub{subject: participantMediaSubject(t)}
	router := chi.NewRouter()
	limits := DefaultRateLimitOptions()
	limits.Now = func() time.Time { return time.Unix(1000, 0) }
	connectionReportEndpoint(verifier).Mount(router, limits)
	send := func(auth bool) int {
		request := httptest.NewRequest(http.MethodPost, "/tenants/11111111-1111-4111-8111-111111111111/connection-reports", strings.NewReader(connectionReportFixture))
		if auth {
			request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response.Code
	}
	for i := 0; i < 10; i++ {
		if got := send(false); got != 401 {
			t.Fatalf("anonymous status=%d", got)
		}
	}
	for i := 0; i < connectionReportParticipantLimit.Limit; i++ {
		if got := send(true); got != 204 {
			t.Fatalf("report %d status=%d", i, got)
		}
	}
	if got := send(true); got != 429 {
		t.Fatalf("limit status=%d", got)
	}
	verifier.subject.ParticipantID = participantMediaID(t, "55555555-5555-4555-8555-555555555555")
	if got := send(true); got != 204 {
		t.Fatalf("other participant status=%d", got)
	}
}

func TestConnectionReportCustomerOriginAndTenantIsolation(t *testing.T) {
	verifier := &participantMediaVerifierStub{subject: participantMediaSubject(t)}
	origin := "https://customer.example"
	router := NewRouter(Options{ParticipantMediaVerify: verifier,
		CORS:      CORSOptions{TenantOrigins: &corsTestTenantAuthorizer{allowed: map[string]map[string]bool{corsTestTenantID: {origin: true}}}},
		RateLimit: DefaultRateLimitOptions(),
	})
	for _, method := range []string{http.MethodOptions, http.MethodPost} {
		request := httptest.NewRequest(method, "/v1/tenants/"+corsTestTenantID+"/connection-reports", strings.NewReader(connectionReportFixture))
		request.Header.Set("Origin", origin)
		if method == http.MethodOptions {
			request.Header.Set("Access-Control-Request-Method", "POST")
			request.Header.Set("Access-Control-Request-Headers", "authorization,content-type,traceparent")
		} else {
			request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent || response.Header().Get("Access-Control-Allow-Origin") != origin {
			t.Fatalf("customer %s: %d %s", method, response.Code, response.Body.String())
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/tenants/55555555-5555-4555-8555-555555555555/connection-reports", strings.NewReader(connectionReportFixture))
	request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("foreign tenant: %d %s", response.Code, response.Body.String())
	}
}

func TestConnectionReportRejectionEvidence(t *testing.T) {
	cases := []struct {
		name, body, reason string
		status             int
	}{
		{"schema", strings.Replace(connectionReportFixture, `"version":1`, `"version":1,"private-field@example.test":"sensitive-value"`, 1), "schema", 400},
		{"trailing", connectionReportFixture + `{}`, "trailing_json", 400},
		{"oversized", connectionReportFixture + strings.Repeat(" ", ConnectionReportBodyLimit), "body_too_large", 413},
		{"version", strings.Replace(connectionReportFixture, `"version":1`, `"version":2`, 1), "version", 400},
		{"trigger", strings.Replace(connectionReportFixture, `"trigger":"join_failed"`, `"trigger":"sensitive-value"`, 1), "trigger", 400},
		{"count", `{"version":1,"trigger":"join_failed","events":[]}`, "event_count", 400},
		{"event label", strings.Replace(connectionReportFixture, "sync_socket_close", "sensitive-value", 1), "event_label", 400},
		{"negative time", strings.Replace(connectionReportFixture, `"elapsed_ms":0`, `"elapsed_ms":-1`, 1), "elapsed_range", 400},
		{"large time", strings.Replace(connectionReportFixture, `"elapsed_ms":0`, `"elapsed_ms":2147483648`, 1), "elapsed_range", 400},
		{"order", `{"version":1,"trigger":"join_failed","events":[{"event":"state_changed","elapsed_ms":2},{"event":"state_changed","elapsed_ms":1}]}`, "event_order", 400},
		{"state label", strings.Replace(connectionReportFixture, `"state":"joining"`, `"state":"sensitive-value"`, 1), "state_label", 400},
		{"code label", strings.Replace(connectionReportFixture, "sync_start_failed", "192.0.2.1", 1), "code_label", 400},
		{"attempt", `{"version":1,"trigger":"join_failed","events":[{"event":"recovery_attempt","elapsed_ms":0,"attempt":-1}]}`, "attempt_range", 400},
		{"duration", `{"version":1,"trigger":"join_failed","events":[{"event":"sync_socket_close","elapsed_ms":0,"duration_ms":-1}]}`, "duration_ms_range", 400},
		{"heartbeat", `{"version":1,"trigger":"join_failed","events":[{"event":"sync_socket_close","elapsed_ms":0,"heartbeat_gap_ms":2147483648}]}`, "heartbeat_gap_ms_range", 400},
		{"close code", `{"version":1,"trigger":"join_failed","events":[{"event":"sync_socket_close","elapsed_ms":0,"close_code":5000}]}`, "close_code_range", 400},
		{"HTTP status", `{"version":1,"trigger":"join_failed","events":[{"event":"media_http_error","elapsed_ms":0,"http_status":200}]}`, "http_status_range", 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			subject := participantMediaSubject(t)
			router := chi.NewRouter()
			router.Use(observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil))))
			connectionReportEndpoint(&participantMediaVerifierStub{subject: subject}).Mount(router, DefaultRateLimitOptions())
			traceID := trace.TraceID{1}
			span := trace.NewSpanContext(trace.SpanContextConfig{TraceID: traceID, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled})
			request := httptest.NewRequest(http.MethodPost, "/tenants/11111111-1111-4111-8111-111111111111/connection-reports", strings.NewReader(tc.body))
			request = request.WithContext(trace.ContextWithSpanContext(request.Context(), span))
			request.Header.Set("Authorization", "Bearer "+participantMediaCredential)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != tc.status {
				t.Fatalf("status=%d, want=%d", response.Code, tc.status)
			}
			var rejected int
			for _, line := range strings.Split(logs.String(), "\n") {
				if !strings.Contains(line, `"event":"sdk.connection_report.rejected"`) {
					continue
				}
				rejected++
				var record struct {
					Reason          string `json:"reason"`
					TraceID         string `json:"trace_id"`
					ParticipantHash string `json:"participant_id_hash"`
				}
				if err := json.Unmarshal([]byte(line), &record); err != nil {
					t.Fatal(err)
				}
				if record.Reason != tc.reason || record.TraceID != traceID.String() || record.ParticipantHash != fmt.Sprintf("%x", sha256.Sum256([]byte(subject.ParticipantID.String()))) {
					t.Fatalf("wrong rejection evidence: %s", line)
				}
			}
			if rejected != 1 {
				t.Fatalf("rejection records=%d, want=1", rejected)
			}
			for _, private := range []string{"private-field@example.test", "sensitive-value", "192.0.2.1", subject.ParticipantID.String(), participantMediaCredential} {
				if strings.Contains(logs.String(), private) {
					t.Fatalf("private input entered rejection logs: %s", private)
				}
			}
		})
	}
}
