package recordingpipeline

import (
	"strings"
	"testing"
	"unicode/utf8"
)

const (
	syntheticLeaseToken = "lease-token-AbCdEf0123456789"
	syntheticSignedURL  = "https://objects.example.test/bundles/seg-1.mp4?X-Amz-Signature=deadbeef0123&X-Amz-Credential=AKIASYNTHETIC"
	syntheticCaption    = "Dr Synthetic Person says the quarterly numbers are private"
)

func TestSanitizeCaptureFailureKeepsOnlyKnownParts(t *testing.T) {
	raw := strings.Join([]string{
		"upload recording bundle",
		"Put " + syntheticSignedURL,
		"capture MID audio-1",
		"token " + syntheticLeaseToken,
		syntheticCaption,
		"recorder control-plane request failed with HTTP status 502 code recording.capture_provider_failed",
	}, ": ")
	code, detail := SanitizeCaptureFailure("capture_attempt_failed", raw)

	for _, secret := range []string{syntheticLeaseToken, "X-Amz", "objects.example.test", "deadbeef", "Synthetic", "quarterly"} {
		if strings.Contains(detail, secret) {
			t.Fatalf("detail kept %q: %s", secret, detail)
		}
	}
	want := "upload recording bundle: [redacted]: capture MID audio-1: [redacted]: recorder control-plane request failed with HTTP status 502 code recording.capture_provider_failed"
	if code != "capture_attempt_failed" || detail != want {
		t.Fatalf("safe diagnostic changed:\n got %q\nwant %q", detail, want)
	}
}

func TestSanitizeCaptureFailureFailsClosed(t *testing.T) {
	for name, raw := range map[string]string{
		"unknown message":         "something nobody listed",
		"empty":                   "",
		"unknown structured key":  "stage=api_complete outcome=returned error_class=http http_status=502 lease=" + syntheticLeaseToken,
		"structured extra word":   "stage=api_complete outcome=returned error_class=http http_status=502 " + syntheticCaption,
		"token as api error code": "stage=api_complete outcome=returned error_class=http http_status=502 api_error_code=" + syntheticLeaseToken,
		"known prefix, url tail":  "capture MID audio-1 " + syntheticSignedURL,
		"url as MID":              "capture MID " + syntheticSignedURL,
		"url in control plane":    "recorder control-plane request failed with HTTP status 502 code " + syntheticSignedURL,
		"hex as api code":         "recorder control-plane request failed with HTTP status 502 code recording.deadbeef0123",
	} {
		t.Run(name, func(t *testing.T) {
			_, detail := SanitizeCaptureFailure("capture_attempt_failed", raw)
			if detail != redactedFailurePart {
				t.Fatalf("unrecognised shape must be dropped, got %q", detail)
			}
		})
	}
	if code, _ := SanitizeCaptureFailure(syntheticSignedURL, "EOF"); code != "capture_attempt_failed" {
		t.Fatalf("an unrecognised code must be replaced, got %q", code)
	}
	_, detail := SanitizeCaptureFailure("capture_completion_failed", "stage=api_complete outcome=returned error_class=http http_status=502 api_error_code=recording.capture_stop_publication_failed")
	if !strings.HasPrefix(detail, "stage=api_complete") {
		t.Fatalf("structured completion detail must survive, got %q", detail)
	}
}

func TestSanitizeCaptureFailureBoundsOnRuneBoundary(t *testing.T) {
	long := strings.Repeat("EOF: ", 400) + "EOF"
	_, detail := SanitizeCaptureFailure("capture_attempt_failed", long)
	if len(detail) != 512 || !utf8.ValidString(detail) {
		t.Fatalf("want 512 valid bytes, got %d valid=%v", len(detail), utf8.ValidString(detail))
	}
	if got := truncateUTF8(strings.Repeat("é", 400), 511); len(got) != 510 || !utf8.ValidString(got) {
		t.Fatalf("must cut before a split rune, got %d bytes", len(got))
	}
}
