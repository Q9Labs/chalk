package recorderworker

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

// PionCaptureAttempt runs one server-issued epoch from plan bootstrap to
// provider shutdown. It does not own the job lease; CaptureDaemon renews it.
type PionCaptureAttempt struct {
	mu sync.Mutex

	authority   recordercapture.AttemptAuthority
	lease       capturesignaling.WorkerLease
	peer        CapturePeer
	coordinator captureCoordinator
	plans       recordercapture.PlanSource
	keys        CaptureKeyPort
	objects     CaptureObjectPort
	bundles     CaptureBundleSink
	lifecycle   CaptureLifecyclePort
	config      CaptureAttemptConfig

	running    bool
	closing    bool
	closed     bool
	closeDone  chan struct{}
	closeErr   error
	ready      bool
	readyEvent CaptureReadyEvent
}

type captureCoordinator interface {
	Bootstrap(context.Context, captureplan.Plan) (recordercapture.Snapshot, error)
	Reconcile(context.Context, captureplan.Plan) (recordercapture.Snapshot, error)
	Snapshot() (recordercapture.Snapshot, error)
	Close(context.Context, bool) error
	RenewLease(capturesignaling.WorkerLease) error
}

var _ CaptureAttemptFactory = (*PionCaptureAttemptFactory)(nil)
var _ CaptureAttempt = (*PionCaptureAttempt)(nil)

