package httpapi

import (
	"context"
	"log/slog"
)

type syncConnectionReporter interface {
	SyncConnected(ctx context.Context) (bool, error)
}

// addSyncConnection shows whether Sync is connected, like the retirement backlog: it never fails readiness, so a
// Sync outage cannot take the API out of service, restart it or roll a release back. An unreadable answer is left
// out instead of guessed.
func addSyncConnection(ctx context.Context, checker ReadinessChecker, body map[string]any) {
	reporter, ok := checker.(syncConnectionReporter)
	if !ok {
		return
	}
	connected, err := reporter.SyncConnected(ctx)
	if err != nil {
		slog.Warn("read sync connection for readiness", "error", err)
		return
	}
	body["sync"] = syncConnectionStatus(connected)
}

func syncConnectionStatus(connected bool) string {
	if connected {
		return "connected"
	}
	return "disconnected"
}
