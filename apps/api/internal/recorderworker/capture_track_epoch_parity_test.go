package recorderworker

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A plan from an older Capture epoch must never reach the bundle writer of a
// newer epoch, or its tracks would append to the wrong recording.
func TestCaptureBundleWriterRefusesAPlanFromAnotherCaptureEpoch(t *testing.T) {
	origin := time.UnixMilli(1000).UTC()
	writer, _ := newCaptureTestWriter(t, origin)
	track := &captureTestTrack{capture: capturePlanWatchPulledTrack(t, "0", "epoch"), codec: "opus"}
	stale := captureTestPlanAtEpoch(t, 1, 1, origin)
	err := writer.reconcileTracks(context.Background(), stale, map[string]CaptureMediaTrack{"0": track}, origin)
	if !errors.Is(err, ErrInvalidCaptureAttempt) || len(writer.active) != 0 {
		t.Fatalf("stale epoch plan: err = %v, active tracks = %d; want refused and none active", err, len(writer.active))
	}
}
