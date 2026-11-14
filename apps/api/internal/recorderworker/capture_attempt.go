package recorderworker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

const (
	defaultCaptureInitialPlanWait  = 10 * time.Second
	defaultCapturePlanWait         = 2 * time.Second
	defaultCaptureLateTrackWait    = time.Minute
	defaultCaptureRTPDeadline      = 250 * time.Millisecond
	defaultCaptureCloseTimeout     = 15 * time.Second
	defaultCaptureLifecycleRetry   = 100 * time.Millisecond
	captureVideoReorderWindow      = uint64(16)
	captureKeyFrameRequestSpacing  = time.Second
	captureBundleContentType       = "application/vnd.chalk.recording-bundle"
	legacyCaptureBundleContentType = "application/vnd.chalk.recording-bundle+json"
)

var (
	ErrInvalidCaptureAttempt = errors.New("invalid recorder capture attempt")
	ErrCaptureEventQueueFull = errors.New("recorder capture event queue is full")
	ErrCapturePeerTerminal   = errors.New("recorder capture peer reached a terminal state")
	ErrCaptureStorage        = errors.New("recorder capture storage is unavailable")
)

// PionCaptureAttemptFactory creates a single peer and coordinator for each
// server-issued claim. CaptureEpoch is read from the envelope and is never
// incremented by this factory.
type PionCaptureAttemptFactory struct {
	signaling recordercapture.SignalingPort
	plans     recordercapture.PlanSource
	keys      CaptureKeyPort
	objects   CaptureObjectPort
	bundles   CaptureBundleSink
	lifecycle CaptureLifecyclePort
	peer      func(pion.Config) (CapturePeer, error)
	coord     recordercapture.Config
	config    CaptureAttemptConfig
}

// PionCaptureAttemptFactoryConfig contains the runtime edges. The production
// peer factory is provided when NewPeer is nil; all storage and lifecycle
// edges remain explicit ports until their authority routes are wired.
type PionCaptureAttemptFactoryConfig struct {
	Signaling   recordercapture.SignalingPort
	Plans       recordercapture.PlanSource
	Keys        CaptureKeyPort
	Objects     CaptureObjectPort
	Bundles     CaptureBundleSink
	Lifecycle   CaptureLifecyclePort
	NewPeer     func(pion.Config) (CapturePeer, error)
	Coordinator recordercapture.Config
	Attempt     CaptureAttemptConfig
}

func NewPionCaptureAttemptFactory(config PionCaptureAttemptFactoryConfig) (*PionCaptureAttemptFactory, error) {
	if config.Signaling == nil || config.Plans == nil || config.Keys == nil || config.Objects == nil || config.Bundles == nil || config.Lifecycle == nil {
		return nil, ErrInvalidCaptureAttempt
	}
	if config.NewPeer == nil {
		config.NewPeer = func(peerConfig pion.Config) (CapturePeer, error) {
			peer, err := pion.NewPeer(peerConfig)
			if err != nil {
				return nil, err
			}
			return &capturePionPeer{Peer: peer}, nil
		}
	}
	return &PionCaptureAttemptFactory{
		signaling: config.Signaling,
		plans:     config.Plans,
		keys:      config.Keys,
		objects:   config.Objects,
		bundles:   config.Bundles,
		lifecycle: config.Lifecycle,
		peer:      config.NewPeer,
		coord:     config.Coordinator,
		config:    config.Attempt.normalized(),
	}, nil
}

