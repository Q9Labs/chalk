package recorderworker

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestRTPSequenceExtenderHandlesWrapAndLatePacket(t *testing.T) {
	var extender rtpSequenceExtender
	if got := extender.Extend(65534); got != 65534 {
		t.Fatalf("first sequence = %d", got)
	}
	if got := extender.Extend(65535); got != 65535 {
		t.Fatalf("pre-wrap sequence = %d", got)
	}
	if got := extender.Extend(0); got != 65536 {
		t.Fatalf("wrapped sequence = %d", got)
	}
	if got := extender.Extend(65535); got != 65535 {
		t.Fatalf("late pre-wrap sequence = %d", got)
	}
	if got := extender.Extend(1); got != 65537 {
		t.Fatalf("post-wrap sequence = %d", got)
	}
}

func TestCaptureReadyIsEmittedOnceWithExplicitNoPublisher(t *testing.T) {
	lifecycle := &captureTestLifecycle{}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), CaptureEpoch: 7, AttemptCount: 2, FencingGeneration: 3},
		lifecycle: lifecycle,
		config:    CaptureAttemptConfig{Now: func() time.Time { return time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC) }}.normalized(),
	}
	if err := attempt.emitReady(context.Background(), true); err != nil {
		t.Fatalf("emit ready: %v", err)
	}
	if err := attempt.emitReady(context.Background(), false); err != nil {
		t.Fatalf("replay ready: %v", err)
	}
	if len(lifecycle.ready) != 1 || !lifecycle.ready[0].NoPublisher || lifecycle.ready[0].CaptureEpoch != 7 || lifecycle.ready[0].Attempt != 2 {
		t.Fatalf("ready events = %#v", lifecycle.ready)
	}
}

func TestCaptureLifecycleKeyIsStableAcrossAttemptReplacement(t *testing.T) {
	const recordingID = "55555555-5555-4555-8555-555555555555"
	if got, want := captureLifecycleKey("ready", recordingID, 7), "capture_ready_55555555-5555-4555-8555-555555555555_7"; got != want {
		t.Fatalf("ready lifecycle key = %q, want %q", got, want)
	}
	if got, want := captureLifecycleKey("stopped", recordingID, 7), "capture_stopped_55555555-5555-4555-8555-555555555555_7"; got != want {
		t.Fatalf("stopped lifecycle key = %q, want %q", got, want)
	}
}

func TestCaptureReaderPropagatesTerminalPeerError(t *testing.T) {
	peer := &captureTestPeer{err: errors.New("peer failed")}
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{MID: "0"}, readErr: captureTimeoutError{}}
	events := make(chan captureRuntimeEvent, 1)
	cancel, err := startCaptureReader(context.Background(), peer, "0", track, time.Millisecond, events)
	if err != nil {
		t.Fatalf("start reader: %v", err)
	}
	defer cancel()
	select {
	case event := <-events:
		if !errors.Is(event.err, ErrCapturePeerTerminal) || !errors.Is(event.err, peer.err) {
			t.Fatalf("reader error = %v", event.err)
		}
	case <-time.After(time.Second):
		t.Fatal("reader did not report terminal peer error")
	}
}

func TestCaptureBundleWriterEncryptsAndCommitsOneObject(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	storage := &captureTestStorage{key: key}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{
			TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"), CaptureEpoch: 1, AttemptCount: 1, FencingGeneration: 1,
			Envelope:       recordingpipeline.RecorderJobEnvelope{KeyHandle: "key-handle"},
			EnvelopeDigest: bytesOf(0x42),
		},
		lease: capturesignaling.WorkerLease{Token: "lease"},
		keys:  storage, objects: storage, bundles: storage,
		config: CaptureAttemptConfig{Now: func() time.Time { return time.UnixMilli(1000).UTC() }}.normalized(),
	}
	writer := newCaptureBundleWriter(attempt)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	writer.setTrack(track)
	if err := writer.addPacket(context.Background(), track, &rtp.Packet{Header: rtp.Header{SequenceNumber: 10, Timestamp: 100}, Payload: []byte{1, 2, 3}}, time.UnixMilli(1001).UTC()); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, time.UnixMilli(1002).UTC()); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	if storage.accesses != 1 || storage.finalizes != 1 || storage.uploads != 1 || storage.commits != 1 {
		t.Fatalf("storage calls = accesses %d finalizes %d uploads %d commits %d", storage.accesses, storage.finalizes, storage.uploads, storage.commits)
	}
	if _, err := recordingbundle.Decrypt(key, storage.upload.Body); err != nil {
		t.Fatalf("decrypt committed object: %v", err)
	}
}

