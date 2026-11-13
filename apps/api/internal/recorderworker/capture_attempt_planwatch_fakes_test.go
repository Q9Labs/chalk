package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type capturePlanWatchClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *capturePlanWatchClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *capturePlanWatchClock) Set(now time.Time) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
}

type capturePlanWatchStep func(context.Context) (captureplan.Plan, error)

type capturePlanWatchSource struct {
	mu      sync.Mutex
	steps   []capturePlanWatchStep
	calls   int
	current captureplan.Plan
}

func (s *capturePlanWatchSource) WaitForPlan(ctx context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
	s.mu.Lock()
	if input.AfterRevision == 0 && input.MaxWait == captureplan.MinimumWait {
		plan := s.current
		s.mu.Unlock()
		return plan, nil
	}
	index := s.calls
	s.calls++
	var step capturePlanWatchStep
	if index < len(s.steps) {
		step = s.steps[index]
	}
	s.mu.Unlock()
	if step != nil {
		plan, err := step(ctx)
		if err == nil {
			s.mu.Lock()
			s.current = plan
			s.mu.Unlock()
		}
		return plan, err
	}
	<-ctx.Done()
	return captureplan.Plan{}, ctx.Err()
}

type capturePlanWatchCoordinator struct {
	mu          sync.Mutex
	snapshots   map[captureplane.PlanRevision]recordercapture.Snapshot
	current     recordercapture.Snapshot
	reconciled  []captureplane.PlanRevision
	closeCalls  int
	checkpoints int
}

func newCapturePlanWatchCoordinator(snapshots map[captureplane.PlanRevision]recordercapture.Snapshot) *capturePlanWatchCoordinator {
	return &capturePlanWatchCoordinator{snapshots: snapshots}
}

func (c *capturePlanWatchCoordinator) Bootstrap(_ context.Context, plan captureplan.Plan) (recordercapture.Snapshot, error) {
	return c.accept(plan, false)
}

func (c *capturePlanWatchCoordinator) Reconcile(_ context.Context, plan captureplan.Plan) (recordercapture.Snapshot, error) {
	return c.accept(plan, true)
}

func (c *capturePlanWatchCoordinator) accept(plan captureplan.Plan, reconcile bool) (recordercapture.Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	snapshot, ok := c.snapshots[plan.Revision()]
	if !ok {
		return recordercapture.Snapshot{}, fmt.Errorf("missing snapshot for revision %d", plan.Revision())
	}
	snapshot.Tracks = append([]captureplane.PulledCaptureTrack(nil), snapshot.Tracks...)
	c.current = snapshot
	if reconcile {
		c.reconciled = append(c.reconciled, plan.Revision())
	}
	return snapshot, nil
}

func (c *capturePlanWatchCoordinator) Snapshot() (recordercapture.Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.checkpoints++
	snapshot := c.current
	snapshot.Tracks = append([]captureplane.PulledCaptureTrack(nil), snapshot.Tracks...)
	return snapshot, nil
}

func (c *capturePlanWatchCoordinator) Close(context.Context, bool) error {
	c.mu.Lock()
	c.closeCalls++
	c.mu.Unlock()
	return nil
}

func (*capturePlanWatchCoordinator) RenewLease(capturesignaling.WorkerLease) error { return nil }

// Checkpoints counts the plan checkpoints the capture loop has processed.
func (c *capturePlanWatchCoordinator) Checkpoints() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.checkpoints
}

func (c *capturePlanWatchCoordinator) Reconciled() []captureplane.PlanRevision {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]captureplane.PlanRevision(nil), c.reconciled...)
}

type capturePlanWatchPeer struct {
	mu         sync.Mutex
	wait       func(context.Context, captureplane.ProviderReference) (CaptureMediaTrack, error)
	waits      []captureplane.ProviderReference
	tracks     []*capturePlanWatchTrack
	closeCalls int
	closeOnce  sync.Once
}

