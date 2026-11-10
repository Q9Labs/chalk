package observability

import (
	"context"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"go.opentelemetry.io/otel/trace"
)

// LogCaptureAttemptFailure logs input as given, so the caller passes the detail it
// sanitized with recordingpipeline.SanitizeCaptureFailure. It is emitted by the API when it records a Capture
// attempt failure. The disposable recorder worker has no log exporter, so this
// copy is what lets a job that failed once and then succeeded explain itself.
func LogCaptureAttemptFailure(ctx context.Context, logger *slog.Logger, job recordingpipeline.Job, input recordingpipeline.FailureInput) {
	span := trace.SpanContextFromContext(ctx)
	logger.WarnContext(ctx, "recording capture attempt failed",
		"event", "recording.capture_attempt_failed", "job_id", input.JobID.String(),
		"kind", string(job.Kind), "job_state", string(job.State),
		"attempt_count", input.AttemptCount, "fencing_generation", input.FencingGeneration,
		"error_code", input.ErrorCode, "error_detail", input.ErrorDetail,
		"trace_id", span.TraceID().String(), "span_id", span.SpanID().String())
}
