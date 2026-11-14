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

type requestOutcome struct {
	cause   error
	outcome string
	reason  string
}

// requestOutcomes maps an error to its bounded outcome and reason. The first match wins.
var requestOutcomes = []requestOutcome{
	{ErrInvalidInput, "rejected", "invalid_input"},
	{ErrPermissionDenied, "rejected", "permission_denied"},
	{ErrClientAttachmentIDConflict, "rejected", "client_id_conflict"},
	{ErrQuotaExceeded, "rejected", "quota_exceeded"},
	{ErrUploadNotFound, "rejected", "upload_not_found"},
	{ErrUploadExpired, "rejected", "upload_expired"},
	{ErrUploadNotReady, "rejected", "upload_in_progress"},
	{ErrAttachmentNotFound, "rejected", "attachment_not_found"},
	{ErrFileTransferFailed, "failed", "transfer_failed"},
	{objectstorage.ErrObjectNotFound, "failed", "object_missing"},
	{objectstorage.ErrObjectAlreadyExists, "failed", "object_conflict"},
	{objectstorage.ErrStoreUnavailable, "failed", "storage_unavailable"},
	{objectstorage.ErrProviderFailed, "failed", "storage_failed"},
	{context.Canceled, "failed", "request_canceled"},
	{context.DeadlineExceeded, "failed", "request_deadline"},
}

func requestResult(err error) (string, string) {
	if err == nil {
		return "succeeded", "none"
	}
	for _, entry := range requestOutcomes {
		if errors.Is(err, entry.cause) {
			return entry.outcome, entry.reason
		}
	}
	return "failed", "internal_error"
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
