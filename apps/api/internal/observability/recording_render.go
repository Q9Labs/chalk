package observability

import (
	"context"
	"log/slog"
	"strings"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"go.opentelemetry.io/otel/trace"
)

// LogRenderAttemptFailure is shared by the worker and the API receiving its
// fenced failure report. The API copy reaches the managed log exporter even
// when the disposable worker has no log exporter of its own.
func LogRenderAttemptFailure(ctx context.Context, logger *slog.Logger, input recordingpipeline.FailureInput) {
	span := trace.SpanContextFromContext(ctx)
	logger.WarnContext(ctx, "recording render attempt failed",
		"event", "recording.render_attempt_failed", "job_id", input.JobID.String(),
		"attempt_count", input.AttemptCount, "fencing_generation", input.FencingGeneration,
		"error_code", "render_attempt_failed", "error_detail", renderFailureDetail(input.ErrorDetail),
		"trace_id", span.TraceID().String(), "span_id", span.SpanID().String())
}

func renderFailureDetail(detail string) string {
	const maximumBytes = 512
	if len(detail) > maximumBytes {
		detail = detail[:maximumBytes]
		for !utf8.ValidString(detail) {
			detail = detail[:len(detail)-1]
		}
	}
	// Retain diagnostic vocabulary only, never arbitrary provider text, object
	// paths, signed URLs, credentials, identifiers, or media-derived text.
	const words = " access already asset attempt audio authenticated authority bound bundle capture chunk clean clock codec command commit context count could deadline decode decrypt duration empty encode end error exceeds expired failed failure ffmpeg file frame generation h264 hash heartbeat input interrupted invalid key lease manifest match media missing mismatch mux no not object output packet parse presentation recording render renderer report resolve resource sequence source start stopped stream terminal the timed timeout timing too track transcription unexpected unsupported upload validate variable video vp8 was without workspace write "
	var result []string
	for _, field := range strings.Fields(detail) {
		word := strings.ToLower(strings.TrimSuffix(field, ":"))
		if strings.Contains(words, " "+word+" ") {
			result = append(result, field)
		} else if len(result) == 0 || result[len(result)-1] != "[redacted]" {
			result = append(result, "[redacted]")
		}
	}
	redacted := strings.Join(result, " ")
	if len(redacted) > maximumBytes {
		redacted = redacted[:maximumBytes]
	}
	return redacted
}
