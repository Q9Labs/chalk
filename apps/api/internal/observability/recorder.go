package observability

import (
	"context"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

type RecorderMetrics struct {
	admission       otelmetric.Int64Counter
	deadlineMiss    otelmetric.Int64Counter
	jobClaim        otelmetric.Int64Counter
	leaseRecovery   otelmetric.Int64Counter
	terminalFailure otelmetric.Int64Counter
	transition      otelmetric.Int64Counter
	jobLatency      otelmetric.Float64Histogram
}

func NewRecorderMetrics() RecorderMetrics {
	meter := otel.Meter("github.com/q9labs/chalk/apps/api/internal/observability")
	admission, _ := meter.Int64Counter("chalk.recorder.admission.decisions", otelmetric.WithDescription("Bounded recorder admission decisions"))
	deadlineMiss, _ := meter.Int64Counter("chalk.recorder.render.deadline_misses", otelmetric.WithDescription("Render jobs that missed the committed-artifact deadline"))
	jobClaim, _ := meter.Int64Counter("chalk.recorder.jobs.claimed", otelmetric.WithDescription("Recorder jobs leased to authenticated workers"))
	leaseRecovery, _ := meter.Int64Counter("chalk.recorder.jobs.lease_recoveries", otelmetric.WithDescription("Expired recorder leases recovered for retry or terminalization"))
	terminalFailure, _ := meter.Int64Counter("chalk.recorder.jobs.terminal_failures", otelmetric.WithDescription("Recorder jobs entering a terminal failure state"))
	transition, _ := meter.Int64Counter("chalk.recorder.recording.transitions", otelmetric.WithDescription("Durable recording lifecycle transitions"))
	jobLatency, _ := meter.Float64Histogram("chalk.recorder.jobs.duration_seconds", otelmetric.WithDescription("Recorder job wall-clock duration by bounded job kind and outcome"), otelmetric.WithUnit("s"))
	return RecorderMetrics{
		admission:       admission,
		deadlineMiss:    deadlineMiss,
		jobClaim:        jobClaim,
		leaseRecovery:   leaseRecovery,
		terminalFailure: terminalFailure,
		transition:      transition,
		jobLatency:      jobLatency,
	}
}

func (m RecorderMetrics) RecordAdmission(ctx context.Context, outcome string, reason string) {
	m.admission.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("outcome", outcome), attribute.String("reason", reason)))
}

func (m RecorderMetrics) RecordJobClaim(ctx context.Context, kind string) {
	m.jobClaim.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("job.kind", kind)))
}

func (m RecorderMetrics) RecordTransition(ctx context.Context, state string) {
	m.transition.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("recording.state", state)))
}

func (m RecorderMetrics) RecordLeaseRecovery(ctx context.Context, kind string) {
	m.leaseRecovery.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("job.kind", kind)))
}

func (m RecorderMetrics) RecordTerminalFailure(ctx context.Context, kind string, code string) {
	m.terminalFailure.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("job.kind", kind), attribute.String("error.code", code)))
}

func (m RecorderMetrics) RecordDeadlineMiss(ctx context.Context) {
	m.deadlineMiss.Add(ctx, 1)
}

func (m RecorderMetrics) RecordJobDuration(ctx context.Context, kind string, outcome string, duration time.Duration) {
	m.jobLatency.Record(ctx, duration.Seconds(), otelmetric.WithAttributes(attribute.String("job.kind", kind), attribute.String("outcome", outcome)))
}