func (*capturePlanWatchPeer) RegisterTracks([]captureplane.PulledCaptureTrack) error { return nil }

func (*capturePlanWatchPeer) CreateLocalOffer(context.Context, ...captureplane.ProviderReference) (captureplane.Negotiation, error) {
	return captureplane.Negotiation{}, nil
}

func (*capturePlanWatchPeer) AnswerRemoteOffer(context.Context, captureplane.Negotiation) (captureplane.Description, error) {
	return captureplane.Description{}, nil
}

func (*capturePlanWatchPeer) ApplyRemoteAnswer(context.Context, captureplane.Negotiation) error {
	return nil
}

func (*capturePlanWatchPeer) Epoch() captureplane.CaptureEpoch { return 2 }

func (p *capturePlanWatchPeer) WaitForTrack(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
	p.mu.Lock()
	p.waits = append(p.waits, mid)
	wait := p.wait
	p.mu.Unlock()
	if wait == nil {
		return nil, errors.New("capture plan watch peer has no track wait")
	}
	return wait(ctx, mid)
}

func (*capturePlanWatchPeer) RequestKeyFrame(captureplane.ProviderReference) error { return nil }

func (*capturePlanWatchPeer) Error() error { return nil }

func (p *capturePlanWatchPeer) Close() error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closeCalls++
		tracks := append([]*capturePlanWatchTrack(nil), p.tracks...)
		p.mu.Unlock()
		for _, track := range tracks {
			track.stop()
		}
	})
	return nil
}

func (p *capturePlanWatchPeer) CloseCalls() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.closeCalls
}

func (p *capturePlanWatchPeer) Waits() []captureplane.ProviderReference {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]captureplane.ProviderReference(nil), p.waits...)
}

type capturePlanWatchTrack struct {
	capture     captureplane.PulledCaptureTrack
	readStarted chan struct{}
	readStopped chan struct{}
	release     chan struct{}
	packets     chan *rtp.Packet
	readOnce    sync.Once
	stopOnce    sync.Once
}

func newCapturePlanWatchTrack(capture captureplane.PulledCaptureTrack) *capturePlanWatchTrack {
	return &capturePlanWatchTrack{capture: capture, readStarted: make(chan struct{}), readStopped: make(chan struct{}), release: make(chan struct{})}
}

func (t *capturePlanWatchTrack) CaptureTrack() captureplane.PulledCaptureTrack { return t.capture }

func (t *capturePlanWatchTrack) MID() captureplane.ProviderReference { return t.capture.MID }

func (*capturePlanWatchTrack) Codec() string { return "opus" }

func (*capturePlanWatchTrack) RID() string { return "" }

func (t *capturePlanWatchTrack) ReadRTP() (*rtp.Packet, interceptor.Attributes, error) {
	t.readOnce.Do(func() { close(t.readStarted) })
	select {
	case <-t.release:
		close(t.readStopped)
		return nil, nil, errors.New("capture plan watch track closed")
	case packet := <-t.packets:
		return packet, nil, nil
	case <-time.After(5 * time.Millisecond):
		return nil, nil, captureTimeoutError{}
	}
}

func (*capturePlanWatchTrack) SetReadDeadline(time.Time) error { return nil }

func (t *capturePlanWatchTrack) stop() { t.stopOnce.Do(func() { close(t.release) }) }

func capturePlanWatchPulledTrack(t *testing.T, mid, suffix string) captureplane.PulledCaptureTrack {
	t.Helper()
	return captureplane.PulledCaptureTrack{
		CaptureTrack: captureplane.CaptureTrack{
			OwnerReference: "owner-" + captureplane.ProviderReference(suffix), TrackReference: "track-" + captureplane.ProviderReference(suffix),
			ParticipantID: captureTestID(t, "88888888-8888-4888-8888-888888888888"), ParticipantGeneration: 1,
			Source: captureplane.TrackSourceMicrophone, Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto,
		},
		MID: captureplane.ProviderReference(mid),
	}
}

