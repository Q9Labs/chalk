package observability

import (
	"context"
	"log/slog"
	"time"
)

func LogOperation(ctx context.Context, logger *slog.Logger, event string, name string, startedAt time.Time, err error) {
	if logger == nil {
		return
	}

	attrs := []any{
		"event", event,
		"name", name,
		"duration_ms", milliseconds(time.Since(startedAt)),
	}
	if err != nil {
		attrs = append(attrs, "outcome", "error", "error", err.Error())
	} else {
		attrs = append(attrs, "outcome", "ok")
	}

	logger.InfoContext(ctx, "operation", attrs...)
}

func milliseconds(duration time.Duration) float64 {
	return float64(duration.Microseconds()) / 1000
}
