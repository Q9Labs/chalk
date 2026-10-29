package recorderworker

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestManualStopCloseFailureSkipsCallbackAndUsesCompletionOnlySalvage(t *testing.T) {
	// The retained incident has a 502 close response after a non-retryable
	// protocol/provider_track_200 failure. Its raw provider response is unknown.
	claim := captureDaemonClaim(t, 2)
	lifecycle := &captureTestLifecycle{}
	attempt := captureStoppedTestAttempt(t, time.Now().UTC(), lifecycle, time.Second)
	attempt.coordinator = &captureFailedCloseCoordinator{failure: HTTPError{Status: http.StatusBadGateway, Code: "recording.capture_provider_failed", Retryable: true}}
	control := &captureControlStub{}
	factoryCalls := 0
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		factoryCalls++
		return attempt, nil
	}), nil)
	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatal(err)
	}
	if len(lifecycle.stopped) != 0 || control.failCalls != 1 || control.completeCalls.Load() != 0 || control.failed.ErrorCode != "capture_attempt_failed" {
		t.Fatalf("failed close must skip callback and report failure: stopped=%d fail=%d complete=%d code=%s", len(lifecycle.stopped), control.failCalls, control.completeCalls.Load(), control.failed.ErrorCode)
	}
	claim.Envelope.CompletionOnly = true
	claim.Envelope.AttemptCount++
	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatal(err)
	}
	if factoryCalls != 1 || len(lifecycle.stopped) != 0 || control.completeCalls.Load() != 1 || control.completed.CaptureEpoch != 2 {
		t.Fatalf("salvage must complete the same epoch without a media attempt or worker callback: factory=%d stopped=%d complete=%d epoch=%d", factoryCalls, len(lifecycle.stopped), control.completeCalls.Load(), control.completed.CaptureEpoch)
	}
}

type captureFailedCloseCoordinator struct {
	captureTestCoordinator
	failure error
}

func (coordinator *captureFailedCloseCoordinator) Close(context.Context, bool) error {
	return coordinator.failure
}
