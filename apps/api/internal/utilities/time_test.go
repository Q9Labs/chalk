package utilities_test

import (
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestFormatTimestamp(t *testing.T) {
	value := time.Date(2026, 6, 30, 10, 5, 0, 123456789, time.FixedZone("PKT", 5*60*60))

	got := utilities.FormatTimestamp(value)
	if got != "2026-06-30T05:05:00.123456789Z" {
		t.Fatalf("timestamp = %q, want UTC RFC3339Nano", got)
	}
}