func TestCaptureBundleWriterCloseBoundsStoragePersistence(t *testing.T) {
	storage := &captureTestStorage{key: bytesOf(0x41)}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{
			TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"), CaptureEpoch: 1, AttemptCount: 1, FencingGeneration: 1,
			Envelope: recordingpipeline.RecorderJobEnvelope{KeyHandle: "key-handle"}, EnvelopeDigest: bytesOf(0x42),
		},
		lease: capturesignaling.WorkerLease{Owner: "worker", Token: "lease", ExpiresAt: time.Now().Add(time.Minute)},
		keys:  storage, objects: storage, bundles: storage,
		config: CaptureAttemptConfig{CloseTimeout: 10 * time.Millisecond, Now: func() time.Time { return time.UnixMilli(1000).UTC() }}.normalized(),
	}
	writer := newCaptureBundleWriter(attempt)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	writer.setTrack(track)
	if err := writer.addPacket(context.Background(), track, &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Timestamp: 100}, Payload: []byte{1}}, time.UnixMilli(1001).UTC()); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	storage.finalize = func(ctx context.Context, _ CaptureBundleFinalize) (CaptureBundleUpload, error) {
		<-ctx.Done()
		return CaptureBundleUpload{}, ctx.Err()
	}
	started := time.Now()
	err := writer.close(recordingbundle.CloseReasonFinalStop, time.UnixMilli(1002).UTC())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("bounded close took %s", elapsed)
	}
}

func TestCaptureBundleWriterPersistsTerminalGapAfterFinalBundle(t *testing.T) {
	key := make([]byte, 32)
	storage := &captureTestStorage{key: key}
	attempt := &PionCaptureAttempt{
		authority: recordercapture.AttemptAuthority{
			TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"), CaptureEpoch: 1, AttemptCount: 1, FencingGeneration: 1, EnvelopeDigest: bytesOf(0x42),
		},
		lease: capturesignaling.WorkerLease{Token: "lease"}, keys: storage, objects: storage, bundles: storage,
		config: CaptureAttemptConfig{Now: func() time.Time { return time.UnixMilli(1000).UTC() }}.normalized(),
	}
	writer := newCaptureBundleWriter(attempt)
	track := &captureTestTrack{capture: captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{TrackReference: "track", OwnerReference: "owner", Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto}, MID: "0"}, codec: "opus"}
	writer.setTrack(track)
	if err := writer.addPacket(context.Background(), track, &rtp.Packet{Header: rtp.Header{SequenceNumber: 10, Timestamp: 100}, Payload: []byte{1}}, time.UnixMilli(1001).UTC()); err != nil {
		t.Fatalf("add packet: %v", err)
	}
	if err := writer.addTerminalGap(time.UnixMilli(1002).UTC()); err != nil {
		t.Fatalf("add terminal gap: %v", err)
	}
	if err := writer.close(recordingbundle.CloseReasonFinalStop, time.UnixMilli(1002).UTC()); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	if storage.commits != 2 {
		t.Fatalf("commits = %d, want final bundle plus terminal gap bundle", storage.commits)
	}
}

func TestPionCaptureAttemptFactoryUsesServerEpochExactly(t *testing.T) {
	now := time.Now().UTC()
	tenant := captureTestID(t, "22222222-2222-4222-8222-222222222222")
	space := captureTestID(t, "33333333-3333-4333-8333-333333333333")
	episode := captureTestID(t, "44444444-4444-4444-8444-444444444444")
	recording := captureTestID(t, "55555555-5555-4555-8555-555555555555")
	jobID := captureTestID(t, "66666666-6666-4666-8666-666666666666")
	claimID := captureTestID(t, "77777777-7777-4777-8777-777777777777")
	job := recordingpipeline.Job{ID: jobID, TenantID: tenant, EpisodeID: episode, RecordingID: recording, Kind: recordingpipeline.JobKindCapture, AttemptCount: 1, AttemptLimit: 3, FencingGeneration: 4}
	authority, err := recordingpipeline.NewRecorderJobAuthority(job, recordingpipeline.ClaimFacts{SpaceID: space, PolicySnapshotVersion: recordingpipeline.SupportedPolicySnapshotVersion, HardDeadline: now.Add(time.Hour), CaptureEpoch: 19}, claimID, now)
	if err != nil {
		t.Fatalf("create claim authority: %v", err)
	}
	claim := ClaimResult{ClaimRequestID: claimID, Envelope: authority.Envelope, EnvelopeDigest: authority.EnvelopeDigest, LeaseOwner: "worker", LeaseToken: "lease", LeaseExpiresAt: now.Add(30 * time.Minute)}
	peerEpoch := captureplane.CaptureEpoch(0)
	peer := &captureTestPeer{epoch: 19}
	factory, err := NewPionCaptureAttemptFactory(PionCaptureAttemptFactoryConfig{
		Signaling: &captureTestSignaling{}, Plans: &captureTestPlans{}, Keys: &captureTestStorage{key: make([]byte, 32)}, Objects: &captureTestStorage{}, Bundles: &captureTestStorage{}, Lifecycle: &captureTestLifecycle{},
		NewPeer: func(config pion.Config) (CapturePeer, error) {
			peerEpoch = config.CaptureEpoch
			return peer, nil
		},
	})
	if err != nil {
		t.Fatalf("create attempt factory: %v", err)
	}
	attempt, err := factory.NewCaptureAttempt(context.Background(), claim)
	if err != nil {
		t.Fatalf("create capture attempt: %v", err)
	}
	if peerEpoch != 19 || attempt.(*PionCaptureAttempt).authority.CaptureEpoch != 19 {
		t.Fatalf("factory changed server epoch: peer=%d authority=%d", peerEpoch, attempt.(*PionCaptureAttempt).authority.CaptureEpoch)
	}
}

