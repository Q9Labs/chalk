package sfu

import (
	"context"
	"errors"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

var (
	sfuTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu")

	sfuMeter = otel.Meter("github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu")

	sfuFailureCounter, _ = sfuMeter.Int64Counter(
		"chalk.api.cloudflare_sfu.failures",
		metric.WithDescription("Cloudflare SFU request failures by bounded operation and failure classification"),
	)
	sfuSessionReplacements, _ = sfuMeter.Int64Counter(
		"chalk.api.cloudflare_sfu.session_replacements",
		metric.WithDescription("Never-negotiated Cloudflare sessions swapped for a fresh one, by outcome (proactive, recovered or failed)"),
	)
)

// traceFailed reports whether a call trace should log at warn: any failure except a caller cancel.
func traceFailed(err error) bool {
	if err == nil {
		return false
	}
	var failure providerFailure
	return !errors.As(err, &failure) || failure.transportCause != mediaplane.TransportCauseCallerCanceled
}

func recordProviderFailure(ctx context.Context, span trace.Span, err error) {
	var failure providerFailure
	if !errors.As(err, &failure) {
		return
	}
	attributes := []attribute.KeyValue{
		attribute.String("chalk.provider.operation", failure.operation),
		attribute.String("chalk.provider.failure_stage", string(failure.stage)),
		attribute.Int("http.response.status_code", failure.statusCode),
		attribute.String("http.response.status_class", failure.statusClass),
		attribute.String("chalk.provider.error_code", failure.providerCode),
	}
	if failure.transportCause != "" {
		attributes = append(attributes, attribute.String("chalk.provider.transport_cause", string(failure.transportCause)))
	}
	span.SetAttributes(attributes...)
	event := "cloudflare_sfu.provider_failure"
	logEvent := "cloudflare_sfu.request_failed"
	message := "Cloudflare SFU request failed"
	level := slog.LevelWarn
	if failure.transportCause == mediaplane.TransportCauseCallerCanceled {
		event, logEvent, message = "cloudflare_sfu.client_canceled", "cloudflare_sfu.client_canceled", "Cloudflare SFU request canceled by caller"
		level = slog.LevelInfo
	} else {
		sfuFailureCounter.Add(ctx, 1, metric.WithAttributes(attributes...))
		if failure.stage == failureStageTransport || failure.statusClass == "5xx" {
			level = slog.LevelError
		}
	}
	span.AddEvent(
		event,
		trace.WithAttributes(
			attribute.String("chalk.provider.raw_error_code", failure.details.rawCode),
			attribute.String("chalk.provider.track_error_code", failure.details.trackErrorCode),
			attribute.String("chalk.provider.message_fingerprint", failure.details.messageFingerprint),
			attribute.Int("chalk.provider.response_bytes", failure.details.responseBytes),
			attribute.String("chalk.provider.response_snapshot", failure.details.responseSnapshot),
			attribute.Int("chalk.provider.request_track_count", failure.details.requestTrackCount),
			attribute.Int("chalk.provider.response_track_count", failure.details.responseTrackCount),
			attribute.Int("chalk.provider.failed_track_count", failure.details.failedTrackCount),
		),
	)
	slog.Default().Log(
		ctx,
		level,
		message,
		"event", logEvent,
		"operation", failure.operation,
		"failure_stage", string(failure.stage),
		"http_status", failure.statusCode,
		"http_status_class", failure.statusClass,
		"provider_code", failure.providerCode,
		"transport_cause", string(failure.transportCause),
		"provider_raw_code", failure.details.rawCode,
		"provider_track_error_code", failure.details.trackErrorCode,
		"provider_message_fingerprint", failure.details.messageFingerprint,
		"provider_response_bytes", failure.details.responseBytes,
		"provider_response_snapshot", failure.details.responseSnapshot,
		"request_track_count", failure.details.requestTrackCount,
		"request_local_track_count", failure.details.localTrackCount,
		"request_remote_track_count", failure.details.remoteTrackCount,
		"response_track_count", failure.details.responseTrackCount,
		"failed_track_count", failure.details.failedTrackCount,
		"trace_id", span.SpanContext().TraceID().String(),
		"span_id", span.SpanContext().SpanID().String(),
	)
}

func sfuSpanError(err error) error {
	switch {
	case errors.Is(err, mediaplane.ErrPlaneUnavailable):
		return mediaplane.ErrPlaneUnavailable
	case errors.Is(err, mediaplane.ErrProviderUnauthorized):
		return mediaplane.ErrProviderUnauthorized
	case errors.Is(err, mediaplane.ErrProviderRateLimited):
		return mediaplane.ErrProviderRateLimited
	case errors.Is(err, mediaplane.ErrConnectionNotFound):
		return mediaplane.ErrConnectionNotFound
	case errors.Is(err, mediaplane.ErrEpisodeNotFound):
		return mediaplane.ErrEpisodeNotFound
	default:
		return mediaplane.ErrProviderFailed
	}
}
