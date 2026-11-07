package observability

import (
	"context"
	"log/slog"
	"strings"

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
	}
	// Emit canonical internal diagnostics, not words copied out of untrusted
	// provider errors, object paths, credentials, or media-derived text.
	phrases := [...]string{
		"decode authenticated recording media", "decode authenticated recording microphone media",
		"recording media decode failed", "invalid production recording render attempt",
		"H264 variable frame timing exceeds bound", "H264 access unit exceeds size bound",
		"H264 timestamp regressed", "H264 interval is empty", "VP8 frame exceeds size bound",
		"recording capture sequence or byte bound", "recording transcription chunk count exceeds bound",
		"recording asset manifest authority mismatch", "recording asset manifest has trailing data",
		"recording presentation does not match render authority or profile",
		"recording presentation does not match transcription authority",
		"resolved recording render input does not match its claim",
		"recording has no decodable video or audio", "context canceled", "context deadline exceeded",
		"resolve recording render input", "resolve recording transcription input",
		"download recording presentation", "download recording asset manifest",
		"read recording presentation", "decode recording presentation", "verify encoded recording",
		"compose recording video", "commit recording Artifact", "commit recording transcription preparation",
		"render attempt failed without a cause", "write H264 RTP", "parse H264 access unit", "mux H264 access unit",
	}
	var result []string
	for _, part := range strings.Split(detail, ": ") {
		canonical := "[redacted]"
		for _, phrase := range phrases {
			if part == phrase {
				canonical = phrase
				break
			}
		}
		if canonical != "[redacted]" || len(result) == 0 || result[len(result)-1] != canonical {
			result = append(result, canonical)
		}
	}
	redacted := strings.Join(result, ": ")
	if len(redacted) > maximumBytes {
		redacted = redacted[:maximumBytes]
	}
	return redacted
}
