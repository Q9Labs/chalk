package httpapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/telemetrydelivery"
	"go.opentelemetry.io/otel/baggage"
)

type subjectVerifier struct{ subject accessgrants.Subject }

func (v subjectVerifier) Verify(context.Context, string) (accessgrants.Subject, error) {
	return v.subject, nil
}

const telemetrySession = "5f0c2b8e-3a41-4d6e-9c57-0b1d2e3f4a5b"

type telemetryFixture struct {
	router chi.Router
	logs   *bytes.Buffer
	path   string
	ledger *telemetrydelivery.MemoryLedger
	// mediaToken and telemetryToken are real credentials of the same participant.
	mediaToken     string
	telemetryToken string
	subject        accessgrants.Subject
	// issuer signs further credentials, such as another participant's telemetry token.
	issuer accessgrants.Issuer
}

func newTelemetryFixture(t *testing.T) telemetryFixture {
	t.Helper()
	return newTelemetryFixtureFor(t, participantMediaSubject(t))
}

// newTelemetryFixtureFor serves the telemetry routes to real credentials of subject, with a memory ledger in which subject has joined.
func newTelemetryFixtureFor(t *testing.T, subject accessgrants.Subject) telemetryFixture {
	t.Helper()
	return newTelemetryFixtureWith(t, subject, func(ledger *telemetrydelivery.MemoryLedger) TelemetryLedger { return ledger })
}

// newTelemetryFixtureWith is newTelemetryFixtureFor with the routes served by port, which wraps the fixture's memory ledger.
func newTelemetryFixtureWith(t *testing.T, subject accessgrants.Subject, port func(*telemetrydelivery.MemoryLedger) TelemetryLedger) telemetryFixture {
	t.Helper()
	logs := &bytes.Buffer{}
	router := chi.NewRouter()
	router.Use(observability.RequestMiddleware(slog.New(slog.NewJSONHandler(logs, nil))))
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "chalk", KeyID: "key", PrivateKey: private})
	if err != nil {
		t.Fatal(err)
	}
	real, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "chalk", VerificationKeys: map[string]ed25519.PublicKey{"key": public}})
	if err != nil {
		t.Fatal(err)
	}
	media, err := issuer.Issue(t.Context(), subject)
	if err != nil {
		t.Fatal(err)
	}
	telemetry, err := issuer.IssueTelemetry(t.Context(), subject)
	if err != nil {
		t.Fatal(err)
	}
	ledger := &telemetrydelivery.MemoryLedger{}
	ledger.Join(telemetryIdentity(subject))
	verifier := subjectVerifier{subject: subject}
	limits := RateLimitOptions{Limiter: ratelimit.NewLocalLimiter()}
	telemetryEndpoint(real, real, port(ledger)).Mount(router, limits)
	connectionReportEndpoint(verifier).Mount(router, limits)
	callStatsEndpoint(verifier).Mount(router, limits)
	return telemetryFixture{router: router, logs: logs, path: "/tenants/" + subject.TenantID.String(), ledger: ledger, mediaToken: media.Token, telemetryToken: telemetry.Token, subject: subject, issuer: issuer}
}

func (f telemetryFixture) post(route, body string) *httptest.ResponseRecorder {
	return f.postWith(f.mediaToken, route, body)
}

func (f telemetryFixture) postWith(token, route, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, f.path+route, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	f.router.ServeHTTP(recorder, request)
	return recorder
}

// rows returns the log lines whose event is name.
func (f telemetryFixture) rows(t *testing.T, name string) []map[string]any {
	t.Helper()
	var rows []map[string]any
	for _, raw := range bytes.Split(bytes.TrimSpace(f.logs.Bytes()), []byte("\n")) {
		var row map[string]any
		if json.Unmarshal(raw, &row) == nil && row["event"] == name {
			rows = append(rows, row)
		}
	}
	return rows
}

