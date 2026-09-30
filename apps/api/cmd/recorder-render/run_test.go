package main

import (
	"runtime"
	"testing"
)

func TestParseComposeThreads(t *testing.T) {
	for _, test := range []struct {
		raw     string
		want    int
		wantErr bool
	}{
		{"", min(runtime.NumCPU(), 4), false},
		{"8", 8, false},
		{"0", 0, true},
		{"65", 0, true},
		{"not-a-number", 0, true},
	} {
		threads, err := parseComposeThreads(test.raw)
		if threads != test.want || (err != nil) != test.wantErr {
			t.Errorf("parseComposeThreads(%q) = %d, %v", test.raw, threads, err)
		}
	}
}
