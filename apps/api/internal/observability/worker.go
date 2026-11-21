package observability

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/obs"
)

type recordingFieldsKey struct{}

// RecordingFields name the Recording work a log row or span belongs to. Every recorder row
// carries them, so one query by recording_id or job_id returns the whole attempt.
type RecordingFields struct {
	TenantID     string
	EpisodeID    string
	RecordingID  string
	JobID        string
	Attempt      int
	CaptureEpoch int64
}

func ContextWithRecordingFields(ctx context.Context, fields RecordingFields) context.Context {
	return context.WithValue(ctx, recordingFieldsKey{}, fields)
}

func recordingFieldsFromContext(ctx context.Context) (RecordingFields, bool) {
	fields, ok := ctx.Value(recordingFieldsKey{}).(RecordingFields)
	return fields, ok
}

func (fields RecordingFields) attrs() []slog.Attr {
	return []slog.Attr{
		slog.String("tenant_id", fields.TenantID), slog.String("episode_id", fields.EpisodeID),
		slog.String("recording_id", fields.RecordingID), slog.String("job_id", fields.JobID),
		slog.Int("attempt", fields.Attempt), slog.Int64("capture_epoch", fields.CaptureEpoch),
	}
}

// WorkerTelemetry is the telemetry of a process that has no HTTP server, such as a recorder
// worker. It exports logs, traces and metrics the way the API does and installs the logger as
// the process default, so every slog call in the worker is exported and correlated.
type WorkerTelemetry struct {
	runtime     Runtime
	diagnostics Diagnostics
}

// StartWorker reads CHALK_RECORDER_OTLP_ENDPOINT and CHALK_RECORDER_OTLP_INSECURE. The OTLP
// exporters read their own OTEL_EXPORTER_OTLP_*_HEADERS, which carry the ingest credential.
// Without an endpoint nothing is exported and logs go to output only.
func StartWorker(ctx context.Context, service string, getenv func(string) string, output io.Writer) (WorkerTelemetry, error) {
	insecure, err := parseOptionalBool(getenv("CHALK_RECORDER_OTLP_INSECURE"))
	if err != nil {
		return WorkerTelemetry{}, fmt.Errorf("CHALK_RECORDER_OTLP_INSECURE: %w", err)
	}
	config := Config{
		Environment:  strings.TrimSpace(getenv("CHALK_RECORDER_ENVIRONMENT")),
		LogFormat:    LogFormatText,
		OTLPEndpoint: strings.TrimSpace(getenv("CHALK_RECORDER_OTLP_ENDPOINT")),
		OTLPInsecure: insecure,
		Service:      service,
		Version:      strings.TrimSpace(getenv("CHALK_RECORDER_VERSION")),
	}
	runtime, err := Start(ctx, config)
	if err != nil {
		return WorkerTelemetry{}, fmt.Errorf("start recorder telemetry: %w", err)
	}
	diagnostics := New(config, output)
	slog.SetDefault(diagnostics.Logger())
	workerBootFacts(ctx, config, diagnostics.Logger(), getenv)
	return WorkerTelemetry{runtime: runtime, diagnostics: diagnostics}, nil
}

// workerModules maps a worker's telemetry service name to its registry module,
// the component a release marker names for it.
var workerModules = map[string]string{
	"chalk-recorder-capture": "recorder_capture",
	"chalk-recorder-render":  "recorder_render",
}

// workerBootFacts records release.started for a recorder worker boot, the same
// witness the API posts at boot, so a marker for the component can be judged
// against the release it actually runs.
func workerBootFacts(ctx context.Context, config Config, logger *slog.Logger, getenv func(string) string) {
	module := workerModules[config.Service]
	if module == "" || config.Environment == "" {
		return
	}
	obs.Configure(obs.Config{Logger: logger, Module: module, Env: config.Environment, Platform: "server"})
	obs.Fact(ctx, obs.EventReleaseStarted,
		slog.String("release_id", config.Version),
		slog.String("host_boot_id", getenv("CHALK_HOST_BOOT_ID")),
		slog.String("previous_boot_end", previousBootEnd(getenv("CHALK_PREVIOUS_BOOT_END"))),
	)
}

// previousBootEnd keeps the worker's copy of the host's boot-end vocabulary to
// the same small enum the API reports.
func previousBootEnd(value string) string {
	switch value {
	case "clean", "killed":
		return value
	default:
		return "unknown"
	}
}

// Close flushes pending exports. Call it before the process exits; a failed flush is reported on
// stderr, because the process is already ending.
func (t WorkerTelemetry) Close(program string, stderr io.Writer) {
	ctx, cancel := TelemetryShutdownContext()
	defer cancel()
	if err := t.runtime.Shutdown(ctx); err != nil {
		fmt.Fprintf(stderr, "%s: shutdown telemetry: %v\n", program, err)
	}
}

func parseOptionalBool(value string) (bool, error) {
	if strings.TrimSpace(value) == "" {
		return false, nil
	}
	return strconv.ParseBool(strings.TrimSpace(value))
}