func TestCaptureAttemptStopClosesProviderBeforePeerAndStoppedCallback(t *testing.T) {
	now := time.UnixMilli(1000).UTC()
	digest := bytesOf(0x42)
	authority := recordercapture.AttemptAuthority{
		Envelope: recordingpipeline.RecorderJobEnvelope{KeyHandle: "key"}, EnvelopeDigest: digest,
		TenantID: captureTestID(t, "22222222-2222-4222-8222-222222222222"), SpaceID: captureTestID(t, "33333333-3333-4333-8333-333333333333"), EpisodeID: captureTestID(t, "44444444-4444-4444-8444-444444444444"), RecordingID: captureTestID(t, "55555555-5555-4555-8555-555555555555"), JobID: captureTestID(t, "66666666-6666-4666-8666-666666666666"),
		PlanHandle: "11111111-1111-4111-8111-111111111111", CaptureEpoch: 4, AttemptCount: 2, FencingGeneration: 3,
	}
	plan, err := captureplan.NewPlan(captureplan.PlanInput{Authority: captureplan.PlanAuthority{PlanHandle: "11111111-1111-4111-8111-111111111111", TenantID: authority.TenantID, SpaceID: authority.SpaceID, EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID, JobID: authority.JobID, AttemptCount: 2, FencingGeneration: 3, CaptureEpoch: 4, EnvelopeDigest: digest}, Revision: 1, LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: 10, InputBitrateBPS: 4_000_000, EffectiveDeadline: now.Add(time.Hour), StopState: captureplan.StopStateRequested, StopRequestedAt: now})
	if err != nil {
		t.Fatalf("create stop plan: %v", err)
	}
	order := make([]string, 0, 3)
	peer := &captureTestPeer{epoch: 4, order: &order}
	lifecycle := &captureTestLifecycle{order: &order}
	attempt := &PionCaptureAttempt{authority: authority, lease: capturesignaling.WorkerLease{Token: "lease"}, peer: peer, coordinator: &captureTestCoordinator{order: &order}, plans: &captureTestPlanSource{plan: plan}, keys: &captureTestStorage{key: make([]byte, 32)}, objects: &captureTestStorage{}, bundles: &captureTestStorage{}, lifecycle: lifecycle, config: CaptureAttemptConfig{Now: func() time.Time { return now }}.normalized()}
	if err := attempt.Run(context.Background()); err != nil {
		t.Fatalf("run stop attempt: %v", err)
	}
	if got, want := strings.Join(order, ","), "provider,peer,stopped"; got != want {
		t.Fatalf("close order = %q, want %q", got, want)
	}
}

func TestCaptureAttemptRenewsExactLeaseWithoutChangingEpoch(t *testing.T) {
	coordinator := &captureTestCoordinator{}
	attempt := &PionCaptureAttempt{coordinator: coordinator, lease: capturesignaling.WorkerLease{Owner: "worker", Token: "old", ExpiresAt: time.Now().Add(time.Minute)}, authority: recordercapture.AttemptAuthority{CaptureEpoch: 12}}
	renewed := capturesignaling.WorkerLease{Owner: "worker", Token: "new", ExpiresAt: time.Now().Add(2 * time.Minute)}
	if err := attempt.RenewLease(renewed); err != nil {
		t.Fatalf("renew lease: %v", err)
	}
	if got := attempt.currentLease(); got.Token != renewed.Token || got.ExpiresAt != renewed.ExpiresAt {
		t.Fatalf("lease = %#v, want %#v", got, renewed)
	}
	if attempt.authority.CaptureEpoch != 12 {
		t.Fatalf("lease renewal changed capture epoch to %d", attempt.authority.CaptureEpoch)
	}
}

type captureTimeoutError struct{}

func (captureTimeoutError) Error() string   { return "timeout" }
func (captureTimeoutError) Timeout() bool   { return true }
func (captureTimeoutError) Temporary() bool { return true }

