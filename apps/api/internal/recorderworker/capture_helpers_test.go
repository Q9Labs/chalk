package recorderworker

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

// Test-only entry points and fixtures restored with the Capture suite.
// Production code calls the context-taking variants directly.

func (a *PionCaptureAttempt) emitReady(ctx context.Context, noPublisher bool) error {
	return a.emitReadyAt(ctx, noPublisher, a.config.Now().UTC())
}

func (w *captureBundleWriter) close(reason recordingbundle.CloseReason, now time.Time) error {
	storageCtx, cancel := context.WithTimeout(context.Background(), w.attempt.config.CloseTimeout)
	defer cancel()
	return w.closeWithContext(storageCtx, reason, now)
}

func bytesOf(value byte) []byte {
	result := make([]byte, 32)
	result[0] = value
	return result
}