func (f *PionCaptureAttemptFactory) NewCaptureAttempt(ctx context.Context, claim ClaimResult) (CaptureAttempt, error) {
	if f == nil || f.peer == nil || f.signaling == nil || f.plans == nil {
		return nil, ErrInvalidCaptureAttempt
	}
	authority, err := recordercapture.NewAttemptAuthority(claim.Envelope, claim.EnvelopeDigest, capturesignaling.WorkerLease{
		Owner: claim.LeaseOwner, Token: claim.LeaseToken, ExpiresAt: claim.LeaseExpiresAt,
	})
	if err != nil {
		return nil, fmt.Errorf("build recorder capture authority: %w", err)
	}
	peer, err := f.peer(pion.Config{CaptureEpoch: authority.CaptureEpoch})
	if err != nil {
		return nil, fmt.Errorf("create capture peer for epoch %d: %w", authority.CaptureEpoch, err)
	}
	if peer == nil || peer.Epoch() != authority.CaptureEpoch {
		if peer != nil {
			_ = peer.Close()
		}
		return nil, fmt.Errorf("%w: peer epoch does not match server epoch", ErrInvalidCaptureAttempt)
	}
	coordinator, err := recordercapture.NewCoordinator(authority, f.signaling, peer, f.coord)
	if err != nil {
		_ = peer.Close()
		return nil, fmt.Errorf("create capture coordinator: %w", err)
	}
	attempt := &PionCaptureAttempt{
		authority:   authority,
		lease:       authority.Lease,
		peer:        peer,
		coordinator: coordinator,
		plans:       f.plans,
		keys:        f.keys,
		objects:     f.objects,
		bundles:     f.bundles,
		lifecycle:   f.lifecycle,
		config:      f.config,
		ready:       authority.CaptureReadyAt != nil,
	}
	return attempt, nil
}

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

func (a *PionCaptureAttempt) RenewLease(lease capturesignaling.WorkerLease) error {
	if a == nil || a.coordinator == nil {
		return ErrInvalidCaptureAttempt
	}
	if err := a.coordinator.RenewLease(lease); err != nil {
		return err
	}
	a.mu.Lock()
	a.lease = lease
	a.mu.Unlock()
	return nil
}

func (a *PionCaptureAttempt) Close(ctx context.Context) error {
	if a == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	closeCtx, cancel := context.WithTimeout(ctx, a.config.CloseTimeout)
	defer cancel()
	return a.closeLocal(closeCtx, nil, recordingbundle.CloseReasonExplicit)
}

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

// bindTracks binds every expected MID that sends its first RTP packet before ctx
// ends. A MID that stays silent is returned in missing instead of failing the
// attempt, so one dead microphone cannot cost the Recording of everyone else.
// With nothing bound at all the attempt still fails: the pull itself is broken.
func (a *PionCaptureAttempt) bindTracks(ctx context.Context, tracks []captureplane.PulledCaptureTrack) (map[string]CaptureMediaTrack, []captureplane.PulledCaptureTrack, error) {
	ordered := append([]captureplane.PulledCaptureTrack(nil), tracks...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].MID < ordered[j].MID })
	bound := make(map[string]CaptureMediaTrack, len(ordered))
	var missing []captureplane.PulledCaptureTrack
	var firstMiss error
	for _, expected := range ordered {
		track, err := a.bindTrack(ctx, expected)
		switch {
		case err == nil:
			bound[string(expected.MID)] = track
		case errors.Is(err, errCaptureTrackSilent):
			missing = append(missing, expected)
			if firstMiss == nil {
				firstMiss = err
			}
		default:
			return nil, nil, err
		}
	}
	if len(bound) == 0 && firstMiss != nil {
		return nil, nil, firstMiss
	}
	return bound, missing, nil
}

// bindAnchors returns the first-packet time for each track that is new in next.
// Binding waits for every planned track before any reader starts, and each
// bound track queues its packets meanwhile, so a reader's first read comes
// after the track's first packet: by the rest of the bind for an early track,
// and by seconds when a planned track is silent. Stamping a track with the time
// the peer bound it keeps its place on the Recording's clock. Stamping the read
// instead would give every track one shared start, and an audio track bound
// hundreds of milliseconds before a camera would sound that much later than the
// picture it belongs to.
func bindAnchors(writer *captureBundleWriter, next, previous map[string]CaptureMediaTrack) map[string]time.Time {
	anchors := make(map[string]time.Time, len(next))
	for mid, track := range next {
		if before, ok := previous[mid]; ok && sameCaptureBinding(before, track) {
			continue
		}
		if bound, ok := track.(interface{ BoundAt() time.Time }); ok {
			anchors[mid] = writer.clampAnchor(bound.BoundAt())
		}
	}
	return anchors
}

