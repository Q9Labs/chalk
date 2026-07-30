package chatattachments

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const requestTelemetryScope = "github.com/q9labs/chalk/apps/api/internal/chatattachments"

type requestTelemetry struct {
	tracer   trace.Tracer
	counter  metric.Int64Counter
	duration metric.Float64Histogram
	logger   *slog.Logger
	now      func() time.Time
}

func newRequestTelemetry(logger *slog.Logger, now func() time.Time) *requestTelemetry {
	if logger == nil {
		logger = slog.Default()
	}
	if now == nil {
		now = time.Now
	}
	meter := otel.Meter(requestTelemetryScope)
	counter, _ := meter.Int64Counter(
		"chalk.api.chat_attachments.requests",
		metric.WithDescription("Chat attachment request outcomes by bounded operation and reason"),
		metric.WithUnit("{request}"),
	)
	duration, _ := meter.Float64Histogram(
		"chalk.api.chat_attachments.request.duration_seconds",
		metric.WithDescription("Chat attachment request latency by bounded operation and outcome"),
		metric.WithUnit("s"),
	)
	return &requestTelemetry{
		tracer: otel.Tracer(requestTelemetryScope), counter: counter,
		duration: duration, logger: logger, now: now,
	}
}

func (t *requestTelemetry) start(
	ctx context.Context,
	operation string,
) (context.Context, func(error)) {
	startedAt := t.now()
	ctx, span := t.tracer.Start(ctx, "chat_attachments."+operation)
	return ctx, func(err error) {
		outcome, reason := requestResult(err)
		elapsed := t.now().Sub(startedAt)
		if elapsed < 0 {
			elapsed = 0
		}
		attributes := []attribute.KeyValue{
			attribute.String("operation", operation),
			attribute.String("outcome", outcome),
			attribute.String("reason", reason),
		}
		span.SetAttributes(
			attribute.String("chalk.chat_attachment.operation", operation),
			attribute.String("chalk.chat_attachment.outcome", outcome),
			attribute.String("chalk.chat_attachment.reason", reason),
		)
		if err != nil {
			span.SetStatus(codes.Error, reason)
		}
		t.counter.Add(ctx, 1, metric.WithAttributes(attributes...))
		t.duration.Record(ctx, elapsed.Seconds(), metric.WithAttributes(attributes...))
		t.logger.Log(
			ctx,
			requestLogLevel(outcome),
			"chat attachment request",
			"event", "chat_attachment.request",
			"operation", operation,
			"outcome", outcome,
			"reason", reason,
			"duration_ms", float64(elapsed.Microseconds())/1000,
		)
		span.End()
	}
}

func requestResult(err error) (string, string) {
	switch {
	case err == nil:
		return "succeeded", "none"
	case errors.Is(err, ErrInvalidInput):
		return "rejected", "invalid_input"
	case errors.Is(err, ErrPermissionDenied):
		return "rejected", "permission_denied"
	case errors.Is(err, ErrClientAttachmentIDConflict):
		return "rejected", "client_id_conflict"
	case errors.Is(err, ErrQuotaExceeded):
		return "rejected", "quota_exceeded"
	case errors.Is(err, ErrUploadNotFound):
		return "rejected", "upload_not_found"
	case errors.Is(err, ErrUploadExpired):
		return "rejected", "upload_expired"
	case errors.Is(err, ErrUploadNotReady):
		return "rejected", "upload_in_progress"
	case errors.Is(err, ErrAttachmentNotFound):
		return "rejected", "attachment_not_found"
	case errors.Is(err, ErrFileTransferFailed):
		return "failed", "transfer_failed"
	case errors.Is(err, objectstorage.ErrObjectNotFound):
		return "failed", "object_missing"
	case errors.Is(err, objectstorage.ErrObjectAlreadyExists):
		return "failed", "object_conflict"
	case errors.Is(err, objectstorage.ErrStoreUnavailable):
		return "failed", "storage_unavailable"
	case errors.Is(err, objectstorage.ErrProviderFailed):
		return "failed", "storage_failed"
	case errors.Is(err, context.Canceled):
		return "failed", "request_canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "failed", "request_deadline"
	default:
		return "failed", "internal_error"
	}
}

func requestLogLevel(outcome string) slog.Level {
	switch outcome {
	case "succeeded":
		return slog.LevelInfo
	case "rejected":
		return slog.LevelWarn
	default:
		return slog.LevelError
	}
}
