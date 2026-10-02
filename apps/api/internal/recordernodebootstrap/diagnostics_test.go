package recordernodebootstrap

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderbootstrapprotocol"
)

func TestDiagnosticForPreservesBoundedFailureEvidence(t *testing.T) {
	err := stepError{step: "challenge", err: errors.Join(ErrBootstrapUnavailable, responseError{status: http.StatusAccepted})}
	diagnostic := diagnosticFor(err, 7)
	if err := diagnostic.Validate(); err != nil {
		t.Fatalf("diagnostic validation: %v", err)
	}
	if diagnostic.Step != "challenge" || diagnostic.AttemptCount != 7 || diagnostic.LastReasonCode != "http_status" || diagnostic.LastHTTPStatus != http.StatusAccepted {
		t.Fatalf("diagnostic = %+v", diagnostic)
	}
}

func TestRetryDeadlineHasStableReasonAndAttemptCount(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Millisecond)
	defer cancel()
	attempts := 0
	err := retry(ctx, func(context.Context, int) error {
		attempts++
		return ErrBootstrapUnavailable
	})
	if !errors.Is(err, context.DeadlineExceeded) || attempts != 1 || !strings.Contains(err.Error(), "bootstrap.retry_deadline_exceeded after 1 attempts") {
		t.Fatalf("retry error/attempts = %v/%d", err, attempts)
	}
}

func TestStepLogsDoNotIncludeRawErrors(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	logStep("challenge", 2, "challenge_unavailable", 0, errors.New("https://example.test/?token=secret person@example.test"))
	if strings.Contains(output.String(), "secret") || strings.Contains(output.String(), "example.test") {
		t.Fatalf("raw error leaked: %s", output.String())
	}
}

func TestCertificateFailureHasReportableDiagnostic(t *testing.T) {
	for _, failure := range []error{ErrBootstrapUnavailable, responseError{status: http.StatusServiceUnavailable}} {
		diagnostic := diagnosticFor(stepError{step: "certificate", err: failure}, 2)
		if err := diagnostic.Validate(); err != nil {
			t.Fatalf("certificate diagnostic rejected: %+v: %v", diagnostic, err)
		}
	}
}

func TestRequestDeadlineHasBoundedReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(100 * time.Millisecond):
		}
	}))
	defer server.Close()
	endpoint, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{baseURL: endpoint, httpClient: server.Client()}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	err = client.doJSON(ctx, recorderbootstrapprotocol.ChallengePath, nil, struct{}{}, new(struct{}))
	diagnostic := diagnosticFor(stepError{step: "challenge", err: err}, 2)
	if diagnostic.LastReasonCode != "deadline_exceeded" {
		t.Fatalf("deadline diagnostic = %+v, err=%v", diagnostic, err)
	}
}

func TestRenewalStateFailureHasBoundedDiagnostic(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	if err := Renew(t.Context(), Config{IdentityDirectory: t.TempDir()}); err == nil {
		t.Fatal("renewal succeeded without state")
	}
	if !strings.Contains(output.String(), "renewal_state_unavailable") {
		t.Fatalf("missing renewal diagnostic: %s", output.String())
	}
}