// errCaptureTrackSilent marks a planned MID that sent no RTP before the wait ended.
var errCaptureTrackSilent = errors.New("capture track sent no RTP")

// bindTrack waits for one MID's first packet. It wraps errCaptureTrackSilent only
// when the wait itself ran out while the attempt is still live.
func (a *PionCaptureAttempt) bindTrack(ctx context.Context, expected captureplane.PulledCaptureTrack) (CaptureMediaTrack, error) {
	track, err := a.peer.WaitForTrack(ctx, expected.MID)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf("wait for capture MID %s: %w: %w", expected.MID, errCaptureTrackSilent, err)
		}
		return nil, fmt.Errorf("wait for capture MID %s: %w", expected.MID, err)
	}
	if track == nil || track.MID() != expected.MID {
		return nil, fmt.Errorf("%w: expected MID %s", ErrInvalidCaptureAttempt, expected.MID)
	}
	identity := track.CaptureTrack()
	if identity.MID != expected.MID || identity.TrackReference != expected.TrackReference || identity.OwnerReference != expected.OwnerReference {
		return nil, fmt.Errorf("%w: capture MID %s identity changed", ErrInvalidCaptureAttempt, expected.MID)
	}
	if err := validateCaptureCodec(expected.Kind, track.Codec()); err != nil {
		return nil, fmt.Errorf("capture MID %s: %w", expected.MID, err)
	}
	if expected.Kind == captureplane.TrackKindVideo {
		if err := a.peer.RequestKeyFrame(expected.MID); err != nil {
			return nil, fmt.Errorf("request keyframe for capture MID %s: %w", expected.MID, err)
		}
	}
	return track, nil
}

type captureTrackBindResult struct {
	tracks  map[string]CaptureMediaTrack
	missing []captureplane.PulledCaptureTrack
	err     error
}

func (a *PionCaptureAttempt) bindTracksWhileWatchingPlans(ctx context.Context, writer *captureBundleWriter, plan captureplan.Plan, snapshot recordercapture.Snapshot, planEvents <-chan capturePlanEvent, runtimeEvents <-chan captureRuntimeEvent, currentReaders map[string]CaptureMediaTrack, late *lateTrackWatch) (map[string]CaptureMediaTrack, captureplan.Plan, bool, error) {
	if err := writer.observePlan(plan); err != nil {
		return nil, captureplan.Plan{}, false, err
	}
bindPlan:
	for {
		bindCtx, cancelBind := context.WithTimeout(ctx, a.config.InitialPlanWait)
		result := make(chan captureTrackBindResult, 1)
		expected := late.bindable(snapshot.Tracks)
		go func() {
			var bound captureTrackBindResult
			defer func() {
				if recover() != nil {
					bound.err = capturePanicError()
				}
				result <- bound
			}()
			bound.tracks, bound.missing, bound.err = a.bindTracks(bindCtx, expected)
		}()

		for {
			select {
			case <-ctx.Done():
				cancelBind()
				<-result
				return nil, captureplan.Plan{}, false, ctx.Err()
			case bound := <-result:
				cancelBind()
				if err := ctx.Err(); err != nil {
					return nil, captureplan.Plan{}, false, err
				}
				if bound.err == nil {
					late.update(snapshot.Tracks, bound.missing)
				}
				return bound.tracks, plan, false, bound.err
			case event := <-runtimeEvents:
				if !captureRuntimeEventMatchesPlannedReaders(event, currentReaders, snapshot.Tracks) {
					continue
				}
				if event.err != nil {
					cancelBind()
					<-result
					if gapErr := writer.addTerminalGap(a.config.Now()); gapErr != nil {
						event.err = errors.Join(event.err, gapErr)
					}
					return nil, captureplan.Plan{}, false, event.err
				}
				if err := a.consumeQueuedPackets(ctx, writer, event, runtimeEvents, func(next captureRuntimeEvent) bool {
					return captureRuntimeEventMatchesPlannedReaders(next, currentReaders, snapshot.Tracks)
				}); err != nil {
					cancelBind()
					<-result
					return nil, captureplan.Plan{}, false, err
				}
			case event := <-planEvents:
				if event.checkpointNoRTP {
					if err := writer.checkpointNoRTP(ctx, event.at); err == nil {
						continue
					} else {
						cancelBind()
						<-result
						return nil, captureplan.Plan{}, false, err
					}
				}
				cancelBind()
				<-result
				if event.err != nil {
					return nil, captureplan.Plan{}, false, event.err
				}
				latest, err := a.coordinator.Reconcile(ctx, event.plan)
				if err != nil {
					return nil, captureplan.Plan{}, false, err
				}
				if err := writer.observePlan(event.plan); err != nil {
					return nil, captureplan.Plan{}, false, err
				}
				plan = event.plan
				snapshot = latest
				if plan.StopState() != captureplan.StopStateRunning {
					return nil, plan, true, nil
				}
				continue bindPlan
			}
		}
	}
}

