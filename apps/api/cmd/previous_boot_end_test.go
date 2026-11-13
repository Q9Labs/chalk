package main

import "testing"

func TestPreviousBootEndIsAnEnum(t *testing.T) {
	for in, want := range map[string]string{"clean": "clean", "killed": "killed", "": "unknown", "oops": "unknown"} {
		if got := previousBootEnd(in); got != want {
			t.Errorf("previousBootEnd(%q) = %q, want %q", in, got, want)
		}
	}
}
