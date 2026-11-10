package recorderworker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureAttemptStopAfterPartialReconcileCompletesNormally(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	planAuthority := captureTestPlanAtEpoch(t, 1, 1, now).Authority()
	planAuthority.AttemptCount = recordingpipeline.DefaultCaptureAttemptLimit
	lifecycle := &captureTestLifecycle{}
	peer := &captureTestPeer{epoch: 1}
	attempt := capturePlanWatchAttempt(t, planAuthority, nil, peer, nil, nil, &captureTestStorage{}, lifecycle, func() time.Time { return now }, time.Second, time.Second)
	authority := attempt.authority
	authority.Envelope.InitialPlanRevision = 1
	authority.SignalingHandle = capturesignaling.SignalingHandle("77777777-7777-4777-8777-777777777777")
	authority.Lease = attempt.lease
	signaling := &reconcileStoppedSignaling{}
	coordinator, err := recordercapture.NewCoordinator(authority, signaling, peer, recordercapture.Config{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	attempt.coordinator = coordinator
	initial := capturePlanWatchPlan(t, planAuthority, 1, now, captureplan.StopStateRunning, capturePlanWatchPulledTrack(t, "0", "initial"))
	replacement := capturePlanWatchPlan(t, planAuthority, 2, now, captureplan.StopStateRunning, capturePlanWatchPulledTrack(t, "1", "replacement"))
	if _, err := coordinator.Bootstrap(t.Context(), initial); err != nil {
		t.Fatal(err)
	}
	if _, err := coordinator.Reconcile(t.Context(), replacement); !errors.Is(err, capturesignaling.ErrMediaStopped) {
		t.Fatalf("replacement did not observe stop: %v", err)
	}
	// This is the real terminal path reached when dispatch observes a durable stop
	// before plan polling. It must retire the revision-2 connection before Stopped.
	err = attempt.finishStopped(nil, now, recordingbundle.CloseReasonExplicit)
	t.Logf("attempt=%d finishStopped=%v stopped callbacks=%d provider closes=%d", authority.AttemptCount, err, len(lifecycle.stopped), signaling.closes)
	if err != nil || len(lifecycle.stopped) != 1 || signaling.closes != 1 {
		t.Fatal("final-attempt durable stop did not retire and complete normally")
	}
	if lifecycle.stopped[0].Attempt != recordingpipeline.DefaultCaptureAttemptLimit {
		t.Fatal("stop did not retain final attempt authority")
	}
}

// Persistence/provider stand-in that uses the production projection reducer and
// validator. In particular it must reject a stale retirement revision.
type reconcileStoppedSignaling struct {
	projection *capturesignaling.ConnectionProjection
	closes     int
}

func (s *reconcileStoppedSignaling) Execute(_ context.Context, r capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	cmd := r.Command
	if err := capturesignaling.ValidatePreparedCommand(capturesignaling.PreparedCommand{SignalingHandle: cmd.SignalingHandle, Authority: cmd.Authority, Identity: cmd.Identity, Input: cmd.Input}, s.projection); err != nil {
		return capturesignaling.Execution{}, err
	}
	connection := captureplane.CaptureConnection{ConnectionReference: "capture-session", CaptureEpoch: cmd.Authority.CaptureEpoch, PlanRevision: cmd.Identity.PlanRevision}
	var result capturesignaling.CommandResult
	switch cmd.Identity.Operation {
	case captureplane.OperationCreateCaptureConnection:
		result.CreateCaptureConnection = &captureplane.CreateCaptureConnectionResult{Connection: connection, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}
	case captureplane.OperationPullCaptureTracks:
		if cmd.Identity.PlanRevision == 2 {
			return capturesignaling.Execution{}, capturesignaling.ErrMediaStopped
		}
		tracks := make([]captureplane.PulledCaptureTrack, 0, len(cmd.Input.PullCaptureTracks.Tracks))
		for _, track := range cmd.Input.PullCaptureTracks.Tracks {
			tracks = append(tracks, captureplane.PulledCaptureTrack{CaptureTrack: track, MID: "0"})
		}
		result.PullCaptureTracks = &captureplane.PullCaptureTracksResult{Connection: connection, Tracks: tracks, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}
	case captureplane.OperationCloseCaptureTracks:
		result.CloseCaptureTracks = &captureplane.CloseCaptureTracksResult{Connection: connection, Tracks: cmd.Input.CloseCaptureTracks.Tracks, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}
	case captureplane.OperationCloseCaptureConnection:
		s.closes++
		result.CloseCaptureConnection = &captureplane.CloseCaptureConnectionResult{Connection: connection, Closed: true}
	default:
		return capturesignaling.Execution{}, errors.New("unexpected signaling operation")
	}
	var err error
	s.projection, err = capturesignaling.ProjectResult(cmd.SignalingHandle, cmd.Authority, cmd.Identity.Operation, result, s.projection)
	return capturesignaling.Execution{Key: capturesignaling.CommandKey{SignalingHandle: cmd.SignalingHandle, Operation: cmd.Identity.Operation, PlanRevision: cmd.Identity.PlanRevision, IdempotencyKey: cmd.Identity.IdempotencyKey}, Result: result}, err
}