func captureRuntimeEventMatchesReaders(event captureRuntimeEvent, readers map[string]CaptureMediaTrack) bool {
	current, ok := readers[event.mid]
	return ok && event.track != nil && sameCaptureBinding(current, event.track)
}

func captureRuntimeEventMatchesPlannedReaders(event captureRuntimeEvent, readers map[string]CaptureMediaTrack, expected []captureplane.PulledCaptureTrack) bool {
	if !captureRuntimeEventMatchesReaders(event, readers) {
		return false
	}
	for _, track := range expected {
		if track.MID.String() == event.mid && track == event.track.CaptureTrack() {
			return true
		}
	}
	return false
}

func (a *PionCaptureAttempt) applyBoundTracks(ctx context.Context, writer *captureBundleWriter, plan captureplan.Plan, next, previous map[string]CaptureMediaTrack, readerCancels map[string]func(), events chan<- captureRuntimeEvent, firstPacketAt map[string]time.Time) error {
	if err := writer.reconcileTracks(ctx, plan, next, a.config.Now()); err != nil {
		return err
	}
	for mid, previousTrack := range previous {
		nextTrack, ok := next[mid]
		if !ok || !sameCaptureBinding(previousTrack, nextTrack) {
			if cancel := readerCancels[mid]; cancel != nil {
				cancel()
			}
			delete(readerCancels, mid)
		}
	}
	for mid, track := range next {
		if previousTrack, ok := previous[mid]; ok && sameCaptureBinding(previousTrack, track) {
			continue
		}
		cancel, err := startCaptureReader(ctx, a.peer, mid, track, a.config.RTPReadDeadline, a.config.KeyFrameInterval, events, firstPacketAt[mid])
		if err != nil {
			return err
		}
		readerCancels[mid] = cancel
	}
	return nil
}

// Read authority only after collecting the batch. Reusing an earlier "on"
// decision for packets that arrive later would store media after a mute.
func (a *PionCaptureAttempt) consumeQueuedPackets(ctx context.Context, writer *captureBundleWriter, first captureRuntimeEvent, events <-chan captureRuntimeEvent, matches func(captureRuntimeEvent) bool) error {
	batch := []captureRuntimeEvent{first}
	timer := time.NewTimer(20 * time.Millisecond)
	defer timer.Stop()
collect:
	for len(batch) < 256 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			break collect
		case event, ok := <-events:
			if !ok {
				break collect
			}
			if matches(event) {
				batch = append(batch, event)
			}
		}
	}
	plan, err := a.packetAuthority(ctx)
	if err != nil {
		return err
	}
	for _, event := range batch {
		if event.err != nil {
			return errors.Join(event.err, writer.addTerminalGap(a.config.Now()))
		}
		if err := a.consumeAuthorizedPacket(ctx, writer, event, plan); err != nil {
			return err
		}
	}
	return nil
}

