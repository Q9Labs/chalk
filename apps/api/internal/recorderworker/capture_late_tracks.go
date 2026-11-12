package recorderworker

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

// lateTrackWatch waits for planned MIDs that sent no RTP when the attempt bound
// the others. Each MID has its own bounded wait that starts when it is first
// missing and ends in an attach or in a recording.capture_track_missing line.
// Waiting on the first packet itself, not on a checkpoint, starts the reader the
// moment the track arrives, so the late track keeps its true place on the
// Recording's clock. An expired binding stays recorded so a later plan change
// cannot start its wait again.
type lateTrackWatch struct {
	attempt  *PionCaptureAttempt
	ctx      context.Context
	results  chan lateTrackResult
	watching map[string]*lateTrackEntry
	expired  map[string]captureplane.PulledCaptureTrack
}

type lateTrackEntry struct {
	track  captureplane.PulledCaptureTrack
	since  time.Time
	cancel context.CancelFunc
}

type lateTrackResult struct {
	track captureplane.PulledCaptureTrack
	bound CaptureMediaTrack
	err   error
}

func newLateTrackWatch(ctx context.Context, attempt *PionCaptureAttempt) *lateTrackWatch {
	return &lateTrackWatch{
		attempt: attempt, ctx: ctx, results: make(chan lateTrackResult, 16),
		watching: make(map[string]*lateTrackEntry), expired: make(map[string]captureplane.PulledCaptureTrack),
	}
}

// bindable returns the planned tracks the bind should wait for: those that are
// neither waiting on a late first packet nor expired.
func (w *lateTrackWatch) bindable(planned []captureplane.PulledCaptureTrack) []captureplane.PulledCaptureTrack {
	bindable := make([]captureplane.PulledCaptureTrack, 0, len(planned))
	for _, track := range planned {
		if entry, ok := w.watching[string(track.MID)]; ok && entry.track == track {
			continue
		}
		if expired, ok := w.expired[string(track.MID)]; ok && expired == track {
			continue
		}
		bindable = append(bindable, track)
	}
	return bindable
}

// update drops watches and expiries whose binding left the plan, then starts a
// wait for each newly missing track.
func (w *lateTrackWatch) update(planned, missing []captureplane.PulledCaptureTrack) {
	inPlan := make(map[string]captureplane.PulledCaptureTrack, len(planned))
	for _, track := range planned {
		inPlan[string(track.MID)] = track
	}
	for mid, entry := range w.watching {
		if track, ok := inPlan[mid]; !ok || track != entry.track {
			entry.cancel()
			delete(w.watching, mid)
		}
	}
	for mid, track := range w.expired {
		if current, ok := inPlan[mid]; !ok || current != track {
			delete(w.expired, mid)
		}
	}
	for _, track := range missing {
		w.start(track)
	}
}

func (w *lateTrackWatch) start(track captureplane.PulledCaptureTrack) {
	mid := string(track.MID)
	if _, ok := w.watching[mid]; ok {
		return
	}
	waitCtx, cancel := context.WithTimeout(w.ctx, w.attempt.config.LateTrackWait)
	w.watching[mid] = &lateTrackEntry{track: track, since: w.attempt.config.Now(), cancel: cancel}
	slog.WarnContext(w.ctx, "recording capture track sent no RTP; attaching it if media starts",
		"event", "recording.capture_track_pending", "mid", mid, "kind", string(track.Kind), "source", string(track.Source),
		"give_up_after_ms", w.attempt.config.LateTrackWait.Milliseconds())
	go func() {
		result := lateTrackResult{track: track}
		defer func() {
			if recover() != nil {
				result.err = capturePanicError()
			}
			select {
			case w.results <- result:
			case <-w.ctx.Done():
			}
		}()
		result.bound, result.err = w.attempt.bindTrack(waitCtx, track)
	}()
}

// handle applies one wait result. It returns the bound track when the MID
// attached, and an error only when the attempt must fail.
func (w *lateTrackWatch) handle(result lateTrackResult) (CaptureMediaTrack, time.Time, error) {
	mid := string(result.track.MID)
	entry, ok := w.watching[mid]
	if !ok || entry.track != result.track {
		return nil, time.Time{}, nil
	}
	entry.cancel()
	delete(w.watching, mid)
	waitedMS := w.attempt.config.Now().Sub(entry.since).Milliseconds()
	switch {
	case result.err == nil:
		slog.InfoContext(w.ctx, "recording capture track sent its first RTP late and is attached",
			"event", "recording.capture_track_attached", "mid", mid, "kind", string(result.track.Kind), "source", string(result.track.Source), "waited_ms", waitedMS)
		var boundAt time.Time
		if bound, ok := result.bound.(interface{ BoundAt() time.Time }); ok {
			boundAt = bound.BoundAt()
		}
		return result.bound, boundAt, nil
	case w.ctx.Err() != nil:
		return nil, time.Time{}, w.ctx.Err()
	case errors.Is(result.err, errCaptureTrackSilent):
		w.expired[mid] = result.track
		slog.WarnContext(w.ctx, "recording capture track never sent RTP; the Recording has no media for it",
			"event", "recording.capture_track_missing", "mid", mid, "kind", string(result.track.Kind), "source", string(result.track.Source), "waited_ms", waitedMS)
		return nil, time.Time{}, nil
	default:
		return nil, time.Time{}, result.err
	}
}

func (w *lateTrackWatch) stop() {
	for _, entry := range w.watching {
		entry.cancel()
	}
}
