package observability

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
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
	return WorkerTelemetry{runtime: runtime, diagnostics: diagnostics}, nil
}

// Shutdown flushes pending exports. Call it before the process exits.
func (t WorkerTelemetry) Shutdown() error {
	ctx, cancel := TelemetryShutdownContext()
	defer cancel()
	return t.runtime.Shutdown(ctx)
}

func parseOptionalBool(value string) (bool, error) {
	if strings.TrimSpace(value) == "" {
		return false, nil
	}
	return strconv.ParseBool(strings.TrimSpace(value))
}
