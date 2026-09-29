package main

import (
	"runtime"
	"testing"
)

func TestParseExportRenderer(t *testing.T) {
	for _, test := range []struct {
		renderer string
		threads  string
		wantMode string
		wantN    int
		wantErr  bool
	}{
		{"", "", "browser", min(runtime.NumCPU(), 4), false},
		{"native", "8", "native", 8, false},
		{"browser", "64", "browser", 64, false},
		{"other", "", "", 0, true},
		{"native", "0", "", 0, true},
		{"native", "65", "", 0, true},
		{"native", "not-a-number", "", 0, true},
	} {
		mode, n, err := parseExportRenderer(test.renderer, test.threads)
		if mode != test.wantMode || n != test.wantN || (err != nil) != test.wantErr {
			t.Errorf("parseExportRenderer(%q, %q) = %q, %d, %v", test.renderer, test.threads, mode, n, err)
		}
	}
}
