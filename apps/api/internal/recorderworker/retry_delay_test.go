package recorderworker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestDaemonFailureRetryDelaysStayScopedToCaptureAttempts(t *testing.T) {
	now := time.Date(2026, 10, 24, 6, 0, 0, 0, time.UTC)
	for _, scenario := range []struct {
		name           string
		completion     bool
		completionOnly bool
		factoryFailure bool
		wantDelay      time.Duration
	}{
		{name: "capture attempt", wantDelay: 30 * time.Second},
		{name: "capture factory", factoryFailure: true, wantDelay: 30 * time.Second},
		{name: "capture completion", completion: true, wantDelay: 5 * time.Second},
		{name: "completion-only claim", completion: true, completionOnly: true, wantDelay: 5 * time.Second},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			control := &captureControlStub{complete: func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
				return recordingpipeline.Job{}, ErrControlPlaneFenced
			}}
			factory := captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
				if scenario.factoryFailure {
					return nil, errors.New("capture setup failed")
				}
				return &captureAttemptStub{run: func(context.Context) error {
					if scenario.completion {
						return nil
					}
					return errors.New("capture failed")
				}}, nil
			})
			daemon := captureDaemonForTest(t, control, factory, func() time.Time { return now })
			claim := captureDaemonClaim(t, 1)
			claim.Envelope.CompletionOnly = scenario.completionOnly
			if err := daemon.runClaim(t.Context(), claim); err != nil {
				t.Fatal(err)
			}
			if control.failCalls != 1 || !control.failed.AvailableAt.Equal(now.Add(scenario.wantDelay)) {
				t.Fatalf("reported %d failures with retry at %s, want %s", control.failCalls, control.failed.AvailableAt, now.Add(scenario.wantDelay))
			}
		})
	}
	for _, kind := range []recordingpipeline.JobKind{recordingpipeline.JobKindRender, recordingpipeline.JobKindTranscription} {
		t.Run(string(kind), func(t *testing.T) {
			control := &renderControlPlaneStub{}
			attempt := &renderAttemptStub{run: func(context.Context) error { return errors.New("render failed") }}
			daemon, err := NewRenderDaemon(control, renderAttemptFactoryStub{attempt: attempt}, RenderDaemonConfig{Now: func() time.Time { return now }})
			if err != nil {
				t.Fatal(err)
			}
			claim := renderClaimForTest(t)
			claim.Envelope.Kind = kind
			if err := daemon.runClaim(t.Context(), claim); err != nil {
				t.Fatal(err)
			}
			if control.failed == nil || !control.failed.AvailableAt.Equal(now.Add(5*time.Second)) {
				t.Fatalf("failure = %+v, want retry at %s", control.failed, now.Add(5*time.Second))
			}
		})
	}
}
