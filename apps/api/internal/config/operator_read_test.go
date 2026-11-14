package config

import (
	"strings"
	"testing"
)

func TestOperatorReadTokenSHA256AcceptsOnlyAFullHexHash(t *testing.T) {
	valid := strings.Repeat("ab", 32)
	for value, wantLength := range map[string]int{valid: 32, " " + valid + "\n": 32, "": 0, strings.Repeat("ab", 31): 0, strings.Repeat("zz", 32): 0} {
		t.Setenv(OperatorReadTokenSHA256Env, value)
		if got := len(OperatorReadTokenSHA256()); got != wantLength {
			t.Fatalf("%q: got %d bytes, want %d", value, got, wantLength)
		}
	}
}
