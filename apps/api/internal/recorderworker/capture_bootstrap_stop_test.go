package recorderworker

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
)

func TestCaptureAttemptStopAndDeadlineCancelBootstrap(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		name := "durable stop plan"
		if deadline {
			name = "media deadline"
		}
		t.Run(name, func(t *testing.T) {
			now := time.Unix(3_000, 0).UTC()
			clock := &capturePlanWatchClock{now: now}
			authority := captureTestPlanAtEpoch(t, 1, 1, now).Authority()
			running := capturePlanWatchPlan(t, authority, 1, now, captureplan.StopStateRunning, capturePlanWatchPulledTrack(t, "0", "bootstrap"))
			stopped := capturePlanWatchPlan(t, authority, 2, now.Add(time.Second), captureplan.StopStateRequested)
			coordinator := &captureBlockedBootstrap{capturePlanWatchCoordinator: newCapturePlanWatchCoordinator(nil), started: make(chan struct{}), canceled: make(chan struct{})}
			expired := make(chan time.Time)
			plans := &capturePlanWatchSource{steps: []capturePlanWatchStep{
				func(context.Context) (captureplan.Plan, error) { return running, nil },
				func(ctx context.Context) (captureplan.Plan, error) {
					select {
					case <-coordinator.started:
						if !deadline {
							return stopped, nil
						}
						clock.Set(now.Add(time.Hour))
						close(expired)
					case <-ctx.Done():
						return captureplan.Plan{}, ctx.Err()
					}
					<-ctx.Done()
					return captureplan.Plan{}, ctx.Err()
				},
			}}
			lifecycle := &captureTestLifecycle{}
			attempt := capturePlanWatchAttempt(t, authority, nil, &capturePlanWatchPeer{}, coordinator, plans, &captureTestStorage{}, lifecycle, clock.Now, time.Second, time.Second)
			attempt.config.After = func(time.Duration) <-chan time.Time { return expired }
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			if err := attempt.Run(ctx); err != nil {
				t.Fatalf("supervised bootstrap: %v", err)
			}
			select {
			case <-coordinator.canceled:
			default:
				t.Fatal("bootstrap cancellation was not joined")
			}
			if coordinator.closeCalls != 1 || len(lifecycle.stopped) != 1 {
				t.Fatalf("cleanup/stopped callbacks = %d/%d, want 1/1", coordinator.closeCalls, len(lifecycle.stopped))
			}
		})
	}
}

type captureBlockedBootstrap struct {
	*capturePlanWatchCoordinator
	started, canceled chan struct{}
}

func (c *captureBlockedBootstrap) Bootstrap(ctx context.Context, _ captureplan.Plan) (recordercapture.Snapshot, error) {
	close(c.started)
	<-ctx.Done()
	close(c.canceled)
	return recordercapture.Snapshot{}, ctx.Err()
}
