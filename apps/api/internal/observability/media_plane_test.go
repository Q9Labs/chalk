package observability

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

func TestMediaPlaneResolutionTelemetryLogsBoundedDeploymentFallback(t *testing.T) {
	var output bytes.Buffer
	telemetry := NewMediaPlaneResolutionTelemetry(slog.New(slog.NewJSONHandler(&output, nil)))

	telemetry.RecordResolution(context.Background(), mediaplaneproviders.Resolution{
		Provider:            spaces.MediaPlaneProviderCloudflareSFU,
		ConfigurationSource: mediaplaneproviders.ConfigurationSourceDeploymentDefault,
		Mode:                mediaplaneproviders.ModeChalkManaged,
		Outcome:             mediaplaneproviders.ResolutionOutcomeResolved,
		FailureClass:        "none",
		Duration:            time.Millisecond,
	})

	logged := output.String()
	for _, expected := range []string{`"event":"media_plane.resolution"`, `"provider":"cf_sfu"`, `"configuration_source":"deployment_default"`, `"outcome":"resolved"`} {
		if !strings.Contains(logged, expected) {
			t.Fatalf("log = %s, want %s", logged, expected)
		}
	}
}

func TestMediaPlaneResolutionTelemetryBoundsUnexpectedValues(t *testing.T) {
	var output bytes.Buffer
	telemetry := NewMediaPlaneResolutionTelemetry(slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug})))

	telemetry.RecordResolution(context.Background(), mediaplaneproviders.Resolution{
		Provider:            spaces.MediaPlaneProvider("private-provider-value"),
		ConfigurationSource: "private-source-value",
		Mode:                "private-mode-value",
		Outcome:             "private-outcome-value",
		FailureClass:        "private-failure-value",
	})

	logged := output.String()
	if strings.Contains(logged, "private-") {
		t.Fatalf("log leaked unbounded value: %s", logged)
	}
	for _, expected := range []string{`"provider":"unknown"`, `"configuration_source":"unknown"`, `"mode":"unknown"`, `"outcome":"error"`, `"failure_class":"unknown"`} {
		if !strings.Contains(logged, expected) {
			t.Fatalf("log = %s, want %s", logged, expected)
		}
	}
}
