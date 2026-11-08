package observability

import (
	"context"
	"log/slog"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"go.opentelemetry.io/otel/trace"
)

const maximumCaptureFailureDetailBytes = 512

// LogCaptureAttemptFailure is emitted by the API when it records a Capture
// attempt failure. The disposable recorder worker has no log exporter, so this
// copy is what lets a job that failed once and then succeeded explain itself.
func LogCaptureAttemptFailure(ctx context.Context, logger *slog.Logger, job recordingpipeline.Job, input recordingpipeline.FailureInput) {
	span := trace.SpanContextFromContext(ctx)
	logger.WarnContext(ctx, "recording capture attempt failed",
		"event", "recording.capture_attempt_failed", "job_id", input.JobID.String(),
		"kind", string(job.Kind), "job_state", string(job.State),
		"attempt_count", input.AttemptCount, "fencing_generation", input.FencingGeneration,
		"error_code", input.ErrorCode, "error_detail", truncateUTF8(input.ErrorDetail, maximumCaptureFailureDetailBytes),
		"trace_id", span.TraceID().String(), "span_id", span.SpanID().String())
}

func truncateUTF8(value string, maximumBytes int) string {
	if len(value) <= maximumBytes {
		return value
	}
	end := maximumBytes
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end]
}
