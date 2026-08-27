package observability

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

type CaptureSignalingExecutor interface {
	Execute(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error)
}

type CaptureSignalingMetrics struct {
	commands   otelmetric.Int64Counter
	replays    otelmetric.Int64Counter
	duration   otelmetric.Float64Histogram
	trackCount otelmetric.Int64Histogram
}

func NewCaptureSignalingMetrics() CaptureSignalingMetrics {
	meter := otel.Meter("github.com/q9labs/chalk/apps/api/internal/observability")
	commands, _ := meter.Int64Counter("chalk.recorder.capture_signaling.commands", otelmetric.WithDescription("Recorder capture signaling commands by bounded operation and outcome"))
	replays, _ := meter.Int64Counter("chalk.recorder.capture_signaling.replays", otelmetric.WithDescription("Recorder capture signaling commands served from durable results"))
	duration, _ := meter.Float64Histogram("chalk.recorder.capture_signaling.duration_seconds", otelmetric.WithDescription("Serialized recorder capture signaling command duration"), otelmetric.WithUnit("s"))
	trackCount, _ := meter.Int64Histogram("chalk.recorder.capture_signaling.track_count", otelmetric.WithDescription("Track count in bounded recorder capture signaling commands"))
	return CaptureSignalingMetrics{commands: commands, replays: replays, duration: duration, trackCount: trackCount}
}

type ObservedCaptureSignalingExecutor struct {
	next    CaptureSignalingExecutor
	metrics CaptureSignalingMetrics
	tracer  trace.Tracer
}

func NewObservedCaptureSignalingExecutor(next CaptureSignalingExecutor) ObservedCaptureSignalingExecutor {
	return ObservedCaptureSignalingExecutor{
		next: next, metrics: NewCaptureSignalingMetrics(),
		tracer: otel.Tracer("github.com/q9labs/chalk/apps/api/internal/observability/capture-signaling"),
	}
}

func (e ObservedCaptureSignalingExecutor) Execute(ctx context.Context, request capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	operation := request.Command.Identity.Operation
	trackCount := captureSignalingTrackCount(request.Command.Input)
	attributes := []attribute.KeyValue{
		attribute.String("capture.operation", operation.String()),
		attribute.Int64("capture.epoch", int64(request.Command.Authority.CaptureEpoch)),
		attribute.Int64("capture.plan_revision", int64(request.Command.Identity.PlanRevision)),
		attribute.Int("capture.track_count", trackCount),
	}
	ctx, span := e.tracer.Start(ctx, "recorder.capture_signaling.execute", trace.WithAttributes(attributes...))
	defer span.End()
	startedAt := time.Now()
	execution, err := e.next.Execute(ctx, request)
	outcome := captureSignalingOutcome(execution, err)
	metricAttributes := otelmetric.WithAttributes(
		attribute.String("capture.operation", operation.String()),
		attribute.String("outcome", outcome),
	)
	e.metrics.commands.Add(ctx, 1, metricAttributes)
	e.metrics.duration.Record(ctx, time.Since(startedAt).Seconds(), metricAttributes)
	e.metrics.trackCount.Record(ctx, int64(trackCount), otelmetric.WithAttributes(attribute.String("capture.operation", operation.String())))
	if execution.Replayed {
		e.metrics.replays.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("capture.operation", operation.String())))
	}
	span.SetAttributes(attribute.String("outcome", outcome), attribute.Bool("capture.replayed", execution.Replayed))
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, outcome)
	}
	return execution, err
}

func captureSignalingTrackCount(input capturesignaling.CommandInput) int {
	switch {
	case input.PullCaptureTracks != nil:
		return len(input.PullCaptureTracks.Tracks)
	case input.CloseCaptureTracks != nil:
		return len(input.CloseCaptureTracks.Tracks)
	default:
		return 0
	}
}

func captureSignalingOutcome(execution capturesignaling.Execution, err error) string {
	if err == nil {
		if execution.Replayed {
			return "replayed"
		}
		return "completed"
	}
	switch {
	case errors.Is(err, capturesignaling.ErrInvalidInput), errors.Is(err, capturesignaling.ErrInvalidCommand):
		return "invalid"
	case errors.Is(err, capturesignaling.ErrConflict):
		return "conflict"
	case errors.Is(err, capturesignaling.ErrTimeout):
		return "timeout"
	case errors.Is(err, capturesignaling.ErrAmbiguousOutcome):
		return "ambiguous"
	case errors.Is(err, capturesignaling.ErrStaleAuthority), errors.Is(err, capturesignaling.ErrStaleLease),
		errors.Is(err, capturesignaling.ErrStaleCaptureEpoch), errors.Is(err, capturesignaling.ErrStalePlanRevision),
		errors.Is(err, capturesignaling.ErrStaleConnection), errors.Is(err, capturesignaling.ErrNegotiationMismatch):
		return "fenced"
	case errors.Is(err, capturesignaling.ErrProviderFailure), errors.Is(err, captureplane.ErrProviderFailure):
		return "provider_failure"
	case errors.Is(err, capturesignaling.ErrUnavailable):
		return "unavailable"
	default:
		return "internal_error"
	}
}

var _ CaptureSignalingExecutor = ObservedCaptureSignalingExecutor{}
