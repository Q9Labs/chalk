package observability_test

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/observability"
)

func TestMediaConnectionReplacementLogsOnlyBoundedCauses(t *testing.T) {
	for _, cause := range append(observability.MediaReplacementCauses(), "", "future_cause", "credential=private@example.test", strings.Repeat("x", 10000)) {
		t.Run(cause[:min(len(cause), 40)], func(t *testing.T) {
			var logs bytes.Buffer
			handler := observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil)), observability.RequestLogConfig{Mode: observability.RequestLogOff})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				observability.LogMediaConnectionReplacement(r.Context(), cause)
				w.WriteHeader(http.StatusNoContent)
			}))
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/tracks", nil))
			allowed := false
			for _, known := range observability.MediaReplacementCauses() {
				allowed = allowed || cause == known
			}
			if allowed {
				if !strings.Contains(logs.String(), `"event":"media.connection_replacement"`) || !strings.Contains(logs.String(), `"replacement_cause":"`+cause+`"`) {
					t.Fatalf("replacement diagnostic missing: %s", logs.String())
				}
			} else if logs.Len() != 0 {
				t.Fatal("untrusted replacement cause was logged")
			}
		})
	}
}
