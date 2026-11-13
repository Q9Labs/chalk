package weborigin

import (
	"errors"
	"testing"
)

func TestParse(t *testing.T) {
	for _, tc := range []struct {
		raw    string
		want   Origin
		secure bool
		valid  bool
	}{
		{"https://chalk.example", "https://chalk.example", true, true},
		{"HTTPS://chalk.example", "HTTPS://chalk.example", true, true},
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
		got, err := Parse(tc.raw)
		if tc.valid != (err == nil) || (err != nil && !errors.Is(err, ErrInvalid)) {
			t.Fatalf("Parse(%q) error = %v, want valid=%v", tc.raw, err, tc.valid)
		}
		if got != tc.want || (tc.valid && got.Secure() != tc.secure) {
			t.Fatalf("Parse(%q) = %q secure=%v, want %q secure=%v", tc.raw, got, got.Secure(), tc.want, tc.secure)
		}
	}
}