func capturePlanWatchPlan(t *testing.T, authority captureplan.PlanAuthority, revision captureplane.PlanRevision, at time.Time, stop captureplan.StopState, tracks ...captureplane.PulledCaptureTrack) captureplan.Plan {
	t.Helper()
	participants := make([]captureplan.ParticipantSnapshot, 0, len(tracks))
	participantIDs := make(map[utilities.ID]struct{}, len(tracks))
	planTracks := make([]captureplan.TrackSnapshot, 0, len(tracks))
	for _, track := range tracks {
		if _, exists := participantIDs[track.ParticipantID]; !exists {
			participants = append(participants, captureplan.ParticipantSnapshot{ID: track.ParticipantID, Generation: track.ParticipantGeneration, DisplayName: "Participant", JoinOrdinal: int64(len(participants) + 1), Lifecycle: captureplan.ParticipantActive})
			participantIDs[track.ParticipantID] = struct{}{}
		}
		planTracks = append(planTracks, captureplan.TrackSnapshot{
			ParticipantID: track.ParticipantID, ParticipantGeneration: track.ParticipantGeneration,
			Source: track.Source, Kind: track.Kind, OwnerReference: track.OwnerReference, TrackReference: track.TrackReference,
			OwnerMID: "owner-mid-" + track.MID, PublicationReference: captureplan.PublicationReference("publication-" + track.MID), RequestedLayer: track.RequestedLayer,
		})
	}
	stopRequestedAt := time.Time{}
	if stop != captureplan.StopStateRunning {
		stopRequestedAt = at
	}
	plan, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: authority, Revision: revision, LayoutProfile: captureplan.LayoutProfileComposite720PV1,
		ParticipantLimit: captureplan.MaximumParticipants, InputBitrateBPS: captureplan.MaximumInputBitrateBPS,
		EffectiveDeadline: at.Add(time.Hour), StopState: stop, StopRequestedAt: stopRequestedAt,
		Participants: participants, Tracks: planTracks,
	})
	if err != nil {
		t.Fatalf("create capture plan watch revision %d: %v", revision, err)
	}
	return plan
}

func capturePlanWatchAttempt(t *testing.T, planAuthority captureplan.PlanAuthority, readyAt *time.Time, peer CapturePeer, coordinator captureCoordinator, plans recordercapture.PlanSource, storage *captureTestStorage, lifecycle CaptureLifecyclePort, now func() time.Time, initialWait, closeTimeout time.Duration) *PionCaptureAttempt {
	t.Helper()
	var ready *time.Time
	if readyAt != nil {
		value := readyAt.UTC()
		ready = &value
	}
	authority := recordercapture.AttemptAuthority{
		Envelope: recordingpipeline.RecorderJobEnvelope{BundleSchemaVersion: recordingpipeline.RecordingBundleSchema, KeyHandle: "key-handle"}, EnvelopeDigest: append([]byte(nil), planAuthority.EnvelopeDigest...),
		TenantID: planAuthority.TenantID, SpaceID: planAuthority.SpaceID, EpisodeID: planAuthority.EpisodeID, RecordingID: planAuthority.RecordingID, JobID: planAuthority.JobID,
		PlanHandle: planAuthority.PlanHandle, AttemptCount: planAuthority.AttemptCount, FencingGeneration: planAuthority.FencingGeneration,
		CaptureEpoch: planAuthority.CaptureEpoch, HardDeadline: now().Add(time.Hour), CaptureReadyAt: ready,
	}
	return &PionCaptureAttempt{
		authority: authority, lease: capturesignaling.WorkerLease{Owner: "worker", Token: "lease", ExpiresAt: now().Add(time.Hour)},
		peer: peer, coordinator: coordinator, plans: plans, keys: storage, objects: storage, bundles: storage, lifecycle: lifecycle,
		config: CaptureAttemptConfig{InitialPlanWait: initialWait, CloseTimeout: closeTimeout, Now: now}.normalized(), ready: ready != nil,
	}
}
