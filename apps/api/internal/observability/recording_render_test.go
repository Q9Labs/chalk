package observability

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestRenderFailureDetailRedactsUntrustedText(t *testing.T) {
	for _, private := range []string{
		"https://example.invalid/media?token=secret", "Bearer privatecredential",
		"/tmp/private/recording.mp4", "customer-spoken-words", "123456789", "日本語", "recording", "Bearer render", "frame timing",
	} {
		detail := renderFailureDetail("decode authenticated recording media: " + private)
		if detail != "decode authenticated recording media: [redacted]" {
			t.Fatalf("untrusted detail retained: %q", detail)
		}
	}
	for _, input := range []string{strings.Repeat("decode ", 200), strings.Repeat("é", 300), strings.Repeat("x ", 1_000)} {
		if detail := renderFailureDetail(input); len(detail) > 512 || !utf8.ValidString(detail) {
			t.Fatalf("unbounded or invalid detail: %q", detail)
		}
	}
}
