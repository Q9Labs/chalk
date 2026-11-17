package observability

import (
	"context"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// Recorder counts the durable job events the API commits. The instruments bind to the
// global meter provider, so they export once either process installs one.
var Recorder = newRecorderMetrics()

type RecorderMetrics struct {
	jobClaim        otelmetric.Int64Counter
	leaseRecovery   otelmetric.Int64Counter
	terminalFailure otelmetric.Int64Counter
	renderStage     otelmetric.Float64Histogram
}

func newRecorderMetrics() RecorderMetrics {
	meter := otel.Meter("github.com/q9labs/chalk/apps/api/internal/observability")
	jobClaim, _ := meter.Int64Counter("chalk.recorder.jobs.claimed", otelmetric.WithDescription("Recorder jobs leased to authenticated workers"))
	leaseRecovery, _ := meter.Int64Counter("chalk.recorder.jobs.lease_recoveries", otelmetric.WithDescription("Expired recorder leases recovered for retry or terminalization"))
	terminalFailure, _ := meter.Int64Counter("chalk.recorder.jobs.terminal_failures", otelmetric.WithDescription("Recorder jobs entering a terminal failure state"))
	renderStage, _ := meter.Float64Histogram("chalk.recorder.render.stage_duration_seconds", otelmetric.WithDescription("Render attempt stage wall time by stage and outcome"), otelmetric.WithUnit("s"))
	return RecorderMetrics{jobClaim: jobClaim, leaseRecovery: leaseRecovery, terminalFailure: terminalFailure, renderStage: renderStage}
}

func (m RecorderMetrics) RecordJobClaim(ctx context.Context, kind string) {
	m.jobClaim.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("job.kind", kind)))
}

func (m RecorderMetrics) RecordLeaseRecovery(ctx context.Context, kind string) {
	m.leaseRecovery.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("job.kind", kind)))
}

// RecordTerminalFailure takes a code the caller already bounded: a sanitized worker
// code, a recovery reason, or a platform code.
func (m RecorderMetrics) RecordTerminalFailure(ctx context.Context, kind string, code string) {
	m.terminalFailure.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("job.kind", kind), attribute.String("error.code", code)))
}

func (m RecorderMetrics) RecordRenderStage(ctx context.Context, stage string, succeeded bool, duration time.Duration) {
	outcome := "failed"
	if succeeded {
		outcome = "succeeded"
	}
	m.renderStage.Record(ctx, duration.Seconds(), otelmetric.WithAttributes(attribute.String("stage", stage), attribute.String("outcome", outcome)))
}