func (a *PionCaptureAttempt) Run(ctx context.Context) error {
	if a == nil || a.peer == nil || a.coordinator == nil || a.plans == nil || a.keys == nil || a.objects == nil || a.bundles == nil || a.lifecycle == nil {
		return ErrInvalidCaptureAttempt
	}
	if ctx == nil {
		ctx = context.Background()
	}
	a.mu.Lock()
	if a.running || a.closing || a.closed {
		a.mu.Unlock()
		return ErrInvalidCaptureAttempt
	}
	a.running = true
	a.mu.Unlock()

	runCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	finish := func(err error, writer *captureBundleWriter) error {
		// Only the deadline and its cancellation are normal stops. Storage,
		// lease and provider failures must still fail even at the limit.
		cause := err
		// Follow a single causal chain only. A joined storage/provider failure
		// plus cancellation is still a failure, not a successful limit stop.
		for errors.Unwrap(cause) != nil {
			cause = errors.Unwrap(cause)
		}
		if cause == capturesignaling.ErrMediaStopped {
			return a.finishSuccess(writer)
		}
		if cause == recordercapture.ErrDeadlineExpired ||
			(cause == context.Canceled && errors.Is(context.Cause(runCtx), recordercapture.ErrDeadlineExpired)) {
			return a.finishStopped(writer, a.authority.HardDeadline, recordingbundle.CloseReasonMaxDuration)
		}
		return a.finishFailure(err, writer)
	}

	if !a.authority.HardDeadline.IsZero() {
		deadline := a.config.After(a.authority.HardDeadline.Sub(a.config.Now().UTC()))
		deadlineDone := make(chan struct{})
		defer func() { cancel(nil); <-deadlineDone }()
		go func() {
			defer close(deadlineDone)
			select {
			case <-deadline:
				cancel(recordercapture.ErrDeadlineExpired)
			case <-runCtx.Done():
			}
		}()
	}
	plan, err := a.initialPlan(runCtx)
	if err != nil {
		return finish(err, nil)
	}
	planEvents := make(chan capturePlanEvent, 1)
	var planDone chan struct{}
	defer func() {
		cancel(nil)
		if planDone != nil {
			<-planDone
		}
	}()
	startPlanLoop := func(revision captureplane.PlanRevision) {
		planDone = make(chan struct{})
		go func() {
			defer close(planDone)
			defer func() {
				if recover() != nil {
					sendCapturePlanEvent(runCtx, planEvents, capturePlanEvent{err: capturePanicError()})
				}
			}()
			a.planLoop(runCtx, planEvents, revision)
		}()
	}
	var snapshot recordercapture.Snapshot
	emptyBootstrap := len(plan.Tracks()) == 0
	if emptyBootstrap {
		// An empty bootstrap performs no provider I/O. Keep its origin before
		// polling can advance no-RTP checkpoints.
		snapshot, err = a.coordinator.Bootstrap(runCtx, plan)
	} else {
		startPlanLoop(plan.Revision())
		snapshot, plan, err = a.bootstrapWhileWatchingPlans(runCtx, plan, planEvents)
	}
	if err != nil {
		return finish(err, nil)
	}
	writer := newCaptureBundleWriter(a)
	if plan.StopState() != captureplan.StopStateRunning {
		return a.finishSuccess(writer)
	}
	readers := make(map[string]CaptureMediaTrack)
	if len(snapshot.Tracks) == 0 {
		readyAt := a.config.Now().UTC()
		if err := a.emitReadyAt(runCtx, true, readyAt); err != nil {
			return finish(err, writer)
		}
		writer.setOrigin(readyAt)
	}
	if emptyBootstrap {
		startPlanLoop(plan.Revision())
	}
	late := newLateTrackWatch(runCtx, a)
	defer late.stop()
	if len(snapshot.Tracks) > 0 {
		var stopped bool
		readers, plan, stopped, err = a.bindTracksWhileWatchingPlans(runCtx, writer, plan, snapshot, planEvents, nil, nil, late)
		if err != nil {
			return finish(err, writer)
		}
		if stopped {
			cancel(nil)
			return a.finishSuccess(writer)
		}
	}
	if len(readers) == 0 && len(snapshot.Tracks) > 0 {
		readyAt := a.config.Now().UTC()
		if err := a.emitReadyAt(runCtx, true, readyAt); err != nil {
			return finish(err, writer)
		}
		writer.setOrigin(readyAt)
	}
	if err := writer.reconcileTracks(runCtx, plan, readers, a.config.Now()); err != nil {
		return a.finishFailure(err, writer)
	}

	events := make(chan captureRuntimeEvent, 256)
	firstPacketAt := bindAnchors(writer, readers, nil)
	writer.startAt(firstPacketAt)
	readerCancels, readerCancel, startErr := startCaptureReaders(runCtx, a.peer, readers, a.config.RTPReadDeadline, a.config.KeyFrameInterval, events, firstPacketAt)
	if startErr != nil {
		return finish(startErr, writer)
	}
	defer readerCancel()

	// A late track's first packet is already queued, so it attaches before the
	// loop takes any other event.
	attachLate := func(result lateTrackResult) error {
		bound, boundAt, err := late.handle(result)
		if err != nil || bound == nil {
			return err
		}
		next := make(map[string]CaptureMediaTrack, len(readers)+1)
		for mid, track := range readers {
			next[mid] = track
		}
		mid := string(bound.MID())
		next[mid] = bound
		if err := a.applyBoundTracks(runCtx, writer, plan, next, readers, readerCancels, events, map[string]time.Time{mid: writer.clampAnchor(boundAt)}); err != nil {
			return err
		}
		readers = next
		return nil
	}
	for {
		select {
		case result := <-late.results:
			if err := attachLate(result); err != nil {
				cancel(nil)
				return finish(err, writer)
			}
			continue
		default:
		}
		select {
		case <-runCtx.Done():
			return finish(runCtx.Err(), writer)
		case event := <-events:
			if !captureRuntimeEventMatchesReaders(event, readers) {
				continue
			}
			if event.err != nil {
				if gapErr := writer.addTerminalGap(a.config.Now()); gapErr != nil {
					event.err = errors.Join(event.err, gapErr)
				}
				cancel(nil)
				return finish(event.err, writer)
			}
			if err := a.consumeQueuedPackets(runCtx, writer, event, events, func(next captureRuntimeEvent) bool { return captureRuntimeEventMatchesReaders(next, readers) }); err != nil {
				cancel(nil)
				return finish(err, writer)
			}
		case result := <-late.results:
			if err := attachLate(result); err != nil {
				cancel(nil)
				return finish(err, writer)
			}
		case event := <-planEvents:
			if event.checkpointNoRTP {
				if err := writer.checkpointNoRTP(runCtx, event.at); err != nil {
					cancel(nil)
					return finish(err, writer)
				}
				pending, err := a.coordinator.Snapshot()
				if err != nil {
					return finish(err, writer)
				}
				if !pending.PendingTracks {
					continue
				}
				event.plan = plan
			}
			if event.err != nil {
				if errors.Is(event.err, captureplan.ErrNoChange) || errors.Is(event.err, ErrNoChange) || errors.Is(event.err, captureplan.ErrWaitTimeout) {
					continue
				}
				cancel(nil)
				return finish(event.err, writer)
			}
			snapshot, err := a.coordinator.Reconcile(runCtx, event.plan)
			if err != nil {
				cancel(nil)
				return finish(err, writer)
			}
			if event.plan.StopState() != captureplan.StopStateRunning {
				cancel(nil)
				return a.finishSuccess(writer)
			}
			updatedReaders, appliedPlan, stopped, err := a.bindTracksWhileWatchingPlans(runCtx, writer, event.plan, snapshot, planEvents, events, readers, late)
			if err != nil {
				cancel(nil)
				return finish(err, writer)
			}
			if stopped {
				cancel(nil)
				return a.finishSuccess(writer)
			}
			if err := a.applyBoundTracks(runCtx, writer, appliedPlan, updatedReaders, readers, readerCancels, events, bindAnchors(writer, updatedReaders, readers)); err != nil {
				cancel(nil)
				return finish(err, writer)
			}
			readers = updatedReaders
			plan = appliedPlan
		}
	}
}
