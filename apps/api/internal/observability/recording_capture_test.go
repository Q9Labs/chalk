package observability_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestLogCaptureAttemptFailureBoundsAndCarriesAttemptFields(t *testing.T) {
	var out bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&out, nil))
	jobID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	input := recordingpipeline.FailureInput{
		LeaseInput:  recordingpipeline.LeaseInput{JobID: jobID, AttemptCount: 1, FencingGeneration: 3, LeaseOwner: "worker-a", LeaseToken: "secret-lease-token"},
		ErrorCode:   "capture_attempt_failed",
		ErrorDetail: strings.Repeat("é", 400),
	}
	observability.LogCaptureAttemptFailure(context.Background(), logger,
		recordingpipeline.Job{Kind: recordingpipeline.JobKindCapture, State: recordingpipeline.JobStatePending}, input)

	if strings.Contains(out.String(), "secret-lease-token") || strings.Contains(out.String(), "worker-a") {
		t.Fatalf("log line must not carry lease credentials: %s", out.String())
	}
	var line map[string]any
	if err := json.Unmarshal(out.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	detail, _ := line["error_detail"].(string)
	if len(detail) > 512 || !utf8.ValidString(detail) || len(detail) < 510 {
		t.Fatalf("detail must be cut at 512 bytes on a rune boundary: len=%d valid=%v", len(detail), utf8.ValidString(detail))
	}
	if line["event"] != "recording.capture_attempt_failed" || line["job_id"] != jobID.String() || line["kind"] != "capture" ||
		line["error_code"] != "capture_attempt_failed" || line["attempt_count"] != float64(1) || line["fencing_generation"] != float64(3) {
		t.Fatalf("missing attempt fields: %v", line)
	}
}
