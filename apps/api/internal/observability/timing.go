package observability

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

var operationTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/observability/operations")

func LogOperation(ctx context.Context, logger *slog.Logger, event string, name string, startedAt time.Time, err error) {
	finishedAt := time.Now()
	_, span := operationTracer.Start(ctx, event+" "+name,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithTimestamp(startedAt),
	)
	span.SetAttributes(
		attribute.String("chalk.operation.event", event),
		attribute.String("db.operation.name", name),
		attribute.Float64("chalk.operation.duration_ms", milliseconds(finishedAt.Sub(startedAt))),
	)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "operation failed")
	}
	span.End(trace.WithTimestamp(finishedAt))

	if logger == nil {
		return
	}

	attrs := []any{
		"event", event,
		"name", name,
		"duration_ms", milliseconds(finishedAt.Sub(startedAt)),
	}
	if err != nil {
		attrs = append(attrs, "outcome", "error", "error", err.Error())
	} else {
		attrs = append(attrs, "outcome", "ok")
	}

	logger.InfoContext(ctx, "operation", attrs...)
}

func milliseconds(duration time.Duration) float64 {
	return float64(duration.Microseconds()) / 1000
}
