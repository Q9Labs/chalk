package sfu

import (
	"strings"
	"testing"
)

// A provider message that reflects a failed dial keeps no host, address or port. The word filter
// allows "media" and "internal", so a name such as media.internal must go as one unit.
func TestAProviderMessageKeepsNoHostLikeToken(t *testing.T) {
	for _, tc := range []struct {
		name, message string
		leaked        []string
	}{
		{"dns name with URL", `Post "https://media.internal/x": dial tcp media.internal:8080: connection refused`, []string{"media.internal", "8080", "https"}},
		{"bare dns name", `lookup media.internal on resolver: no such host`, []string{"media.internal"}},
		{"host and port", `dial tcp localhost:8080: connection refused`, []string{"localhost", "8080"}},
		{"ipv4 and port", `dial tcp 203.0.113.17:8080: connection refused`, []string{"203.0.113", "8080"}},
		{"ipv6 and port", `dial tcp [2001:db8::1]:8080: connection refused`, []string{"2001", "db8", "8080"}},
		{"bracketed ipv6 alone", `peer [2001:db8::1] closed`, []string{"2001", "db8"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			failure := newProviderResponseFailure("add_tracks", failureStageTopLevel, 200, "", tc.message, 0, 0)
			// The fingerprint is a hash of the raw message, so its hex digits can hold any digits.
			errorText, _, _ := strings.Cut(failure.Error(), " provider_message_fingerprint=")
			for _, text := range []string{failure.details.message, errorText} {
				for _, leaked := range tc.leaked {
					if strings.Contains(text, leaked) {
						t.Fatalf("%q leaks %q", text, leaked)
					}
				}
			}
		})
	}
}

// Ordinary sentences keep their allowed words, including a closing period.
func TestAProviderMessageKeepsAllowedWords(t *testing.T) {
	if got, want := observableProviderMessage("Session is not ready."), "Session is not ready."; got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}
}
