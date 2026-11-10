package recordingpipeline

import (
	"strings"
	"testing"
)

func TestCaptureStoppedCallbackDiagnosticShapeFailsClosed(t *testing.T) {
	const prefix = "stage=capture_stopped outcome=timed_out error_class=http http_status=503 api_error_code=episode.stop_pending"
	const safe = prefix + " callback_attempts=25 callback_elapsed_ms=3600"
	if _, got := SanitizeCaptureFailure("capture_attempt_failed", safe); got != safe {
		t.Fatalf("safe callback diagnostic lost: %q", got)
	}
	for _, raw := range []string{
		safe + " token=" + syntheticLeaseToken,
		safe + " " + syntheticSignedURL,
		prefix + " callback_attempts=-1 callback_elapsed_ms=1",
		prefix + " callback_attempts=1 callback_elapsed_ms=-1",
		prefix + " callback_attempts=" + strings.Repeat("1", 11) + " callback_elapsed_ms=1",
		prefix + " callback_attempts=1 callback_elapsed_ms=" + strings.Repeat("1", 14),
		strings.Replace(safe, "timed_out", syntheticLeaseToken, 1),
	} {
		if _, got := SanitizeCaptureFailure("capture_attempt_failed", raw); got != redactedFailurePart {
			t.Fatalf("unsafe shape kept: %q", got)
		}
	}
}
