package utilities

import "time"

func FormatTimestamp(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}
