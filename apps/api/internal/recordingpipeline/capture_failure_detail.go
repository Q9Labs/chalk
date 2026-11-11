package recordingpipeline

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	redactedFailurePart             = "[redacted]"
	maximumCaptureFailureDetailSize = 512
	defaultCaptureFailureCode       = "capture_attempt_failed"
)

var (
	captureFailureCode = regexp.MustCompile(`^[a-z][a-z_]{0,63}$`)

	// Worker error text is free text: wrapped provider, network and decoder errors can carry
	// lease tokens, signed URLs or media-derived words. Only parts that match one of these
	// anchored shapes are kept, so a new or unexpected message is dropped, never passed through.
	captureFailureParts = []*regexp.Regexp{
		regexp.MustCompile(`^(?:` + strings.Join(captureFailureLiterals, "|") + `)$`),
		regexp.MustCompile(`^(?:wait for |request keyframe (?:after RTP loss )?for )?capture MID [A-Za-z0-9_-]{1,16}(?: identity changed)?$`),
		regexp.MustCompile(`^expected MID [A-Za-z0-9_-]{1,16}$`),
		regexp.MustCompile(`^create capture peer for epoch [0-9]{1,10}$`),
		regexp.MustCompile(`^recorder control-plane request failed with HTTP status [0-9]{3}(?: code [a-z]+(?:\.[a-z_]+)+)?$`),
		regexp.MustCompile(`^stage=[a-z_]{1,32} outcome=[a-z_]{1,32} error_class=[a-z_]{1,32} http_status=[0-9]{1,3}(?: api_error_code=[a-z]+(?:\.[a-z_]+)+)?$`),
		regexp.MustCompile(`^stage=capture_stopped outcome=(?:returned|timed_out) error_class=(?:http|deadline|transport|protocol|fenced|unknown) http_status=[0-9]{1,3}(?: api_error_code=[a-z]+(?:\.[a-z_]+)+)? callback_attempts=[0-9]{1,10} callback_elapsed_ms=[0-9]{1,13}$`),
	}
)

var captureFailureLiterals = []string{
	"EOF", "io", "read/write on closed pipe", "use of closed network connection",
	"context canceled", "context deadline exceeded",
	"capture attempt failed without a cause", "capture RTP reader returned nil packet",
	"invalid recorder capture attempt", "invalid recorder capture daemon",
	"recorder capture attempt did not shut down within its bound", "recorder capture daemon stopped",
	"recorder capture event queue is full", "recorder capture lease has insufficient handoff time",
	"recorder capture operation panicked", "recorder capture peer reached a terminal state",
	"recorder capture slot cleanup failed", "recorder capture storage is unavailable",
	"recorder control-plane transport failed",
	"capture attempt correlation", "capture attempt trace correlation", "capture plan epoch mismatch",
	"claim authority", "empty RTP event", "encrypted bundle retry identity mismatch",
	"finalized bundle authority mismatch", "gap target", "heartbeat authority mismatch",
	"invalid bundle reservation", "key unavailable", "peer epoch does not match server epoch",
	"recording key response is invalid",
	"access recording key", "apply recorder capture lease", "authorize capture packets",
	"build recorder capture authority", "claim recorder capture job", "commit recording bundle",
	"create capture coordinator", "emit capture ready", "emit capture stopped",
	"finalize recording bundle", "packet could not fit after bundle rotation",
	"relinquish recorder capture lease", "renew recorder capture lease",
	"report recorder capture failure", "reserve recording bundle", "resume recording bundle commit",
	"upload recording bundle",
	"capture signaling media stopped or deadline expired", "capture signaling provider failure",
	"capture signaling provider outcome is ambiguous", "capture signaling persistence is unavailable",
	"capture signaling worker lease is stale", "capture signaling authority is stale",
	"capture signaling capture epoch is stale", "capture signaling connection is busy",
	"capture signaling command wait timed out",
}

// SanitizeCaptureFailure reduces a Capture worker's failure report to a bounded diagnostic that
// is safe to store and log. The code must be a plain identifier. The detail is split into its
// ": " wrapped parts and each part must match a known shape. Others become "[redacted]", so the
// failing step stays readable while URLs, tokens and media text never survive.
func SanitizeCaptureFailure(code, detail string) (string, string) {
	if !captureFailureCode.MatchString(code) {
		code = defaultCaptureFailureCode
	}
	parts := make([]string, 0, 8)
	for _, part := range strings.Split(detail, ": ") {
		if !allowedCaptureFailurePart(part) {
			part = redactedFailurePart
		}
		if part == redactedFailurePart && len(parts) > 0 && parts[len(parts)-1] == part {
			continue
		}
		parts = append(parts, part)
	}
	return code, truncateUTF8(strings.Join(parts, ": "), maximumCaptureFailureDetailSize)
}

func allowedCaptureFailurePart(part string) bool {
	for _, pattern := range captureFailureParts {
		if pattern.MatchString(part) {
			return true
		}
	}
	return false
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
