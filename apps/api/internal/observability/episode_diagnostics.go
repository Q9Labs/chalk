package observability

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// EpisodeDiagnosticTelemetry records only bounded labels. Diagnostic and
// tenant identifiers stay in traces/audits rather than metric dimensions.
type EpisodeDiagnosticTelemetry struct {
	logger   *slog.Logger
	requests otelmetric.Int64Counter
	duration otelmetric.Float64Histogram
}

func NewEpisodeDiagnosticTelemetry(logger *slog.Logger) EpisodeDiagnosticTelemetry {
	meter := otel.Meter("github.com/q9labs/chalk/apps/api/internal/observability/episode-diagnostics")
	requests, _ := meter.Int64Counter(
		"chalk.episode_diagnostics.operations",
		otelmetric.WithDescription("Episode Diagnostic operations by bounded outcome"),
	)
	duration, _ := meter.Float64Histogram(
		"chalk.episode_diagnostics.operation.duration",
		otelmetric.WithDescription("Episode Diagnostic operation latency"),
		otelmetric.WithUnit("s"),
	)
	return EpisodeDiagnosticTelemetry{logger: logger, requests: requests, duration: duration}
}

func (t EpisodeDiagnosticTelemetry) RecordDiagnostic(ctx context.Context, operation, outcome, reason string, elapsed time.Duration) {
	attributes := otelmetric.WithAttributes(
		attribute.String("operation", operation),
		attribute.String("outcome", outcome),
		attribute.String("reason", reason),
	)
	t.requests.Add(ctx, 1, attributes)
	t.duration.Record(ctx, elapsed.Seconds(), attributes)
	if t.logger != nil && outcome != "success" {
		t.logger.WarnContext(ctx, "episode diagnostic operation failed",
			"event", "episode_diagnostics.operation_failed",
			"operation", operation,
			"outcome", outcome,
			"reason", reason,
			"duration_ms", elapsed.Milliseconds(),
		)
	}
}
