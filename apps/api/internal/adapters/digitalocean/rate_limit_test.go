package digitalocean

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func TestRecorderFleetPreservesRateLimitDeadline(t *testing.T) {
	for _, kind := range []string{"seconds", "date", "reset", "both", "retry-wins", "invalid"} {
		t.Run(kind, func(t *testing.T) {
			start := time.Now()
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch kind {
				case "seconds":
					w.Header().Set("Retry-After", "12")
				case "date":
					w.Header().Set("Retry-After", start.Add(18*time.Second).UTC().Format(http.TimeFormat))
				case "reset":
					w.Header().Set("RateLimit-Reset", strconv.FormatInt(start.Add(18*time.Second).Unix(), 10))
				case "both":
					w.Header().Set("Retry-After", "12")
					w.Header().Set("RateLimit-Reset", strconv.FormatInt(start.Add(18*time.Second).Unix(), 10))
				case "retry-wins":
					w.Header().Set("Retry-After", "18")
					w.Header().Set("RateLimit-Reset", strconv.FormatInt(start.Add(12*time.Second).Unix(), 10))
				case "invalid":
					w.Header().Set("Retry-After", "-12")
					w.Header().Set("RateLimit-Reset", "not-a-timestamp")
				}
				w.WriteHeader(http.StatusTooManyRequests)
			}))
			defer server.Close()
			adapter := recorderFleetAdapter(t, server, "secret-not-for-errors")
			_, err := adapter.ListNodes(t.Context(), recorderFleetEnsureRequest().Key)
			var limited interface{ RetryDeadline() time.Time }
			if !errors.Is(err, recorderfleet.ErrProviderUnavailable) || !errors.As(err, &limited) {
				t.Fatalf("429 lost its retry deadline: %v", err)
			}
			if kind == "invalid" {
				if !limited.RetryDeadline().IsZero() {
					t.Fatal("invalid headers created a retry deadline")
				}
				return
			}
			minimum, maximum := 17*time.Second, 19*time.Second
			if kind == "seconds" {
				minimum, maximum = 12*time.Second, 13*time.Second
			}
			if delay := limited.RetryDeadline().Sub(start); delay < minimum || delay > maximum {
				t.Fatalf("retry deadline offset = %s, want %s..%s", delay, minimum, maximum)
			}
		})
	}
}
