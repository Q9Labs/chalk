package recorderworker

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func (*captureAttemptStub) Observed() *recordingpipeline.CaptureObservations { return nil }

// observingAttemptStub is a capture that saw something.
type observingAttemptStub struct {
	captureAttemptStub
	observed *recordingpipeline.CaptureObservations
}

func (s *observingAttemptStub) Observed() *recordingpipeline.CaptureObservations { return s.observed }

// The completion carries what the capture saw, so an operator can tell a capture that ran with no
// packets from one that was never fed, without decrypting the manifest.
func TestCaptureCompletionCarriesWhatTheCaptureSaw(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	control := &captureControlStub{}
	control.complete = func(_ context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		return captureJobFromLease(input, time.Now().Add(DefaultCaptureLease)), nil
	}
	control.heartbeat = func(_ context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		return captureJobFromLease(input, time.Now().Add(DefaultCaptureLease)), nil
	}
	observed := &recordingpipeline.CaptureObservations{Tracks: 2, Packets: 41}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &observingAttemptStub{captureAttemptStub: captureAttemptStub{run: func(context.Context) error { return nil }}, observed: observed}, nil
	}), nil)
	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if control.completed.Observed == nil || *control.completed.Observed != *observed {
		t.Fatalf("completion carried %+v, want %+v", control.completed.Observed, observed)
	}
}

// A capture against an API that predates journey carry reports nothing: that API rejects the field.
func TestCaptureAttemptReportsNothingToAnOlderAPI(t *testing.T) {
	var attempt PionCaptureAttempt
	attempt.observer.record(&captureBundleWriter{packets: 3})
	if attempt.Observed() != nil {
		t.Fatal("an attempt whose claim carried no journey must not report observations")
	}
	attempt.observer.enabled = true
	if got := attempt.Observed(); got == nil || got.Packets != 3 {
		t.Fatalf("observed %+v", got)
	}
}
