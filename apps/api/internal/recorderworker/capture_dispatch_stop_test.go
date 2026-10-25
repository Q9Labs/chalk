package recorderworker

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
)

func TestCaptureAttemptDurableStopBeforePlanPollCompletesNormally(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	planAuthority := captureTestPlanAtEpoch(t, 1, 1, now).Authority()
	running := capturePlanWatchPlan(t, planAuthority, 1, now, captureplan.StopStateRunning, capturePlanWatchPulledTrack(t, "0", "bootstrap"))
	lifecycle := &captureTestLifecycle{}
	peer := &captureTestPeer{epoch: 1}
	// The DB stop is visible to CheckDispatch before the next plan long poll completes.
	dispatchStarted := make(chan struct{})
	plans := &capturePlanWatchSource{steps: []capturePlanWatchStep{
		func(context.Context) (captureplan.Plan, error) { return running, nil },
		func(ctx context.Context) (captureplan.Plan, error) {
			<-dispatchStarted
			<-ctx.Done()
			return captureplan.Plan{}, ctx.Err()
		},
	}}
	attempt := capturePlanWatchAttempt(t, planAuthority, nil, peer, nil, plans, &captureTestStorage{}, lifecycle, func() time.Time { return now }, time.Second, time.Second)
	client, err := NewControlPlaneClient("https://api.test", &http.Client{Transport: readinessRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(dispatchStarted)
		return &http.Response{StatusCode: http.StatusConflict, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":{"code":"recording.capture_media_stopped","message":"Capture media stopped or reached its deadline"}}`)), Request: r}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	authority := attempt.authority
	authority.Envelope.InitialPlanRevision = 1
	authority.SignalingHandle = capturesignaling.SignalingHandle("77777777-7777-4777-8777-777777777777")
	authority.Lease = attempt.lease
	coordinator, err := recordercapture.NewCoordinator(authority, client, peer, recordercapture.Config{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	attempt.coordinator = coordinator
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	err = attempt.Run(ctx)
	t.Logf("Run error=%v; stopped callbacks=%d", err, len(lifecycle.stopped))
	if err != nil || len(lifecycle.stopped) != 1 {
		t.Fatal("durable stop was reported as an attempt failure, not a normal stop")
	}
}
