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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/problemreports"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

type reportTestSender struct {
	deliveries []problemreports.Delivery
	err        error
}

func (s *reportTestSender) Send(_ context.Context, report problemreports.Delivery) error {
	if s.err != nil {
		return s.err
	}
	s.deliveries = append(s.deliveries, report)
	return nil
}

type reportAttributionRepository struct{ subject accessgrants.Subject }

func (r reportAttributionRepository) Attribution(_ context.Context, subject accessgrants.Subject) (problemreports.Attribution, error) {
	if subject != r.subject {
		return problemreports.Attribution{}, problemreports.ErrForbidden
	}
	return problemreports.Attribution{SpaceName: "New Call", ReporterName: "Tester person@example.com", Role: "guest"}, nil
}

func TestProblemReportsHTTP(t *testing.T) {
	subject := participantMediaSubject(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "report-test", KeyID: "test", PrivateKey: private})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "report-test", VerificationKeys: map[string]ed25519.PublicKey{"test": public}})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := issuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatal(err)
	}
	var rejectionLogs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&rejectionLogs, nil))
	var deliveredLogs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&deliveredLogs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	sender := &reportTestSender{}
	router := func(enabled bool) http.Handler {
		var port problemreports.Sender
		if enabled {
			port = sender
		}
		return NewRouter(Options{ProblemReports: problemreports.NewService(reportAttributionRepository{subject}, port), ParticipantMediaVerify: verifier, RateLimit: DefaultRateLimitOptions(), Middleware: []func(http.Handler) http.Handler{observability.RequestMiddleware(logger)}})
	}
	postResponse := func(handler http.Handler, token string, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+subject.TenantID.String()+"/problem-reports", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	post := func(handler http.Handler, token string, body string) int {
		return postResponse(handler, token, body).Code
	}
	report := `{"description":"Camera failed @everyone person@example.com حسن@مثال.مصر \"quoted name\"@example.com https://chalk.test/space/invite-secret Bearer hidden-secret token=private-value","diagnostics":"Connection: failed\nLast error: media.failed\nBrowser: Test Browser\nApp version: 1.0"}`
	expiredIssuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "report-test", KeyID: "test", PrivateKey: private, Now: func() time.Time { return time.Now().Add(-time.Hour) }})
	if err != nil {
		t.Fatal(err)
	}
	expired, err := expiredIssuer.Issue(context.Background(), subject)
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"", "invalid", credential.Token + "tampered", expired.Token} {
		if got := post(router(true), token, report); got != 401 {
			t.Fatalf("auth status=%d", got)
		}
	}
	for _, body := range []string{`{}`, `{"description":"  "}`, `{"description":42}`, `{"description":"ok","unknown":"no"}`, `{"description":"ok"} {}`} {
		if got := post(router(true), credential.Token, body); got != 400 {
			t.Fatalf("invalid body status=%d", got)
		}
	}
	for _, input := range []problemreports.Report{{Description: strings.Repeat("a", 1001)}, {Description: "ok", Diagnostics: strings.Repeat("b", 2001)}} {
		body, _ := json.Marshal(input)
		if got := post(router(true), credential.Token, string(body)); got != 400 {
			t.Fatalf("length status=%d", got)
		}
	}
	if got := post(router(false), credential.Token, report); got != 503 {
		t.Fatalf("unavailable status=%d", got)
	}
	other := subject
	other.EpisodeID = participantMediaID(t, "55555555-5555-4555-8555-555555555555")
	otherCredential, err := issuer.Issue(context.Background(), other)
	if err != nil {
		t.Fatal(err)
	}
	if got := post(router(true), otherCredential.Token, report); got != 403 {
		t.Fatalf("foreign participant status=%d", got)
	}
	for _, field := range []string{"problem_report.outcome", "participant_binding_mismatch", other.EpisodeID.String(), other.ParticipantID.String()} {
		if !strings.Contains(rejectionLogs.String(), field) {
			t.Errorf("missing rejection telemetry %s", field)
		}
	}
	for _, secret := range []string{otherCredential.Token, "Camera failed", "person@example.com"} {
		if strings.Contains(rejectionLogs.String(), secret) {
			t.Error("sensitive rejection telemetry")
		}
	}
	if got := post(router(true), credential.Token, `{"description":"`+strings.Repeat("a", reportBodyLimitBytes+1)+`"}`); got != 413 {
		t.Fatalf("body size status=%d", got)
	}
	if len(sender.deliveries) != 0 {
		t.Fatal("rejected reports reached Discord")
	}
	t.Run("worst_case_JSON_escapes_and_exact_wire_cap", func(t *testing.T) {
		escaped := `{"description":"` + strings.Repeat(`\ud83c\udfa5`, problemreports.MaxDescriptionCodePoints) + `","diagnostics":"` + strings.Repeat(`\ud83c\udfa5`, problemreports.MaxDiagnosticsCodePoints) + `"}`
		if got := post(router(true), credential.Token, escaped); got != 200 {
			t.Fatalf("valid surrogate-escaped fields status=%d", got)
		}
		const wireCap = 12*(problemreports.MaxDescriptionCodePoints+problemreports.MaxDiagnosticsCodePoints) + 1024
		atCap := escaped + strings.Repeat(" ", wireCap-len(escaped))
		if got := post(router(true), credential.Token, atCap); got != 200 {
			t.Fatalf("exact byte cap status=%d", got)
		}
		if got := post(router(true), credential.Token, atCap+" "); got != 413 {
			t.Fatalf("one byte over cap status=%d", got)
		}
		if len(sender.deliveries) != 2 || sender.deliveries[0].Description != strings.Repeat("🎥", problemreports.MaxDescriptionCodePoints) || sender.deliveries[0].Diagnostics != strings.Repeat("🎥", problemreports.MaxDiagnosticsCodePoints) {
			t.Fatal("escaped report fields changed before delivery")
		}
		sender.deliveries = nil
	})
	limited := router(true)
	for index := 0; index < 3; index++ {
		if got := post(limited, credential.Token, report); got != 200 {
			t.Fatalf("send status=%d", got)
		}
	}
	for index := 0; index < 25; index++ {
		if got := post(limited, credential.Token, report); got != 429 {
			t.Fatalf("participant rate status=%d", got)
		}
	}
	if !strings.Contains(rejectionLogs.String(), "participant_quota") || !strings.Contains(rejectionLogs.String(), "problem_report.outcome") {
		t.Error("missing participant quota rejection telemetry")
	}
	participantB := subject
	participantB.ParticipantID = participantMediaID(t, "66666666-6666-4666-8666-123456789012")
	proofB, err := issuer.Issue(context.Background(), participantB)
	if err != nil {
		t.Fatal(err)
	}
	// Rejected A attempts must leave the shared Episode bucket available to B.
	sharedLimits := DefaultRateLimitOptions()
	handlerA := NewRouter(Options{ProblemReports: problemreports.NewService(reportAttributionRepository{subject}, sender), ParticipantMediaVerify: verifier, RateLimit: sharedLimits})
	for index := 0; index < 25; index++ {
		post(handlerA, credential.Token, report)
	}
	handlerB := NewRouter(Options{ProblemReports: problemreports.NewService(reportAttributionRepository{participantB}, sender), ParticipantMediaVerify: verifier, RateLimit: sharedLimits})
	if got := post(handlerB, proofB.Token, report); got != 200 {
		t.Fatalf("A exhausted B's Episode capacity: status=%d", got)
	}
	if !strings.Contains(deliveredLogs.String(), "problem_report.outcome") {
		t.Error("missing accepted delivery evidence")
	}
	delivered := sender.deliveries[0]
	if delivered.CallID != subject.EpisodeID || delivered.SpaceName != "New Call" || delivered.ReporterName != "Tester person@example.com" || delivered.Role != "guest" || !strings.Contains(delivered.Description, "Camera failed") || !strings.Contains(delivered.Diagnostics, "Connection: failed") {
		t.Fatal("delivery port received incorrect report fields")
	}
	large, _ := json.Marshal(problemreports.Report{Description: strings.Repeat("🎥", 1000), Diagnostics: strings.Repeat("🎥", 2000)})
	if got := post(router(true), credential.Token, string(large)); got != 200 {
		t.Fatalf("unicode report status=%d", got)
	}
	sender.err = problemreports.ErrDelivery
	if got := post(router(true), credential.Token, report); got != 502 {
		t.Fatalf("delivery failure status=%d", got)
	}
	sender.err = nil
	if got := post(router(true), credential.Token, `{"description":"No diagnostics"}`); got != 200 {
		t.Fatalf("opt out status=%d", got)
	}
	if sender.deliveries[len(sender.deliveries)-1].Diagnostics != "" {
		t.Fatal("diagnostics opt-out lost")
	}
	t.Run("tenant scope rejection retains configured logs and correlated span", func(t *testing.T) {
		rejectionLogs.Reset()
		recorder := tracetest.NewSpanRecorder()
		provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
		defer func() { _ = provider.Shutdown(context.Background()) }()
		ctx, span := provider.Tracer("report-test").Start(context.Background(), "report-request")
		request := httptest.NewRequest(http.MethodPost, "/v1/tenants/99999999-9999-4999-8999-999999999999/problem-reports", strings.NewReader(report)).WithContext(ctx)
		request.Header.Set("Authorization", "Bearer "+credential.Token)
		response := httptest.NewRecorder()
		router(true).ServeHTTP(response, request)
		span.End()
		if response.Code != http.StatusForbidden {
			t.Fatalf("status=%d", response.Code)
		}
		for _, value := range []string{"problem_report.outcome", "tenant_scope_mismatch", subject.EpisodeID.String(), subject.ParticipantID.String()} {
			if !strings.Contains(rejectionLogs.String(), value) {
				t.Errorf("configured logger missing %s", value)
			}
		}
		if len(recorder.Ended()) != 1 {
			t.Fatal("request span missing")
		}
		events := recorder.Ended()[0].Events()
		eventJSON, err := json.Marshal(events)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range []string{"problem_report.outcome", "tenant_scope_mismatch", subject.EpisodeID.String(), subject.ParticipantID.String()} {
			if !strings.Contains(string(eventJSON), value) {
				t.Errorf("span missing %s", value)
			}
		}
		for _, sensitive := range []string{credential.Token, "Camera failed", "person@example.com"} {
			if strings.Contains(rejectionLogs.String()+string(eventJSON), sensitive) {
				t.Error("sensitive rejection telemetry")
			}
		}
	})

	t.Run("episode limit spans participants", func(t *testing.T) {
		rejectionLogs.Reset()
		recorder := tracetest.NewSpanRecorder()
		provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
		defer func() { _ = provider.Shutdown(context.Background()) }()
		ctx, span := provider.Tracer("report-test").Start(context.Background(), "episode-quota")
		limits := DefaultRateLimitOptions()
		for index := 0; index < 21; index++ {
			participant := subject
			participant.ParticipantID = participantMediaID(t, fmt.Sprintf("66666666-6666-4666-8666-%012d", index))
			proof, err := issuer.Issue(context.Background(), participant)
			if err != nil {
				t.Fatal(err)
			}
			handler := NewRouter(Options{ProblemReports: problemreports.NewService(reportAttributionRepository{participant}, sender), ParticipantMediaVerify: verifier, RateLimit: limits, Middleware: []func(http.Handler) http.Handler{observability.RequestMiddleware(logger)}})
			want := 200
			if index == 20 {
				want = 429
			}
			response := postResponse(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r.WithContext(ctx)) }), proof.Token, `{"description":"test"}`)
			if response.Code != want {
				t.Fatalf("episode limit request %d status=%d want=%d", index, response.Code, want)
			}
			if index == 20 {
				if !strings.Contains(rejectionLogs.String(), "episode_quota") || !strings.Contains(rejectionLogs.String(), "problem_report.outcome") {
					t.Fatal("missing bounded Episode quota rejection evidence")
				}
				if response.Header().Get("X-RateLimit-Limit") != "20" || response.Header().Get("X-RateLimit-Remaining") != "0" {
					t.Errorf("shared rejection must describe Episode quota, got %v", response.Header())
				}
				retryAfter, err := strconv.Atoi(response.Header().Get("Retry-After"))
				if err != nil || retryAfter < 1 {
					t.Errorf("shared rejection missing bounded retry delay: %v", response.Header())
				}
			}
		}
		span.End()
		events := recorder.Ended()[0].Events()
		if len(events) != 21 || events[20].Name != "problem_report.outcome" || events[20].Attributes[0].Value.AsString() != "episode_quota" {
			t.Fatal("missing bounded Episode quota span evidence")
		}
	})
	for _, enabled := range []bool{false, true} {
		response := httptest.NewRecorder()
		router(enabled).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/tenants/"+subject.TenantID.String()+"/problem-reports/availability", nil))
		want := fmt.Sprintf(`{"available":%t}`, enabled)
		if response.Code != 200 || !bytes.Contains(response.Body.Bytes(), []byte(want)) {
			t.Fatalf("availability=%s", response.Body.String())
		}
	}
	t.Run("tenant-only origin reaches availability and authenticated reports", func(t *testing.T) {
		const origin = "https://tenant-embed.example"
		tenant := subject.TenantID.String()
		other := "77777777-7777-4777-8777-777777777777"
		origins := &corsTestTenantAuthorizer{allowed: map[string]map[string]bool{tenant: {origin: true}, other: {origin: true}}}
		port := &reportTestSender{}
		handler := NewRouter(Options{CORS: CORSOptions{TenantOrigins: origins}, ProblemReports: problemreports.NewService(reportAttributionRepository{subject}, port), ParticipantMediaVerify: verifier, RateLimit: DefaultRateLimitOptions()})
		pathFor := func(operation string) string {
			for _, route := range PreviewRouteContracts() {
				if route.OperationID == operation {
					return strings.ReplaceAll(route.Path, "{tenant_id}", tenant)
				}
			}
			t.Fatalf("missing operation %s", operation)
			return ""
		}
		path := pathFor("sendProblemReport")
		request := func(method, path, origin, token string) *httptest.ResponseRecorder {
			r := httptest.NewRequest(method, path, strings.NewReader(`{"description":"Embedded guest cannot connect"}`))
			r.Header.Set("Origin", origin)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Access-Control-Request-Method", http.MethodPost)
			r.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
			if token != "" {
				r.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			return w
		}
		for _, method := range []string{http.MethodOptions, http.MethodPost} {
			w := request(method, path, origin, credential.Token)
			want := http.StatusOK
			if method == http.MethodOptions {
				want = http.StatusNoContent
			}
			if w.Code != want || w.Header().Get("Access-Control-Allow-Origin") != origin {
				t.Fatalf("%s status=%d, CORS=%q, want %d and tenant origin", method, w.Code, w.Header().Get("Access-Control-Allow-Origin"), want)
			}
		}
		w := request(http.MethodGet, pathFor("getProblemReportAvailability"), origin, "")
		if w.Code != http.StatusOK || w.Header().Get("Access-Control-Allow-Origin") != origin {
			t.Fatalf("availability status=%d, CORS=%q", w.Code, w.Header().Get("Access-Control-Allow-Origin"))
		}
		if w := request(http.MethodOptions, path, "https://unrelated.example", ""); w.Code != http.StatusForbidden {
			t.Fatalf("unrelated origin preflight status=%d", w.Code)
		}
		if w := request(http.MethodPost, path, origin, ""); w.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous status=%d", w.Code)
		}
		if w := request(http.MethodPost, strings.Replace(path, tenant, other, 1), origin, credential.Token); w.Code != http.StatusForbidden {
			t.Fatalf("cross-tenant report status=%d", w.Code)
		}
		if len(port.deliveries) != 1 {
			t.Fatalf("deliveries=%d, want one authenticated tenant report", len(port.deliveries))
		}
	})

}

