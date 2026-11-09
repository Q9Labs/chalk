package recorderworker

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
)

func TestCaptureConcurrentRecordingIsolation(t *testing.T) {
	now := time.Now().UTC()
	claim := captureDaemonClaim(t, 7)
	var claims atomic.Int32
	attempts := make([]*PionCaptureAttempt, 2)
	tracks := make([]*capturePlanWatchTrack, 2)
	storages := make([]*isolatedCaptureStorage, 2)
	traces := make(chan trace.TraceID, 2)
	for i := range 2 {
		authority := captureTestPlanAtEpoch(t, 2, 1, now).Authority()
		authority.RecordingID = captureTestID(t, fmt.Sprintf("%08d-6666-4666-8666-666666666666", i+1))
		authority.JobID = captureTestID(t, fmt.Sprintf("%08d-7777-4777-8777-777777777777", i+1))
		track := newCapturePlanWatchTrack(capturePlanWatchPulledTrack(t, "0", fmt.Sprint(i)))
		track.packets = make(chan *rtp.Packet)
		tracks[i] = track
		peer := &capturePlanWatchPeer{tracks: []*capturePlanWatchTrack{track}, wait: func(context.Context, captureplane.ProviderReference) (CaptureMediaTrack, error) { return track, nil }}
		plan := capturePlanWatchPlan(t, authority, 1, now, captureplan.StopStateRunning, track.capture)
		coordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{1: {PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{track.capture}}})
		storage := &isolatedCaptureStorage{captureTestStorage: &captureTestStorage{key: bytesOf(byte(0x41 + i)), accessed: make(chan struct{})}}
		storages[i] = storage
		attempt := capturePlanWatchAttempt(t, authority, &now, peer, coordinator, &panicPlanSource{plan: plan}, storage.captureTestStorage, &captureTestLifecycle{}, time.Now, 100*time.Millisecond, 100*time.Millisecond)
		attempt.keys = storage
		attempt.bundles = storage
		attempts[i] = attempt
	}
	control := &multislotControl{claim: func(ctx context.Context, id utilities.ID, lease time.Duration) (ClaimResult, error) {
		n := claims.Add(1)
		if n > 2 {
			<-ctx.Done()
			return ClaimResult{}, ctx.Err()
		}
		c := claim
		c.ClaimRequestID = id
		c.Envelope.CaptureEpoch = int64(n)
		c.LeaseExpiresAt = time.Now().Add(lease)
		return c, nil
	}}
	daemon, err := NewCaptureDaemon(control, captureAttemptFactoryFunc(func(ctx context.Context, c ClaimResult) (CaptureAttempt, error) {
		traces <- trace.SpanContextFromContext(ctx).TraceID()
		return attempts[c.Envelope.CaptureEpoch-1], nil
	}), CaptureDaemonConfig{Slots: 2})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- daemon.Run(ctx) }()
	stopped := false
	defer func() {
		cancel()
		if !stopped {
			<-done
		}
	}()
	for i, track := range tracks {
		select {
		case <-track.readStarted:
		case <-time.After(time.Second):
			t.Fatal("reader did not start")
		}
		select {
		case track.packets <- &rtp.Packet{Header: rtp.Header{Version: 2, SSRC: 1, SequenceNumber: 1, Timestamp: 960}, Payload: []byte{byte(i + 1)}}:
		case <-time.After(time.Second):
			t.Fatal("reader did not consume")
		}
		select {
		case <-storages[i].accessed:
		case <-time.After(time.Second):
			t.Fatal("packet did not reach writer")
		}
	}
	first, second := <-traces, <-traces
	if !first.IsValid() || first == second {
		t.Fatalf("attempt trace IDs = %s/%s", first, second)
	}
	cancel()
	select {
	case <-done:
		stopped = true
	case <-time.After(time.Second):
		t.Fatal("daemon did not stop")
	}
	for i, storage := range storages {
		if storage.request.RecordingID != attempts[i].authority.RecordingID.String() || storage.request.JobID != attempts[i].authority.JobID.String() {
			t.Fatalf("key authority crossed recordings: %+v", storage.request)
		}
		for _, b := range storage.plaintext {
			if b != 0 {
				t.Fatal("plaintext key not cleared")
			}
		}
		if len(storage.uploadHistory) == 0 {
			t.Fatal("recording was not persisted")
		}
		packets := 0
		for _, upload := range storage.uploadHistory {
			if upload.Upload.Reservation.ObjectKey != attempts[i].authority.RecordingID.String()+"/bundle" {
				t.Fatal("object namespace crossed recordings")
			}
			bundle, err := recordingbundle.Decrypt(storage.key, upload.Body)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := recordingbundle.Decrypt(storages[1-i].key, upload.Body); err == nil {
				t.Fatal("another recording key decrypted the bundle")
			}
			for _, fragment := range bundle.Fragments {
				for _, packet := range fragment.Packets {
					packets++
					if len(packet.Payload) != 1 || packet.Payload[0] != byte(i+1) {
						t.Fatal("media crossed recordings")
					}
				}
			}
		}
		if packets != 1 {
			t.Fatalf("recording %d packets=%d", i, packets)
		}
	}
}

type isolatedCaptureStorage struct {
	*captureTestStorage
	request   CaptureKeyRequest
	plaintext []byte
}

func (s *isolatedCaptureStorage) AccessKey(ctx context.Context, input CaptureKeyRequest) (CaptureDataKey, error) {
	key, err := s.captureTestStorage.AccessKey(ctx, input)
	s.request = input
	s.plaintext = key.Plaintext
	return key, err
}
func (s *isolatedCaptureStorage) Reserve(ctx context.Context, input BundleReserveRequest) (BundleReservation, error) {
	reservation, err := s.captureTestStorage.Reserve(ctx, input)
	reservation.ObjectKey = input.RecordingID + "/bundle"
	return reservation, err
}
