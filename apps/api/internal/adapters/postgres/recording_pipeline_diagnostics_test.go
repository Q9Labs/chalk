package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestRecordingRecoveryDiagnosticsKeepOnlySafeReasons(t *testing.T) {
	const secret = "synthetic-private-lease-and-media-text"
	marker := "stage=capture_start outcome=stopped_before_claim error_class=none"
	for _, tc := range []struct {
		code, detail, reason string
		attempts             int
		preclaim             bool
	}{
		{"lease_expired", secret, "lease_expired", 1, false},
		{"recording_source_expired", secret, "recording_source_expired", 2, false},
		{"render_deadline_exceeded", secret, "render_deadline_exceeded", 1, false},
		{"capture_completion_expired", secret, "capture_completion_expired", 3, false},
		{"capture_stopped_before_completion", marker, "capture_stopped_before_completion", 0, true},
		{"capture_stopped_before_completion", marker, "capture_stopped_before_completion", 1, false},
		{"capture_stopped_before_completion", marker + secret, "capture_stopped_before_completion", 0, false},
		{secret, secret, "other", 0, false},
		{"", "", "other", 0, false},
	} {
		t.Run(tc.code+tc.detail, func(t *testing.T) {
			var logs bytes.Buffer
			previous := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
			t.Cleanup(func() { slog.SetDefault(previous) })
			job := recordingpipeline.Job{Kind: recordingpipeline.JobKindCapture, State: recordingpipeline.JobStatePending,
				AttemptCount: tc.attempts, IdempotencyKey: secret, LeaseToken: &tc.detail, LeaseOwner: &tc.detail}
			if tc.code != "" {
				job.ErrorCode = &tc.code
			}
			if tc.detail != "" {
				job.ErrorDetail = &tc.detail
			}
			logRecoveredRecordingJob(context.Background(), job)
			var event map[string]any
			if err := json.Unmarshal(logs.Bytes(), &event); err != nil {
				t.Fatal(err)
			}
			if event["reason"] != tc.reason || event["state"] != "pending" || event["event"] != "recording.job_recovered" {
				t.Fatalf("wrong committed recovery event: %v", event)
			}
			_, preclaim := event["capture_outcome"]
			if preclaim != tc.preclaim {
				t.Fatalf("incorrect preclaim evidence: %v", event)
			}
			if strings.Contains(logs.String(), secret) || strings.Contains(logs.String(), marker) {
				t.Fatalf("private job text reached telemetry: %s", logs.String())
			}
			for _, field := range []string{"error_detail", "lease_token", "lease_owner", "idempotency_key", "payload"} {
				if _, ok := event[field]; ok {
					t.Fatalf("private field %s reached telemetry", field)
				}
			}
		})
	}
}