func TestTelemetryLogsOneRowPerEventStampedFromTheCredential(t *testing.T) {
	f := newTelemetryFixture(t)
	body := `{"version":1,"client_session_id":"` + telemetrySession + `","events":[
		{"type":"space_join_span","seq":0,"elapsed_ms":1,"step":"join","outcome":"started"},
		{"type":"call_stats","seq":1,"elapsed_ms":30000,"stats":{"window_ms":30000,"connection_type":"udp","rtt_ms":40,"tracks":[{"mid":"1","kind":"audio","packets":900,"lost":3,"audio_energy":1200,"playout":"playing"}]}},
		{"type":"recovery_attempt","seq":2,"elapsed_ms":31000,"mechanism":"ice_restart","outage_ms":4000,"free_text":"hello"},
		{"type":"call_ended","seq":3,"elapsed_ms":60000,"end_reason":"left"}]}`
	recorder := f.post("/telemetry", body)
	if recorder.Code != http.StatusOK || strings.TrimSpace(recorder.Body.String()) != `{"accepted":3,"rejected":1,"duplicates":0,"acks":[],"rejections":[]}` {
		t.Fatalf("response = %d %s, want 200 with 3 accepted and 1 rejected", recorder.Code, recorder.Body.String())
	}
	rows := f.rows(t, "sdk.telemetry")
	if len(rows) != 3 {
		t.Fatalf("got %d telemetry rows, want 3\n%s", len(rows), f.logs.String())
	}
	subject := participantMediaSubject(t)
	stats := rows[1]
	for key, want := range map[string]any{
		"type": "call_stats", "seq": float64(1), "client_session_id": telemetrySession, "tenant_id": subject.TenantID.String(),
		"episode_id": subject.EpisodeID.String(), "provider": subject.Provider, "window_ms": float64(30000), "rtt_ms": float64(40),
	} {
		if stats[key] != want {
			t.Errorf("stats row %s = %v, want %v\n%s", key, stats[key], want, f.logs.String())
		}
	}
	if stats["received_at"] == nil || stats["participant_id_hash"] == nil || stats["tracks"] == nil {
		t.Errorf("stats row lacks received_at, participant hash or tracks: %v", stats)
	}
	rejected := f.rows(t, "sdk.telemetry.rejected")
	if len(rejected) != 1 || rejected[0]["reason"] != "schema" || rejected[0]["seq"] != float64(2) || rejected[0]["type"] != "recovery_attempt" {
		t.Fatalf("rejected rows = %v, want one schema rejection of recovery_attempt seq 2", rejected)
	}
	if strings.Contains(f.logs.String(), "hello") {
		t.Fatalf("free text reached the log:\n%s", f.logs.String())
	}
}

func TestTelemetryRefusesABatchWithAWrongFrame(t *testing.T) {
	f := newTelemetryFixture(t)
	event := `{"type":"call_ended","seq":0,"elapsed_ms":1,"end_reason":"left"}`
	for name, body := range map[string]string{
		"no session":      `{"version":1,"client_session_id":"nope","events":[` + event + `]}`,
		"no events":       `{"version":1,"client_session_id":"` + telemetrySession + `","events":[]}`,
		"unknown field":   `{"version":1,"client_session_id":"` + telemetrySession + `","events":[` + event + `],"x":1}`,
		"wrong version":   `{"version":2,"client_session_id":"` + telemetrySession + `","events":[` + event + `]}`,
		"trailing object": `{"version":1,"client_session_id":"` + telemetrySession + `","events":[` + event + `]}{}`,
	} {
		if code := f.post("/telemetry", body).Code; code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, code)
		}
	}
	if code := f.post("/telemetry", strings.Repeat(" ", 70000)).Code; code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized body: status = %d, want 413", code)
	}
	if rows := f.rows(t, "sdk.telemetry.rejected"); len(rows) != 6 {
		t.Fatalf("got %d rejection rows, want 6, one per refused batch\n%s", len(rows), f.logs.String())
	}
}

