package httpapi

import (
	"bytes"
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
)

const connectionReportFixture = `{"version":1,"trigger":"join_failed","events":[{"event":"space_join_span","elapsed_ms":0,"step":"join","outcome":"started"},{"event":"sync_socket_close","elapsed_ms":400,"close_code":1006,"duration_ms":400},{"event":"connection_failed","elapsed_ms":401,"state":"joining","code":"sync_start_failed"}]}`

func TestConnectionReportBoundaryAndCorrelation(t *testing.T) {
	var logs bytes.Buffer
	verifier := &participantMediaVerifierStub{subject: participantMediaSubject(t)}
	router := chi.NewRouter()
	router.Use(observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil))))
	router.Use(observability.OTelHTTPMiddleware())
	connectionReportEndpoint(verifier).Mount(router, DefaultRateLimitOptions())
	send := func(body string, auth bool) int {
		r := httptest.NewRequest(http.MethodPost, "/connection-reports", strings.NewReader(body))
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
	if got := send(connectionReportFixture, true); got != http.StatusNoContent {
		t.Fatalf("report: %d", got)
	}
	participantHash := fmt.Sprintf("%x", sha256.Sum256([]byte(verifier.subject.ParticipantID.String())))
	var found bool
	for _, line := range strings.Split(logs.String(), "\n") {
		if !strings.Contains(line, `"event":"sdk.connection_report"`) {
			continue
		}
		found = true
		for _, expected := range []string{participantHash, verifier.subject.EpisodeID.String(), "0af7651916cd43dd8448eb211c80319c", `"close_code":1006`, `"trigger":"join_failed"`} {
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
			request := httptest.NewRequest(http.MethodPost, "/connection-reports", strings.NewReader(tc.body))
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
		request := httptest.NewRequest(http.MethodPost, "/connection-reports", strings.NewReader(connectionReportFixture))
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
