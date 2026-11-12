package postgres

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestRecordingRecoveryDiagnosticsDoNotLeakPrivateFields(t *testing.T) {
	secret := "synthetic-private-lease-and-media-text"
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	logRecoveredRecordingJob(t.Context(), recordingpipeline.Job{
		ErrorCode: &secret, ErrorDetail: &secret, IdempotencyKey: secret,
		LeaseToken: &secret, LeaseOwner: &secret,
	})
	if logs.Len() == 0 {
		t.Fatal("recovery emitted no diagnostic")
	}
	if strings.Contains(logs.String(), secret) {
		t.Fatal("private job fields reached telemetry")
	}
}
