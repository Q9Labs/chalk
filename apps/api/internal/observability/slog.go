package observability

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel/trace"
)

type correlationHandler struct {
	next slog.Handler
}

type logLevelHandler struct {
	next  slog.Handler
	level slog.Level
}

func (h logLevelHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return level >= h.level && h.next.Enabled(ctx, level)
}

func (h logLevelHandler) Handle(ctx context.Context, record slog.Record) error {
	return h.next.Handle(ctx, record)
}

func (h logLevelHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return logLevelHandler{next: h.next.WithAttrs(attrs), level: h.level}
}

func (h logLevelHandler) WithGroup(name string) slog.Handler {
	return logLevelHandler{next: h.next.WithGroup(name), level: h.level}
}

func (h correlationHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h correlationHandler) Handle(ctx context.Context, record slog.Record) error {
	if journeyID, ok := JourneyIDFromContext(ctx); ok {
		record.AddAttrs(slog.String("journey_id", journeyID.String()))
	}
	if spanContext := trace.SpanContextFromContext(ctx); spanContext.IsValid() {
		record.AddAttrs(
			slog.String("trace_id", spanContext.TraceID().String()),
			slog.String("span_id", spanContext.SpanID().String()),
		)
	}
	return h.next.Handle(ctx, record)
}

func (h correlationHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return correlationHandler{next: h.next.WithAttrs(attrs)}
}

func (h correlationHandler) WithGroup(name string) slog.Handler {
	return correlationHandler{next: h.next.WithGroup(name)}
}