func (a *PionCaptureAttempt) consumeAuthorizedPacket(ctx context.Context, writer *captureBundleWriter, event captureRuntimeEvent, plan captureplan.Plan) error {
	if (event.packet == nil && event.report == nil) || event.track == nil {
		return fmt.Errorf("%w: empty RTP event", ErrInvalidCaptureAttempt)
	}
	if !capturePacketAllowed(plan, event.track.CaptureTrack()) {
		return nil
	}
	if event.report != nil {
		writer.addSenderReport(event.track, event.report)
		return nil
	}
	if !a.ready {
		origin := writer.firstPacketOrigin(event.at)
		if err := a.emitReadyAt(ctx, false, origin); err != nil {
			return err
		}
		writer.setOrigin(origin)
	}
	return writer.addPacket(ctx, event.track, event.packet, event.at)
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

func (a *PionCaptureAttempt) emitReadyAt(ctx context.Context, noPublisher bool, readyAt time.Time) error {
	a.mu.Lock()
	if a.ready {
		a.mu.Unlock()
		return nil
	}
	key := captureLifecycleKey("ready", a.authority.RecordingID.String(), uint64(a.authority.CaptureEpoch))
	event := CaptureReadyEvent{
		TenantID: a.authority.TenantID.String(), SpaceID: a.authority.SpaceID.String(), EpisodeID: a.authority.EpisodeID.String(), RecordingID: a.authority.RecordingID.String(), JobID: a.authority.JobID.String(),
		CaptureEpoch: uint64(a.authority.CaptureEpoch), Attempt: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
		EnvelopeDigest: hex.EncodeToString(a.authority.EnvelopeDigest), LeaseOwner: a.lease.Owner, LeaseToken: a.lease.Token, LeaseExpiresAt: a.lease.ExpiresAt,
		At: readyAt.UTC(), IdempotencyKey: key, NoPublisher: noPublisher,
	}
	a.mu.Unlock()
	if err := a.lifecycle.Ready(ctx, event); err != nil {
		return fmt.Errorf("emit capture ready: %w", err)
	}
	a.mu.Lock()
	a.ready = true
	a.readyEvent = event
	a.mu.Unlock()
	return nil
}

func validateCaptureCodec(kind captureplane.TrackKind, codec string) error {
	codec = strings.ToLower(strings.TrimSpace(codec))
	if kind == captureplane.TrackKindAudio && codec == "opus" {
		return nil
	}
	if kind == captureplane.TrackKindVideo && (codec == "vp8" || codec == "h264") {
		return nil
	}
	return fmt.Errorf("%w: unsupported %s codec %q", ErrInvalidCaptureAttempt, kind, codec)
}

func sameCaptureBinding(left, right CaptureMediaTrack) bool {
	if left == nil || right == nil || left.Codec() != right.Codec() || left.RID() != right.RID() {
		return false
	}
	return left.CaptureTrack() == right.CaptureTrack()
}

func (a *PionCaptureAttempt) finishSuccess(writer *captureBundleWriter) error {
	// A planned stop is terminal for this capture epoch. Active publishers may
	// still have tracks when an Episode ends, and the provider contract requires
	// force for that close. Cleanup uses the same value so a retry preserves the
	// durable signaling command fingerprint.
	stoppedAt := a.config.Now().UTC()
	reason := recordingbundle.CloseReasonFinalStop
	if !a.authority.HardDeadline.IsZero() && !stoppedAt.Before(a.authority.HardDeadline) {
		stoppedAt = a.authority.HardDeadline
		reason = recordingbundle.CloseReasonMaxDuration
	}
	return a.finishStopped(writer, stoppedAt, reason)
}

func (a *PionCaptureAttempt) finishStopped(writer *captureBundleWriter, stoppedAt time.Time, reason recordingbundle.CloseReason) error {
	closeCtx, cancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	result := a.closeLocal(closeCtx, writer, reason)
	cancel()
	if result != nil {
		return result
	}
	callbackCtx, callbackCancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	defer callbackCancel()
	startedAt := time.Now()
	attempts := 0
	failure := func(outcome string, cause error) error {
		detail := completionFailureDetail(completionStageError{stage: "capture_stopped", outcome: outcome, cause: cause})
		return fmt.Errorf("%s callback_attempts=%d callback_elapsed_ms=%d: %w", detail, attempts, time.Since(startedAt).Milliseconds(), cause)
	}
	stopID := captureLifecycleKey("stopped", a.authority.RecordingID.String(), uint64(a.authority.CaptureEpoch))
	for {
		lease := a.currentLease()
		stop := CaptureStoppedEvent{
			TenantID: a.authority.TenantID.String(), SpaceID: a.authority.SpaceID.String(), EpisodeID: a.authority.EpisodeID.String(), RecordingID: a.authority.RecordingID.String(), JobID: a.authority.JobID.String(),
			CaptureEpoch: uint64(a.authority.CaptureEpoch), Attempt: a.authority.AttemptCount, FencingGeneration: a.authority.FencingGeneration,
			EnvelopeDigest: hex.EncodeToString(a.authority.EnvelopeDigest), LeaseOwner: lease.Owner, LeaseToken: lease.Token, LeaseExpiresAt: lease.ExpiresAt,
			At: stoppedAt, IdempotencyKey: stopID,
		}
		attempts++
		err := a.lifecycle.Stopped(callbackCtx, stop)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrControlPlaneRetryable) {
			if callbackCtx.Err() != nil {
				return failure("timed_out", errors.Join(err, callbackCtx.Err()))
			}
			return failure("returned", err)
		}
		timer := time.NewTimer(defaultCaptureLifecycleRetry)
		select {
		case <-timer.C:
		case <-callbackCtx.Done():
			timer.Stop()
			return failure("timed_out", errors.Join(err, callbackCtx.Err()))
		}
	}
}

