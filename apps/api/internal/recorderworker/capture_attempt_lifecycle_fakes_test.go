package recorderworker

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type captureTestLifecycle struct {
	ready   []CaptureReadyEvent
	stopped []CaptureStoppedEvent
	order   *[]string
}

type captureStoppedSequenceLifecycle struct {
	mu           sync.Mutex
	failures     []error
	repeat       error
	stopped      []CaptureStoppedEvent
	firstCall    chan struct{}
	releaseFirst chan struct{}
}

func (*captureStoppedSequenceLifecycle) Ready(context.Context, CaptureReadyEvent) error {
	return nil
}

func (l *captureStoppedSequenceLifecycle) Stopped(ctx context.Context, event CaptureStoppedEvent) error {
	l.mu.Lock()
	l.stopped = append(l.stopped, event)
	call := len(l.stopped)
	var err error
	if call <= len(l.failures) {
		err = l.failures[call-1]
	} else {
		err = l.repeat
	}
	firstCall := l.firstCall
	releaseFirst := l.releaseFirst
	l.mu.Unlock()
	if call == 1 && firstCall != nil {
		close(firstCall)
		select {
		case <-releaseFirst:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return err
}

func (l *captureStoppedSequenceLifecycle) events() []CaptureStoppedEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]CaptureStoppedEvent(nil), l.stopped...)
}

func (l *captureTestLifecycle) Ready(_ context.Context, event CaptureReadyEvent) error {
	l.ready = append(l.ready, event)
	return nil
}

func (l *captureTestLifecycle) Stopped(_ context.Context, event CaptureStoppedEvent) error {
	l.stopped = append(l.stopped, event)
	if l.order != nil {
		*l.order = append(*l.order, "stopped")
	}
	return nil
}

type captureTestStorage struct {
	mu            sync.Mutex
	key           []byte
	accessed      chan struct{}
	accessOnce    sync.Once
	accesses      int
	reserves      uint64
	uploads       int
	finalizes     int
	commits       int
	manifests     []recordingbundle.Manifest
	bundles       []recordingbundle.Bundle
	upload        CaptureObjectUpload
	uploadHistory []CaptureObjectUpload
	finalize      func(context.Context, CaptureBundleFinalize) (CaptureBundleUpload, error)
}

func (s *captureTestStorage) AccessKey(context.Context, CaptureKeyRequest) (CaptureDataKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accesses++
	if s.accessed != nil {
		s.accessOnce.Do(func() { close(s.accessed) })
	}
	return CaptureDataKey{Plaintext: append([]byte(nil), s.key...), EncryptionContextDigest: bytesOf(0xcd)}, nil
}

func (s *captureTestStorage) Reserve(context.Context, BundleReserveRequest) (BundleReservation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sequence := s.reserves
	s.reserves++
	return BundleReservation{ReservationID: "allocation-id", Sequence: sequence, AllocationVersion: 1, ObjectKey: "recording/bundle/1"}, nil
}

func (s *captureTestStorage) Finalize(ctx context.Context, input CaptureBundleFinalize) (CaptureBundleUpload, error) {
	if s.finalize != nil {
		return s.finalize(ctx, input)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.finalizes++
	return CaptureBundleUpload{Reservation: input.Reservation, UploadToken: "upload-token"}, nil
}

func (s *captureTestStorage) Upload(_ context.Context, input CaptureObjectUpload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.uploads++
	s.upload = CaptureObjectUpload{Upload: input.Upload, Body: append([]byte(nil), input.Body...), ContentType: input.ContentType, Checksum: input.Checksum}
	s.uploadHistory = append(s.uploadHistory, s.upload)
	return nil
}

func (s *captureTestStorage) Commit(_ context.Context, input CaptureBundleCommit) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.commits++
	s.manifests = append(s.manifests, input.Bundle.Manifest)
	bundle := input.Bundle
	bundle.Fragments = nil
	bundle.TrackTimeline = append([]recordingbundle.TrackTimelineEvent(nil), bundle.TrackTimeline...)
	bundle.LayoutTimeline = append([]recordingbundle.LayoutTimelineEvent(nil), bundle.LayoutTimeline...)
	bundle.Gaps = append([]recordingbundle.Gap(nil), bundle.Gaps...)
	s.bundles = append(s.bundles, bundle)
	return nil
}

