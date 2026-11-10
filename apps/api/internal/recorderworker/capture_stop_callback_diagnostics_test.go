package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureStoppedCallbackFailureDiagnosticsSurviveSanitization(t *testing.T) {
	for _, test := range []struct {
		name    string
		failure error
		timeout time.Duration
		outcome string
		status  int
		code    string
		want    error
		block   bool
	}{
		{"stop pending until timeout", HTTPError{Status: 503, Code: "episode.stop_pending", Retryable: true}, 150 * time.Millisecond, "timed_out", 503, "episode.stop_pending", context.DeadlineExceeded, false},
		{"stale lease", HTTPError{Status: 409, Code: "lease.stale", Fenced: true}, time.Second, "returned", 409, "lease.stale", ErrControlPlaneFenced, false},
		{"transport timeout", TransportError{Err: errors.New("secret transport address")}, 20 * time.Millisecond, "timed_out", 0, "", context.DeadlineExceeded, false},
		{"request consumes timeout", nil, 20 * time.Millisecond, "timed_out", 0, "", context.DeadlineExceeded, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			lifecycle := &captureStoppedSequenceLifecycle{repeat: test.failure}
			if test.block {
				lifecycle.firstCall = make(chan struct{})
				lifecycle.releaseFirst = make(chan struct{})
			}
			err := captureStoppedTestAttempt(t, time.UnixMilli(1000).UTC(), lifecycle, test.timeout).Run(context.Background())
			if !errors.Is(err, test.want) {
				t.Fatalf("callback error = %v, want %v", err, test.want)
			}
			_, detail := recordingpipeline.SanitizeCaptureFailure("capture_attempt_failed", boundedFailureDetail(err))
			for _, want := range []string{"stage=capture_stopped", "outcome=" + test.outcome, fmt.Sprintf("http_status=%d", test.status), fmt.Sprintf("callback_attempts=%d", len(lifecycle.events())), "callback_elapsed_ms="} {
				if !strings.Contains(detail, want) {
					t.Fatalf("safe diagnostic lost %q: %s", want, detail)
				}
			}
			for _, field := range strings.Fields(detail) {
				if strings.HasPrefix(field, "callback_elapsed_ms=") {
					value := strings.TrimSuffix(strings.TrimPrefix(field, "callback_elapsed_ms="), ":")
					elapsed, err := strconv.ParseInt(value, 10, 64)
					if err != nil || elapsed < 0 || (test.outcome == "timed_out" && elapsed == 0) {
						t.Fatalf("invalid elapsed duration: %s", detail)
					}
				}
			}
			if test.code != "" && !strings.Contains(detail, "api_error_code="+test.code) {
				t.Fatalf("API code lost: %s", detail)
			}
			if strings.Contains(detail, "secret") {
				t.Fatalf("transport detail leaked: %s", detail)
			}
			if test.status == http.StatusConflict && len(lifecycle.events()) != 1 {
				t.Fatal("fenced callback retried")
			}
		})
	}
}
