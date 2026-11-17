package observability

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
)

func TestStartWorkerWithoutAnEndpointLogsLocallyWithRecordingFields(t *testing.T) {
	previous := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previous) })
	var output bytes.Buffer
	telemetry, err := StartWorker(t.Context(), "chalk-recorder-render", func(string) string { return "" }, &output)
	if err != nil {
		t.Fatal(err)
	}
	defer telemetry.Close("test", &output)

	ctx := ContextWithRecordingFields(context.Background(), RecordingFields{RecordingID: "recording-9", JobID: "job-9", Attempt: 1})
	slog.InfoContext(ctx, "worker row")
	for _, want := range []string{"worker row", "recording_id=recording-9", "job_id=job-9"} {
		if !strings.Contains(output.String(), want) {
			t.Errorf("worker log lacks %q: %s", want, output.String())
		}
	}
}

func TestStartWorkerRejectsAnUnreadableInsecureFlag(t *testing.T) {
	_, err := StartWorker(t.Context(), "chalk-recorder-capture", func(name string) string {
		if name == "CHALK_RECORDER_OTLP_INSECURE" {
			return "sometimes"
		}
		return ""
	}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "CHALK_RECORDER_OTLP_INSECURE") {
		t.Fatalf("an unreadable flag must name itself, got %v", err)
	}
}
