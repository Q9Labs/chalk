package utilities

import "time"

func FormatTimestamp(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

// Clock is the time source a service reads, so tests can control it.
type Clock func() time.Time