type captureTestTrack struct {
	capture  captureplane.PulledCaptureTrack
	codec    string
	readErr  error
	deadline time.Time
}

func (t *captureTestTrack) CaptureTrack() captureplane.PulledCaptureTrack { return t.capture }
func (t *captureTestTrack) MID() captureplane.ProviderReference           { return t.capture.MID }
func (t *captureTestTrack) Codec() string                                 { return t.codec }
func (t *captureTestTrack) RID() string                                   { return "" }
func (t *captureTestTrack) ReadRTP() (*rtp.Packet, interceptor.Attributes, error) {
	return nil, nil, t.readErr
}
func (t *captureTestTrack) SetReadDeadline(deadline time.Time) error {
	t.deadline = deadline
	return nil
}

type captureTestPeer struct {
	err   error
	epoch captureplane.CaptureEpoch
	order *[]string
}

func (p *captureTestPeer) RegisterTracks([]captureplane.PulledCaptureTrack) error { return nil }
func (p *captureTestPeer) CreateLocalOffer(context.Context, ...captureplane.ProviderReference) (captureplane.Negotiation, error) {
	return captureplane.Negotiation{}, nil
}
func (p *captureTestPeer) AnswerRemoteOffer(context.Context, captureplane.Negotiation) (captureplane.Description, error) {
	return captureplane.Description{}, nil
}
func (p *captureTestPeer) ApplyRemoteAnswer(context.Context, captureplane.Negotiation) error {
	return nil
}
func (p *captureTestPeer) Epoch() captureplane.CaptureEpoch {
	if p.epoch == 0 {
		return 1
	}
	return p.epoch
}
func (p *captureTestPeer) WaitForTrack(context.Context, captureplane.ProviderReference) (CaptureMediaTrack, error) {
	return nil, errors.New("not implemented")
}
func (p *captureTestPeer) Error() error { return p.err }
func (p *captureTestPeer) Close() error {
	if p.order != nil {
		*p.order = append(*p.order, "peer")
	}
	return nil
}

type captureTestSignaling struct{}

func (*captureTestSignaling) Execute(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	return capturesignaling.Execution{}, errors.New("capture test signaling is not called")
}

type captureTestPlans struct{}

func (*captureTestPlans) WaitForPlan(context.Context, captureplan.WaitInput) (captureplan.Plan, error) {
	return captureplan.Plan{}, errors.New("capture test plan source is not called")
}

type captureTestPlanSource struct{ plan captureplan.Plan }

func (p *captureTestPlanSource) WaitForPlan(context.Context, captureplan.WaitInput) (captureplan.Plan, error) {
	return p.plan, nil
}

type captureTestCoordinator struct{ order *[]string }

func (c *captureTestCoordinator) Bootstrap(context.Context, captureplan.Plan) (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}
func (c *captureTestCoordinator) Reconcile(context.Context, captureplan.Plan) (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}
func (c *captureTestCoordinator) Snapshot() (recordercapture.Snapshot, error) {
	return recordercapture.Snapshot{PlanRevision: 1}, nil
}
func (c *captureTestCoordinator) Close(context.Context, bool) error {
	if c.order != nil {
		*c.order = append(*c.order, "provider")
	}
	return nil
}
func (c *captureTestCoordinator) RenewLease(capturesignaling.WorkerLease) error { return nil }

type captureTestLifecycle struct {
	ready   []CaptureReadyEvent
	stopped []CaptureStoppedEvent
	order   *[]string
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
	mu        sync.Mutex
	key       []byte
	accesses  int
	uploads   int
	finalizes int
	commits   int
	upload    CaptureObjectUpload
	finalize  func(context.Context, CaptureBundleFinalize) (CaptureBundleUpload, error)
}

func (s *captureTestStorage) AccessKey(context.Context, CaptureKeyRequest) (CaptureDataKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accesses++
	return CaptureDataKey{Plaintext: append([]byte(nil), s.key...), EncryptionContextDigest: bytesOf(0xcd)}, nil
}
func (s *captureTestStorage) Reserve(context.Context, BundleReserveRequest) (BundleReservation, error) {
	return BundleReservation{ReservationID: "allocation-id", Sequence: 0, AllocationVersion: 1, ObjectKey: "recording/bundle/1"}, nil
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
	return nil
}
func (s *captureTestStorage) Commit(context.Context, CaptureBundleCommit) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.commits++
	return nil
}

func captureTestID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse test ID: %v", err)
	}
	return id
}

var _ CapturePeer = (*captureTestPeer)(nil)
var _ CaptureMediaTrack = (*captureTestTrack)(nil)
var _ CaptureKeyPort = (*captureTestStorage)(nil)
var _ CaptureObjectPort = (*captureTestStorage)(nil)
var _ CaptureBundleSink = (*captureTestStorage)(nil)
