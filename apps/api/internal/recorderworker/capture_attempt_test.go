package recorderworker

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/adapters/pion"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingobjects"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCaptureTrackClocksShareRecordingOriginWithoutLateTrackCollapse(t *testing.T) {
	audio := new(captureTrackClock)
	video := new(captureTrackClock)
	audioFirst := &rtp.Packet{Header: rtp.Header{Timestamp: 4_000}}
	videoFirst := &rtp.Packet{Header: rtp.Header{Timestamp: 90_000}}

	if media, timestamp := audio.normalize(audioFirst, captureplane.TrackKindAudio, 0); media != 0 || timestamp != 0 {
		t.Fatalf("first audio clock = media %d timestamp %d, want zero", media, timestamp)
	}
	if media, timestamp := video.normalize(videoFirst, captureplane.TrackKindVideo, 500); media != 500 || timestamp != 45_000 {
		t.Fatalf("late video clock = media %d timestamp %d, want recording offset 500/45000", media, timestamp)
	}
	audioNext := &rtp.Packet{Header: rtp.Header{Timestamp: audioFirst.Timestamp + 48_000}}
	if media, timestamp := audio.normalize(audioNext, captureplane.TrackKindAudio, 1_000); media != 1_000 || timestamp != 48_000 {
		t.Fatalf("continued audio clock = media %d timestamp %d, want 1000/48000", media, timestamp)
	}
}

func TestCaptureCodecAllowlistMatchesRecorderEnvelope(t *testing.T) {
	for _, valid := range []struct {
		kind  captureplane.TrackKind
		codec string
	}{{captureplane.TrackKindAudio, "opus"}, {captureplane.TrackKindVideo, "vp8"}, {captureplane.TrackKindVideo, "h264"}} {
		if err := validateCaptureCodec(valid.kind, valid.codec); err != nil {
			t.Fatalf("valid codec %s/%s: %v", valid.kind, valid.codec, err)
		}
	}
	if err := validateCaptureCodec(captureplane.TrackKindVideo, "av1"); !errors.Is(err, ErrInvalidCaptureAttempt) {
		t.Fatalf("unsupported codec error = %v", err)
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
		Envelope: recordingpipeline.RecorderJobEnvelope{BundleSchemaVersion: recordingpipeline.RecordingBundleSchema, KeyHandle: "key"}, EnvelopeDigest: digest,
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
	coordinator := &captureTestCoordinator{order: &order}
	attempt := &PionCaptureAttempt{authority: authority, lease: capturesignaling.WorkerLease{Token: "lease"}, peer: peer, coordinator: coordinator, plans: &captureTestPlanSource{plan: plan}, keys: &captureTestStorage{key: make([]byte, 32)}, objects: &captureTestStorage{}, bundles: &captureTestStorage{}, lifecycle: lifecycle, config: CaptureAttemptConfig{Now: func() time.Time { return now }}.normalized()}
	if err := attempt.Run(context.Background()); err != nil {
		t.Fatalf("run stop attempt: %v", err)
	}
	if got, want := strings.Join(order, ","), "provider,peer,stopped"; got != want {
		t.Fatalf("close order = %q, want %q", got, want)
	}
	if len(coordinator.forces) != 1 || !coordinator.forces[0] {
		t.Fatalf("planned stop close forces = %v, want [true]", coordinator.forces)
	}
}

func TestCaptureAttemptStoppedCallbackRetriesOnlyRetryableFailures(t *testing.T) {
	t.Run("refreshes lease and preserves idempotency facts", func(t *testing.T) {
		now := time.UnixMilli(1000).UTC()
		lifecycle := &captureStoppedSequenceLifecycle{failures: []error{HTTPError{Status: http.StatusServiceUnavailable, Retryable: true}}, firstCall: make(chan struct{}), releaseFirst: make(chan struct{})}
		attempt := captureStoppedTestAttempt(t, now, lifecycle, 2*time.Second)
		done := make(chan error, 1)
		go func() { done <- attempt.Run(context.Background()) }()

		select {
		case <-lifecycle.firstCall:
		case <-time.After(time.Second):
			t.Fatal("first stopped callback did not arrive")
		}
		renewed := attempt.currentLease()
		renewed.ExpiresAt = renewed.ExpiresAt.Add(time.Minute)
		if err := attempt.RenewLease(renewed); err != nil {
			t.Fatalf("renew callback authority: %v", err)
		}
		close(lifecycle.releaseFirst)
		if err := <-done; err != nil {
			t.Fatalf("run stopped retry: %v", err)
		}

		events := lifecycle.events()
		if len(events) != 2 {
			t.Fatalf("stopped callback count = %d, want 2", len(events))
		}
		if events[0].At != events[1].At || events[0].IdempotencyKey != events[1].IdempotencyKey {
			t.Fatalf("retry changed idempotency facts: first=%+v retry=%+v", events[0], events[1])
		}
		if events[0].LeaseExpiresAt.Equal(events[1].LeaseExpiresAt) || !events[1].LeaseExpiresAt.Equal(renewed.ExpiresAt) {
			t.Fatalf("retry lease expiry = %s, want refreshed %s after %s", events[1].LeaseExpiresAt, renewed.ExpiresAt, events[0].LeaseExpiresAt)
		}
	})

	t.Run("returns fenced failure without retry", func(t *testing.T) {
		lifecycle := &captureStoppedSequenceLifecycle{failures: []error{HTTPError{Status: http.StatusConflict, Fenced: true}}}
		err := captureStoppedTestAttempt(t, time.UnixMilli(1000).UTC(), lifecycle, time.Second).Run(context.Background())
		if !errors.Is(err, ErrControlPlaneFenced) {
			t.Fatalf("stopped callback error = %v, want fenced", err)
		}
		if calls := len(lifecycle.events()); calls != 1 {
			t.Fatalf("fenced callback count = %d, want 1", calls)
		}
	})

	t.Run("bounds retry by close timeout", func(t *testing.T) {
		lifecycle := &captureStoppedSequenceLifecycle{repeat: HTTPError{Status: http.StatusServiceUnavailable, Retryable: true}}
		err := captureStoppedTestAttempt(t, time.UnixMilli(1000).UTC(), lifecycle, 150*time.Millisecond).Run(context.Background())
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("stopped callback error = %v, want deadline exceeded", err)
		}
		if calls := len(lifecycle.events()); calls < 1 || calls > 3 {
			t.Fatalf("bounded callback count = %d, want 1..3", calls)
		}
	})
}

