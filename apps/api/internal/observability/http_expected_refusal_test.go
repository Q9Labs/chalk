package observability

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func requestLogFor(t *testing.T, status int, code string) map[string]any {
	t.Helper()
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := RequestMiddleware(logger)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		RecordErrorCode(w, code)
		w.WriteHeader(status)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/internal/v1/transcription/jobs/claim", nil))
	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &entry); err != nil {
		t.Fatalf("expected one request log line, got %q: %v", logs.String(), err)
	}
	return entry
}

func TestAReplacedReleaseBeingTurnedAwayIsNotLoggedAsAnError(t *testing.T) {
	entry := requestLogFor(t, http.StatusConflict, "workload.release_superseded")
	if entry["level"] != "INFO" || entry["outcome"] != "expected" || entry["error_code"] != "workload.release_superseded" {
		t.Fatalf("log %v, want an INFO line with the expected outcome and the error code", entry)
	}
}

func TestOtherRefusalsStillLogAsErrors(t *testing.T) {
	entry := requestLogFor(t, http.StatusConflict, "lease.stale")
	if entry["level"] != "WARN" || entry["outcome"] != "error" {
		t.Fatalf("log %v, want a WARN line with the error outcome", entry)
	}
}
