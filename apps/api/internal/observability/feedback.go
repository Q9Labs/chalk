package observability

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// FeedbackTelemetry records bounded operation labels only. Feedback text,
// evidence, identifiers, and object keys never enter metrics or logs.
type FeedbackTelemetry struct {
	logger     *slog.Logger
	operations otelmetric.Int64Counter
	duration   otelmetric.Float64Histogram
}

func NewFeedbackTelemetry(logger *slog.Logger) FeedbackTelemetry {
	meter := otel.Meter("github.com/q9labs/chalk/apps/api/internal/observability/feedback")
	operations, _ := meter.Int64Counter("chalk.feedback.operations", otelmetric.WithDescription("Feedback operations by bounded outcome"))
	duration, _ := meter.Float64Histogram("chalk.feedback.operation.duration", otelmetric.WithDescription("Feedback operation latency"), otelmetric.WithUnit("s"))
	return FeedbackTelemetry{logger: logger, operations: operations, duration: duration}
}

func (t FeedbackTelemetry) RecordFeedback(ctx context.Context, operation, outcome, reason string, elapsed time.Duration) {
	attributes := otelmetric.WithAttributes(attribute.String("operation", operation), attribute.String("outcome", outcome), attribute.String("reason", reason))
	t.operations.Add(ctx, 1, attributes)
	t.duration.Record(ctx, elapsed.Seconds(), attributes)
	if t.logger != nil && outcome == "failure" {
		t.logger.WarnContext(ctx, "feedback operation failed", "event", "feedback.operation_failed", "operation", operation, "outcome", outcome, "reason", reason, "duration_ms", elapsed.Milliseconds())
	}
}
