package recorderworker

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

// finishByCause settles a capture's stop. Only the media stop and the deadline are normal stops:
// storage, lease and provider failures must still fail even at the limit.
func (a *PionCaptureAttempt) finishByCause(runCtx context.Context, err error, writer *captureBundleWriter) error {
	cause := err
	// Follow a single causal chain only. A joined storage/provider failure
	// plus cancellation is still a failure, not a successful limit stop.
	for errors.Unwrap(cause) != nil {
		cause = errors.Unwrap(cause)
	}
	if cause == capturesignaling.ErrMediaStopped {
		return a.finishSuccess(writer)
	}
	if cause == recordercapture.ErrDeadlineExpired ||
		(cause == context.Canceled && errors.Is(context.Cause(runCtx), recordercapture.ErrDeadlineExpired)) {
		return a.finishStopped(writer, a.authority.HardDeadline, recordingbundle.CloseReasonMaxDuration)
	}
	return a.finishFailure(err, writer)
}

// logCaptureSummary is the recorder's own account of what a capture saw. A capture that ends
// with no packets is the early sign of an empty Recording, before the API counts bundles.
func logCaptureSummary(ctx context.Context, writer *captureBundleWriter, stop error, result error) {
	if writer == nil {
		return
	}
	level, outcome := slog.LevelInfo, "stopped"
	switch {
	case result != nil:
		level, outcome = slog.LevelWarn, "failed"
	case writer.packets == 0:
		level, outcome = slog.LevelWarn, "stopped_without_media"
	}
	slog.Log(ctx, level, "recording capture finished",
		"event", "recording.capture_finished", "outcome", outcome,
		"track_count", len(writer.clocks), "packet_count", writer.packets,
		"stop_cause", captureStopCause(stop))
}

// captureStopCause names the stop in words that carry no peer or storage text.
func captureStopCause(stop error) string {
	switch {
	case errors.Is(stop, capturesignaling.ErrMediaStopped):
		return "media_stopped"
	case errors.Is(stop, recordercapture.ErrDeadlineExpired):
		return "deadline"
	case errors.Is(stop, context.Canceled):
		return "canceled"
	default:
		return "error"
	}
}

// captureObserver keeps what the capture saw until the daemon completes the job. It reports only
// when the API answered the claim with the Episode journey: an API that predates journey carry
// also rejects the observed fields on completion.
type captureObserver struct {
	enabled  bool
	mu       sync.Mutex
	observed *recordingpipeline.CaptureObservations
}

func (o *captureObserver) record(writer *captureBundleWriter) {
	if writer == nil {
		return
	}
	o.mu.Lock()
	o.observed = &recordingpipeline.CaptureObservations{Tracks: len(writer.clocks), Packets: int64(writer.packets)}
	o.mu.Unlock()
}

// Observed is what the finished capture saw, or nil when the API cannot take it.
func (a *PionCaptureAttempt) Observed() *recordingpipeline.CaptureObservations {
	if !a.observer.enabled {
		return nil
	}
	a.observer.mu.Lock()
	defer a.observer.mu.Unlock()
	return a.observer.observed
}