func (a *PionCaptureAttempt) finishFailure(cause error, writer *captureBundleWriter) error {
	closeCtx, cancel := context.WithTimeout(context.Background(), a.config.CloseTimeout)
	closeErr := a.closeLocal(closeCtx, writer, recordingbundle.CloseReasonExplicit)
	cancel()
	return errors.Join(cause, closeErr)
}

func (a *PionCaptureAttempt) closeLocal(ctx context.Context, writer *captureBundleWriter, reason recordingbundle.CloseReason) error {
	a.mu.Lock()
	if a.closing || a.closed {
		done := a.closeDone
		a.mu.Unlock()
		select {
		case <-done:
			a.mu.Lock()
			defer a.mu.Unlock()
			return a.closeErr
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	a.closing = true
	a.closeDone = make(chan struct{})
	a.mu.Unlock()

	var result error
	// Stop remote ingress before the bounded durable tail. A storage timeout must
	// fail the attempt, but it must not consume the provider shutdown budget first.
	result = a.coordinator.Close(ctx, true)
	result = errors.Join(result, a.peer.Close())
	if writer != nil {
		endedAt := a.config.Now().UTC()
		if !a.authority.HardDeadline.IsZero() && (reason == recordingbundle.CloseReasonMaxDuration || endedAt.After(a.authority.HardDeadline)) {
			endedAt = a.authority.HardDeadline
		}
		result = errors.Join(result, writer.closeWithContext(ctx, reason, endedAt))
		writer.clearTerminalState()
	}
	result = errors.Join(result, ctx.Err())
	a.mu.Lock()
	a.closeErr = result
	a.closing = false
	a.closed = true
	close(a.closeDone)
	a.mu.Unlock()
	return result
}

func captureLifecycleKey(kind, recording string, epoch uint64) string {
	raw := fmt.Sprintf("capture_%s_%s_%d", kind, recording, epoch)
	if len(raw) <= captureplane.MaxIdempotencyKeyBytes {
		return raw
	}
	digest := sha256.Sum256([]byte(raw))
	return fmt.Sprintf("capture_%s_%s", kind, hex.EncodeToString(digest[:]))
}

func (a *PionCaptureAttempt) currentLease() capturesignaling.WorkerLease {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lease
}
