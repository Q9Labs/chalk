package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestClaimAdmissionClosedDrainsBeforeReadinessRefresh(t *testing.T) {
	for _, slots := range []int{1, 3} {
		t.Run(fmt.Sprintf("capture-%d", slots), func(t *testing.T) {
			client := admissionClosedClient(t, http.StatusLocked, "worker.admission_closed")
			daemon, err := NewCaptureDaemon(client, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
				return nil, errors.New("closed admission must not start an attempt")
			}), CaptureDaemonConfig{Slots: slots})
			if err != nil {
				t.Fatal(err)
			}
			assertClaimDrainReadiness(t, daemon, slots)
		})
	}
	t.Run("render", func(t *testing.T) {
		client := admissionClosedClient(t, http.StatusLocked, "worker.admission_closed")
		daemon := renderDaemonForTest(t, client, &renderAttemptStub{}, nil)
		assertClaimDrainReadiness(t, daemon, 1)
	})
}

func assertClaimDrainReadiness(t *testing.T, daemon DrainableWorkerDaemon, slots int) {
	t.Helper()
	reports := &readinessControlStub{reports: make(chan WorkerReadiness, 4)}
	reporter, err := NewReadinessReporter(reports)
	if err != nil {
		t.Fatal(err)
	}
	// No refresh can tell the daemon to drain: the claim response must do it.
	reporter.after = func(time.Duration) <-chan time.Time { return make(chan time.Time) }
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	if err := reporter.Run(ctx, daemon); err != nil {
		t.Fatalf("expected clean drain, got %v", err)
	}
	assertReadinessReport(t, reports.reports, true, slots, ReadinessReasonReady)
	assertReadinessReport(t, reports.reports, false, 0, ReadinessReasonDraining)
}

func TestClaimAdmissionResponseCompatibility(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		code   string
	}{
		{"old-api", http.StatusUnauthorized, "worker.unauthorized"},
		{"unrelated-locked", http.StatusLocked, "other.locked"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := admissionClosedClient(t, test.status, test.code)
			id, err := utilities.NewID()
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.Claim(t.Context(), recordingpipeline.ClaimInput{ClaimRequestID: id, LeaseFor: time.Minute})
			var httpErr HTTPError
			if !errors.As(err, &httpErr) || !httpErr.Terminal || errors.Is(err, ErrWorkerDraining) {
				t.Fatalf("expected unchanged terminal failure, got %v", err)
			}
		})
	}
	// This is the old worker's unchanged status classifier.
	var old HTTPError
	if !errors.As(classifyHTTPError(http.StatusLocked), &old) || !old.Terminal || old.Retryable || old.Fenced {
		t.Fatalf("old worker classification changed: %+v", old)
	}
}

func admissionClosedClient(t *testing.T, status int, code string) *ControlPlaneClient {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/recorder/jobs/claim" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = fmt.Fprintf(w, `{"error":{"code":%q}}`, code)
	}))
	t.Cleanup(server.Close)
	client, err := NewControlPlaneClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client
}