func TestReportIndependentIPAndAccountCeilings(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := accessgrants.NewIssuer(accessgrants.IssuerConfig{Issuer: "ceilings", KeyID: "test", PrivateKey: private})
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := accessgrants.NewVerifier(accessgrants.VerifierConfig{Issuer: "ceilings", VerificationKeys: map[string]ed25519.PublicKey{"test": public}})
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	// The owning tenant is the account: participant proofs carry no user account ID.
	post := func(limits RateLimitOptions, index, account int, ip string) *httptest.ResponseRecorder {
		t.Helper()
		subject := participantMediaSubject(t)
		subject.TenantID = participantMediaID(t, fmt.Sprintf("11111111-1111-4111-8111-%012d", account))
		subject.ParticipantID = participantMediaID(t, fmt.Sprintf("66666666-6666-4666-8666-%012d", index))
		subject.EpisodeID = participantMediaID(t, fmt.Sprintf("77777777-7777-4777-8777-%012d", index))
		proof, err := issuer.Issue(context.Background(), subject)
		if err != nil {
			t.Fatal(err)
		}
		handler := NewRouter(Options{ProblemReports: problemreports.NewService(reportAttributionRepository{subject}, &reportTestSender{}), ParticipantMediaVerify: verifier, RateLimit: limits, Middleware: []func(http.Handler) http.Handler{observability.RequestMiddleware(logger)}})
		request := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+subject.TenantID.String()+"/problem-reports", strings.NewReader(`{"description":"Call problem"}`))
		request.RemoteAddr = ip + ":12345"
		request.Header.Set("Authorization", "Bearer "+proof.Token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	t.Run("IP across accounts", func(t *testing.T) {
		logs.Reset()
		limits := DefaultRateLimitOptions()
		for index := 0; index < 31; index++ {
			response := post(limits, index, index, "192.0.2.9")
			want := http.StatusOK
			if index == 30 {
				want = http.StatusTooManyRequests
				if response.Header().Get("X-RateLimit-Limit") != "30" || response.Header().Get("Retry-After") == "" {
					t.Fatal("missing IP ceiling headers")
				}
			}
			if response.Code != want {
				t.Fatalf("request %d status=%d want=%d", index, response.Code, want)
			}
		}
		if !strings.Contains(logs.String(), "ip_quota") || strings.Contains(logs.String(), "192.0.2.9") || strings.Contains(logs.String(), "Call problem") {
			t.Fatal("missing or sensitive IP ceiling evidence")
		}
		if got := post(limits, 31, 31, "192.0.2.10").Code; got != http.StatusOK {
			t.Fatalf("IP consumed another IP budget: %d", got)
		}
	})
	t.Run("account across IPs", func(t *testing.T) {
		logs.Reset()
		limits := DefaultRateLimitOptions()
		for index := 0; index < 101; index++ {
			response := post(limits, index, 1, fmt.Sprintf("192.0.2.%d", index+1))
			want := http.StatusOK
			if index == 100 {
				want = http.StatusTooManyRequests
				if response.Header().Get("X-RateLimit-Limit") != "100" || response.Header().Get("Retry-After") == "" {
					t.Fatal("missing account ceiling headers")
				}
			}
			if response.Code != want {
				t.Fatalf("request %d status=%d want=%d", index, response.Code, want)
			}
		}
		if !strings.Contains(logs.String(), "account_quota") || strings.Contains(logs.String(), "192.0.2.101") || strings.Contains(logs.String(), "Call problem") {
			t.Fatal("missing or sensitive account ceiling evidence")
		}
		if got := post(limits, 101, 2, "192.0.2.102").Code; got != http.StatusOK {
			t.Fatalf("account consumed another account budget: %d", got)
		}
	})
}

func (reportAttributionRepository) RecordDelivery(context.Context, accessgrants.Subject, utilities.ID) error {
	return nil
}
