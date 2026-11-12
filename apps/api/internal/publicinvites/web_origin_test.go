package publicinvites

import (
	"errors"
	"testing"
)

func TestParseWebOrigin(t *testing.T) {
	for _, tc := range []struct {
		raw    string
		want   WebOrigin
		secure bool
		valid  bool
	}{
		{"https://chalk.example", "https://chalk.example", true, true},
		{" http://localhost:3000 ", "http://localhost:3000", false, true},
		{"", "", false, false},
		{"chalk.example", "", false, false},
		{"ftp://chalk.example", "", false, false},
		{"https://user@chalk.example", "", false, false},
		{"https://chalk.example/space", "", false, false},
		{"https://chalk.example/", "", false, false},
		{"https://chalk.example?x=1", "", false, false},
		{"https://chalk.example#x", "", false, false},
	} {
		got, err := ParseWebOrigin(tc.raw)
		if tc.valid != (err == nil) || (err != nil && !errors.Is(err, ErrInvalidWebOrigin)) {
			t.Fatalf("ParseWebOrigin(%q) error = %v, want valid=%v", tc.raw, err, tc.valid)
		}
		if got != tc.want || (tc.valid && got.Secure() != tc.secure) {
			t.Fatalf("ParseWebOrigin(%q) = %q secure=%v, want %q secure=%v", tc.raw, got, got.Secure(), tc.want, tc.secure)
		}
	}
}