// The budget is bytes, so a client cannot go over it by sending many small batches,
// and a refused batch says when to come back.
func TestTelemetryBudgetIsInBytesAndRefusalIsLogged(t *testing.T) {
	f := newTelemetryFixture(t)
	filler := fmt.Sprintf(`{"type":"call_ended","seq":0,"elapsed_ms":1,"end_reason":"left"}%s`, strings.Repeat(" ", 60000))
	body := `{"version":1,"client_session_id":"` + telemetrySession + `","events":[` + filler + `]}`
	var refused *httptest.ResponseRecorder
	accepted := 0
	for range 100 {
		recorder := f.post("/telemetry", body)
		if recorder.Code == http.StatusTooManyRequests {
			refused = recorder
			break
		}
		accepted++
	}
	if refused == nil {
		t.Fatal("100 batches of 60 KB were all accepted, want the 4 MiB budget to refuse")
	}
	if want := (telemetryBudget.Limit / len(body)); accepted < want-1 || accepted > want+1 {
		t.Errorf("accepted %d batches before the refusal, want about %d", accepted, want)
	}
	if refused.Header().Get("Retry-After") == "" {
		t.Error("429 has no Retry-After")
	}
	rows := f.rows(t, "rate_limit.exhausted")
	if len(rows) != 1 || rows[0]["policy"] != telemetryBudget.Name {
		t.Fatalf("rate-limit rows = %v, want one for %s", rows, telemetryBudget.Name)
	}
}

// Reports from SDKs that predate telemetry end up as the same rows.
func TestOldRoutesWriteTelemetryRows(t *testing.T) {
	f := newTelemetryFixture(t)
	report := `{"version":1,"trigger":"join_failed","events":[{"event":"space_join_span","elapsed_ms":5,"step":"start_media","outcome":"failed","media_error_kind":"CloudflareSFUError"}]}`
	if code := f.post("/connection-reports", report).Code; code != http.StatusNoContent {
		t.Fatalf("connection report status = %d, want 204", code)
	}
	stats := `{"version":1,"samples":[{"elapsed_ms":30000,"window_ms":30000,"connection_type":"turn","rtt_ms":80}]}`
	if code := f.post("/call-stats", stats).Code; code != http.StatusNoContent {
		t.Fatalf("call stats status = %d, want 204", code)
	}
	rows := f.rows(t, "sdk.telemetry")
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2\n%s", len(rows), f.logs.String())
	}
	join, call := rows[0], rows[1]
	if join["type"] != "space_join_span" || join["outcome"] != "failed" || join["legacy_route"] != "connection-reports" || join["trigger"] != "join_failed" ||
		join["provider"] != accessgrants.ProviderCloudflareSFU {
		t.Errorf("join row = %v", join)
	}
	if call["type"] != "call_stats" || call["connection_type"] != "turn" || call["window_ms"] != float64(30000) || call["legacy_route"] != "call-stats" {
		t.Errorf("call stats row = %v", call)
	}
	// The session comes from the request's baggage; a value that is not an id must not reach a log row.
	withSession := func(value string) {
		member, err := baggage.NewMemberRaw(observability.SessionIDKey, value)
		if err != nil {
			t.Fatal(err)
		}
		bag, err := baggage.New(member)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, f.path+"/connection-reports", strings.NewReader(report)).WithContext(baggage.ContextWithBaggage(context.Background(), bag))
		request.Header.Set("Authorization", "Bearer credential")
		request.Header.Set("Content-Type", "application/json")
		f.router.ServeHTTP(httptest.NewRecorder(), request)
	}
	withSession(telemetrySession)
	if !strings.Contains(f.logs.String(), `"client_session_id":"`+telemetrySession+`"`) {
		t.Fatalf("a valid session id from the baggage is not in the log, so this test proves nothing:\n%s", f.logs.String())
	}
	withSession("private@example.test")
	if strings.Contains(f.logs.String(), "private@example.test") {
		t.Errorf("a session id that is not an id reached a log row:\n%s", f.logs.String())
	}
	if code := f.post("/connection-reports", `{"version":1,"trigger":"private@example.test","events":[]}`).Code; code != http.StatusBadRequest || strings.Contains(f.logs.String(), "private@example.test") {
		t.Errorf("report with a free-text trigger: status = %d, want 400 and nothing of it in the log", code)
	}
	if code := f.post("/connection-reports", `{"version":1,"trigger":"join_failed","events":[{"event":"access_retry","elapsed_ms":5,"receivers_stopped":1}]}`).Code; code != http.StatusBadRequest {
		t.Errorf("event with a field of another type: status = %d, want 400", code)
	}
}