func captureTestID(t testing.TB, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test ID: %v", err)
	}
	return id
}

func captureStoppedTestAttempt(t *testing.T, now time.Time, lifecycle CaptureLifecyclePort, closeTimeout time.Duration) *PionCaptureAttempt {
	t.Helper()
	authority := captureTestPlanAtEpoch(t, 2, 1, now).Authority()
	plan, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: authority, Revision: 1, LayoutProfile: captureplan.LayoutProfileComposite720PV1,
		ParticipantLimit: captureplan.MaximumParticipants, InputBitrateBPS: captureplan.MaximumInputBitrateBPS,
		EffectiveDeadline: now.Add(time.Hour), StopState: captureplan.StopStateRequested, StopRequestedAt: now,
	})
	if err != nil {
		t.Fatalf("create stopped callback plan: %v", err)
	}
	return capturePlanWatchAttempt(t, authority, nil, &captureTestPeer{epoch: 2}, &captureTestCoordinator{}, &captureTestPlanSource{plan: plan}, &captureTestStorage{key: bytesOf(0x42)}, lifecycle, func() time.Time { return now }, 0, closeTimeout)
}

func captureTestPlan(t *testing.T, revision captureplane.PlanRevision, now time.Time) captureplan.Plan {
	return captureTestPlanAtEpoch(t, 2, revision, now)
}

func captureTestPlanAtEpoch(t *testing.T, epoch captureplane.CaptureEpoch, revision captureplane.PlanRevision, now time.Time) captureplan.Plan {
	t.Helper()
	plan, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: captureplan.PlanAuthority{
			PlanHandle: "11111111-1111-4111-8111-111111111111", TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: captureTestID(t, "33333333-3333-4333-8333-333333333333"),
			EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"),
			AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: epoch, EnvelopeDigest: bytesOf(0x42),
		},
		Revision: revision, LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: captureplan.MaximumParticipants,
		InputBitrateBPS: captureplan.MaximumInputBitrateBPS, EffectiveDeadline: now.Add(time.Hour), StopState: captureplan.StopStateRunning,
	})
	if err != nil {
		t.Fatalf("new capture test plan: %v", err)
	}
	return plan
}

func newCaptureTestWriter(t *testing.T, origin time.Time) (*captureBundleWriter, *captureTestStorage) {
	t.Helper()
	storage := &captureTestStorage{key: bytesOf(0x41)}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{
			TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: captureTestID(t, "33333333-3333-4333-8333-333333333333"),
			EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"),
			CaptureEpoch: 2, AttemptCount: 2, FencingGeneration: 2, Envelope: recordingpipeline.RecorderJobEnvelope{BundleSchemaVersion: recordingpipeline.RecordingBundleSchema, KeyHandle: "key-handle"}, EnvelopeDigest: bytesOf(0x42), CaptureReadyAt: &origin,
		},
		lease: capturesignaling.WorkerLease{Owner: "worker", Token: "lease", ExpiresAt: time.Now().Add(time.Minute)},
		keys:  storage, objects: storage, bundles: storage,
		config: CaptureAttemptConfig{Now: func() time.Time {
			return origin
		}}.normalized(),
	}
	return newCaptureBundleWriter(attempt), storage
}

func activateCaptureTestTrack(writer *captureBundleWriter, track *captureTestTrack, origin time.Time, epoch uint64) {
	writer.setOrigin(origin)
	mid := track.MID().String()
	identity := track.CaptureTrack()
	writer.bindings[mid] = identity
	writer.active[mid] = recordingbundle.TrackIdentity{TrackID: identity.TrackReference.String(), Epoch: epoch, MID: mid, Codec: track.Codec(), Layer: identity.RequestedLayer.String()}
}

var _ CapturePeer = (*captureTestPeer)(nil)

var _ CaptureMediaTrack = (*captureTestTrack)(nil)

var _ CaptureKeyPort = (*captureTestStorage)(nil)

var _ CaptureObjectPort = (*captureTestStorage)(nil)

var _ CaptureBundleSink = (*captureTestStorage)(nil)
