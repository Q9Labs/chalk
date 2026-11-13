package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureCompletionHeartbeatsWhileBlockedAndRetriesTransientFailure(t *testing.T) {
	claim := captureDaemonClaim(t, 7)
	started := make(chan struct{})
	captureHeartbeat := make(chan struct{})
	var completionHeartbeat sync.Once
	renewed := make(chan struct{})
	control := &captureControlStub{}
	control.complete = func(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		if control.completeCalls.Load() == 1 {
			close(started)
			select {
			case <-renewed:
				return recordingpipeline.Job{}, TransportError{Err: errors.New("response lost")}
			case <-ctx.Done():
				return recordingpipeline.Job{}, ctx.Err()
			}
		}
		return captureJobFromLease(input, time.Now().Add(DefaultCaptureLease)), nil
	}
	control.heartbeat = func(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		if control.heartbeatCalls == 1 {
			close(captureHeartbeat)
		}
		select {
		case <-started:
			completionHeartbeat.Do(func() { close(renewed) })
		default:
		}
		return captureJobFromLease(input, time.Now().Add(DefaultCaptureLease)), nil
	}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(ctx context.Context) error {
			// Exercise a capture heartbeat before completion starts. Heartbeats
			// must renew that lease without waiting for the completion RPC.
			select {
			case <-captureHeartbeat:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}}, nil
	}), nil)
	daemon.config.HeartbeatInterval = time.Millisecond
	daemon.config.ClaimRetryWait = time.Millisecond
	daemon.config.CompletionTimeout = time.Second
	if err := daemon.runClaim(context.Background(), claim); err != nil {
		t.Fatalf("complete with live lease: %v", err)
	}
	if control.completeCalls.Load() != 2 || control.heartbeatCalls < 2 || control.failCalls != 0 || control.completed.CaptureEpoch != claim.Envelope.CaptureEpoch {
		t.Fatalf("completion calls=%d heartbeat=%d failures=%d epoch=%d", control.completeCalls.Load(), control.heartbeatCalls, control.failCalls, control.completed.CaptureEpoch)
	}
}

func TestCaptureCompletionTimeoutRetainsHTTPAnswerAfterTransportRetry(t *testing.T) {
	finished := make(chan struct{})
	control := &captureControlStub{}
	control.complete = func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		if control.completeCalls.Load() == 1 {
			return recordingpipeline.Job{}, HTTPError{Status: 503, Code: "recording.invalid_completion_source", Retryable: true}
		}
		return recordingpipeline.Job{}, TransportError{Err: errors.New("response lost")}
	}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(context.Context) error { return nil }}, nil
	}), nil)
	daemon.config.CompletionTimeout = time.Second
	daemon.config.Wait = func(ctx context.Context, _ time.Duration) error {
		if control.completeCalls.Load() == 1 {
			return nil
		}
		defer close(finished)
		<-ctx.Done()
		return ctx.Err()
	}
	if err := daemon.runClaim(context.Background(), captureDaemonClaim(t, 7)); err != nil {
		t.Fatalf("reported completion failure: %v", err)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("completion retry did not finish after timeout")
	}
	want := "stage=api_complete outcome=timed_out error_class=http http_status=503 api_error_code=recording.invalid_completion_source"
	if control.completeCalls.Load() != 2 || control.failCalls != 1 || control.failed.ErrorDetail != want {
		t.Fatalf("completion calls=%d failures=%d detail=%q", control.completeCalls.Load(), control.failCalls, control.failed.ErrorDetail)
	}
}

func TestCaptureCompletionDoesNotRetryTerminalFailure(t *testing.T) {
	control := &captureControlStub{complete: func(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
		return recordingpipeline.Job{}, ErrControlPlaneFenced
	}}
	daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
		return &captureAttemptStub{run: func(context.Context) error { return nil }}, nil
	}), nil)
	if err := daemon.runClaim(context.Background(), captureDaemonClaim(t, 7)); err != nil {
		t.Fatalf("reported completion failure: %v", err)
	}
	if control.completeCalls.Load() != 1 || control.failCalls != 1 || control.failed.ErrorCode != completionFailureCode || control.failed.ErrorDetail != "stage=api_complete outcome=returned error_class=fenced http_status=0" {
		t.Fatalf("completion calls=%d failures=%d detail=%q", control.completeCalls.Load(), control.failCalls, control.failed.ErrorDetail)
	}
}

func TestCaptureCompletionCancelsWhenBoundExpiresOrLeaseIsLost(t *testing.T) {
	for _, leaseLost := range []bool{false, true} {
		t.Run(fmt.Sprint("lease_lost=", leaseLost), func(t *testing.T) {
			finished := make(chan struct{})
			started := make(chan struct{})
			control := &captureControlStub{complete: func(ctx context.Context, _ recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
				close(started)
				defer close(finished)
				<-ctx.Done()
				return recordingpipeline.Job{}, ctx.Err()
			}}
			if leaseLost {
				control.heartbeat = func(ctx context.Context, _ recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
					select {
					case <-started:
					case <-ctx.Done():
						return recordingpipeline.Job{}, ctx.Err()
					}
					return recordingpipeline.Job{}, ErrControlPlaneFenced
				}
			}
			daemon := captureDaemonForTest(t, control, captureAttemptFactoryFunc(func(context.Context, ClaimResult) (CaptureAttempt, error) {
				return &captureAttemptStub{run: func(context.Context) error { return nil }}, nil
			}), nil)
			daemon.config.HeartbeatInterval = time.Millisecond
			daemon.config.CompletionTimeout = 20 * time.Millisecond
			claim := captureDaemonClaim(t, 7)
			claim.Envelope.CompletionOnly = true
			err := daemon.runClaim(context.Background(), claim)
			want := context.DeadlineExceeded
			if leaseLost {
				want = ErrControlPlaneFenced
			}
			wantDetail := "stage=api_complete outcome=timed_out error_class=deadline http_status=0"
			if leaseLost {
				wantDetail = "stage=lease_renewal outcome=returned error_class=fenced http_status=0"
			}
			if err != nil || control.failCalls != 1 || control.failed.ErrorDetail != wantDetail {
				t.Fatalf("completion report = %v, failures=%d detail=%q, cause=%v", err, control.failCalls, control.failed.ErrorDetail, want)
			}
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Fatal("completion request was not canceled")
			}
		})
	}
}
