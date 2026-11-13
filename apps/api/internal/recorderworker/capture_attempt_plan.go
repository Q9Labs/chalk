package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
)

// Bootstrap owns the coordinator until its goroutine has joined. Plan polling
// can cancel blocked provider I/O without concurrently mutating the coordinator.
func (a *PionCaptureAttempt) bootstrapWhileWatchingPlans(ctx context.Context, initial captureplan.Plan, events <-chan capturePlanEvent) (recordercapture.Snapshot, captureplan.Plan, error) {
	bootstrapCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		snapshot recordercapture.Snapshot
		err      error
	}
	done := make(chan result, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- result{err: capturePanicError()}
			}
		}()
		snapshot, err := a.coordinator.Bootstrap(bootstrapCtx, initial)
		done <- result{snapshot, err}
	}()
	latest := initial
	for {
		select {
		case completed := <-done:
			if completed.err != nil {
				return recordercapture.Snapshot{}, latest, completed.err
			}
			if latest.Revision() > initial.Revision() {
				snapshot, err := a.coordinator.Reconcile(ctx, latest)
				return snapshot, latest, err
			}
			return completed.snapshot, latest, nil
		case event := <-events:
			if event.checkpointNoRTP {
				continue
			}
			if event.err == nil && event.plan.StopState() == captureplan.StopStateRunning {
				latest = event.plan
				continue
			}
			cancel()
			completed := <-done
			if completed.err != nil && !errors.Is(completed.err, context.Canceled) {
				return recordercapture.Snapshot{}, latest, completed.err
			}
			if event.err != nil {
				return recordercapture.Snapshot{}, latest, event.err
			}
			return completed.snapshot, event.plan, nil
		case <-ctx.Done():
			cancel()
			completed := <-done
			if completed.err != nil {
				return recordercapture.Snapshot{}, latest, completed.err
			}
			return recordercapture.Snapshot{}, latest, ctx.Err()
		}
	}
}

func (a *PionCaptureAttempt) initialPlan(ctx context.Context) (captureplan.Plan, error) {
	a.mu.Lock()
	lease := a.lease
	a.mu.Unlock()
	authority := captureplan.PlanAuthority{
		PlanHandle: a.authority.PlanHandle, TenantID: a.authority.TenantID, SpaceID: a.authority.SpaceID,
		EpisodeID: a.authority.EpisodeID, RecordingID: a.authority.RecordingID, JobID: a.authority.JobID,
		AttemptCount: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
		CaptureEpoch: a.authority.CaptureEpoch, EnvelopeDigest: a.authority.EnvelopeDigest,
	}
	input := captureplan.NewWaitInput(authority, captureplan.WorkerLease{Owner: lease.Owner, Token: lease.Token, ExpiresAt: lease.ExpiresAt}, 0, a.config.InitialPlanWait)
	return a.plans.WaitForPlan(ctx, input)
}

func (a *PionCaptureAttempt) planLoop(ctx context.Context, output chan<- capturePlanEvent, afterRevision captureplane.PlanRevision) {
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		a.mu.Lock()
		lease := a.lease
		a.mu.Unlock()
		authority := captureplan.PlanAuthority{
			PlanHandle: a.authority.PlanHandle, TenantID: a.authority.TenantID, SpaceID: a.authority.SpaceID,
			EpisodeID: a.authority.EpisodeID, RecordingID: a.authority.RecordingID, JobID: a.authority.JobID,
			AttemptCount: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
			CaptureEpoch: a.authority.CaptureEpoch, EnvelopeDigest: a.authority.EnvelopeDigest,
		}
		input := captureplan.NewWaitInput(authority, captureplan.WorkerLease{Owner: lease.Owner, Token: lease.Token, ExpiresAt: lease.ExpiresAt}, afterRevision, a.config.PlanWait)
		plan, err := a.plans.WaitForPlan(ctx, input)
		if err != nil {
			if errors.Is(err, ErrNoChange) || errors.Is(err, captureplan.ErrNoChange) || errors.Is(err, captureplan.ErrWaitTimeout) {
				if sendCapturePlanEvent(ctx, output, capturePlanEvent{checkpointNoRTP: true, at: a.config.Now().UTC()}) != nil {
					return
				}
				continue
			}
			if sendCapturePlanEvent(ctx, output, capturePlanEvent{err: err}) != nil {
				return
			}
			return
		}
		// The packet consumer applies each plan before the next one can retire
		// its tracks. Polling must not mutate the peer ahead of that consumer.
		if sendCapturePlanEvent(ctx, output, capturePlanEvent{plan: plan}) != nil {
			return
		}
		afterRevision = plan.Revision()
	}
}

type capturePlanEvent struct {
	plan            captureplan.Plan
	err             error
	checkpointNoRTP bool
	at              time.Time
}

func sendCapturePlanEvent(ctx context.Context, output chan<- capturePlanEvent, event capturePlanEvent) error {
	select {
	case output <- event:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *PionCaptureAttempt) packetAuthority(ctx context.Context) (captureplan.Plan, error) {
	if !a.authority.HardDeadline.IsZero() && !a.config.Now().UTC().Before(a.authority.HardDeadline) {
		return captureplan.Plan{}, recordercapture.ErrDeadlineExpired
	}
	lease := a.currentLease()
	authority := captureplan.PlanAuthority{
		PlanHandle: a.authority.PlanHandle, TenantID: a.authority.TenantID, SpaceID: a.authority.SpaceID,
		EpisodeID: a.authority.EpisodeID, RecordingID: a.authority.RecordingID, JobID: a.authority.JobID,
		AttemptCount: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
		CaptureEpoch: a.authority.CaptureEpoch, EnvelopeDigest: a.authority.EnvelopeDigest,
	}
	input := captureplan.NewWaitInput(authority, captureplan.WorkerLease{Owner: lease.Owner, Token: lease.Token, ExpiresAt: lease.ExpiresAt}, 0, captureplan.MinimumWait)
	plan, err := a.plans.WaitForPlan(ctx, input)
	if err != nil {
		return captureplan.Plan{}, fmt.Errorf("authorize capture packets: %w", err)
	}
	return plan, nil
}

func capturePacketAllowed(plan captureplan.Plan, track captureplane.PulledCaptureTrack) bool {
	if plan.StopState() != captureplan.StopStateRunning {
		return false
	}
	for _, desired := range plan.Tracks() {
		if desired.OwnerReference == track.OwnerReference && desired.TrackReference == track.TrackReference &&
			desired.ParticipantID == track.ParticipantID && desired.ParticipantGeneration == track.ParticipantGeneration &&
			desired.Source == track.Source && desired.Kind == track.Kind {
			return true
		}
	}
	return false
}