func TestCaptureAttemptMissingRunningTrackTimesOut(t *testing.T) {
	now := time.Unix(2_000, 0).UTC()
	expected := capturePlanWatchPulledTrack(t, "0", "timeout")
	authority := captureTestPlanAtEpoch(t, 1, 1, now).Authority()
	running := capturePlanWatchPlan(t, authority, 1, now, captureplan.StopStateRunning, expected)
	bindCanceled := make(chan struct{})
	peer := &capturePlanWatchPeer{wait: func(ctx context.Context, _ captureplane.ProviderReference) (CaptureMediaTrack, error) {
		<-ctx.Done()
		close(bindCanceled)
		return nil, ctx.Err()
	}}
	coordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{
		1: {PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{expected}},
	})
	plans := &capturePlanWatchSource{steps: []capturePlanWatchStep{
		func(context.Context) (captureplan.Plan, error) { return running, nil },
	}}
	storage := &captureTestStorage{key: bytesOf(0x41)}
	lifecycle := &captureTestLifecycle{}
	attempt := capturePlanWatchAttempt(t, authority, nil, peer, coordinator, plans, storage, lifecycle, func() time.Time { return now }, 20*time.Millisecond, 100*time.Millisecond)

	runCtx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := attempt.Run(runCtx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("missing running track error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed >= 250*time.Millisecond {
		t.Fatalf("missing running track was not bounded by InitialPlanWait: %s", elapsed)
	}
	select {
	case <-bindCanceled:
	default:
		t.Fatal("timed-out track bind was not joined")
	}
	if peer.CloseCalls() != 1 || len(lifecycle.stopped) != 0 {
		t.Fatalf("peer closes/stopped callbacks = %d/%d, want 1/0", peer.CloseCalls(), len(lifecycle.stopped))
	}
}

func TestCaptureAttemptClosesProviderBeforeBlockedWriter(t *testing.T) {
	origin := time.Unix(6_000, 0).UTC()
	stopAt := origin.Add(time.Second)
	authority := captureTestPlanAtEpoch(t, 2, 1, stopAt).Authority()
	stopped := capturePlanWatchPlan(t, authority, 1, stopAt, captureplan.StopStateRequested)
	order := make([]string, 0, 4)
	peer := &captureTestPeer{epoch: 2, order: &order}
	coordinator := &captureTestCoordinator{order: &order}
	plans := &captureTestPlanSource{plan: stopped}
	storage := &captureTestStorage{key: bytesOf(0x41)}
	storage.finalize = func(ctx context.Context, _ CaptureBundleFinalize) (CaptureBundleUpload, error) {
		order = append(order, "writer")
		<-ctx.Done()
		return CaptureBundleUpload{}, ctx.Err()
	}
	lifecycle := &captureTestLifecycle{order: &order}
	attempt := capturePlanWatchAttempt(t, authority, &origin, peer, coordinator, plans, storage, lifecycle, func() time.Time { return stopAt }, 20*time.Millisecond, 20*time.Millisecond)
	started := time.Now()
	err := attempt.Run(context.Background())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked durable writer error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed >= time.Second {
		t.Fatalf("blocked durable writer close exceeded bound: %s", elapsed)
	}
	if got, want := strings.Join(order, ","), "provider,peer,writer"; got != want {
		t.Fatalf("blocked writer close order = %q, want %q", got, want)
	}
	if len(lifecycle.stopped) != 0 {
		t.Fatalf("stopped emitted despite failed durable flush: %+v", lifecycle.stopped)
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

func newCaptureFinalizeReplayStorage(t *testing.T, now time.Time) *captureFinalizeReplayStorage {
	t.Helper()
	repository := new(captureFinalizeReplayRepository)
	store := &captureFinalizeReplayStore{now: now}
	service, err := recordingobjects.NewService(objectstorage.NewService(store), repository, recordingobjects.Config{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatalf("new recording object service: %v", err)
	}
	return &captureFinalizeReplayStorage{
		service: service, repository: repository,
		firstUploadStarted: make(chan struct{}), firstCommitStarted: make(chan struct{}), blockFirstUpload: true,
	}
}
