package recorderworker

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
	"github.com/q9labs/chalk/apps/api/internal/recordingbundle"
)

func TestCaptureAttemptConsumesRetainedTrackWhileDynamicBindBlocks(t *testing.T) {
	origin := time.Now().UTC().Add(-time.Second)
	start := origin.Add(time.Second)
	stopAt := origin.Add(2 * time.Second)
	clock := &capturePlanWatchClock{now: start}
	retained := capturePlanWatchPulledTrack(t, "0", "retained")
	missing := capturePlanWatchPulledTrack(t, "1", "missing")
	missing.ParticipantID = captureTestID(t, "99999999-9999-4999-8999-999999999999")
	authority := captureTestPlanAtEpoch(t, 2, 1, start).Authority()
	initial := capturePlanWatchPlan(t, authority, 1, start, captureplan.StopStateRunning, retained)
	updated := capturePlanWatchPlan(t, authority, 2, start.Add(500*time.Millisecond), captureplan.StopStateRunning, retained, missing)
	stopped := capturePlanWatchPlan(t, authority, 3, stopAt, captureplan.StopStateRequested)
	retainedTrack := newCapturePlanWatchTrack(retained)
	retainedTrack.packets = make(chan *rtp.Packet, 1)
	dynamicStarted := make(chan struct{})
	dynamicCanceled := make(chan struct{})
	peer := &capturePlanWatchPeer{tracks: []*capturePlanWatchTrack{retainedTrack}, wait: func(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
		switch mid {
		case retained.MID:
			return retainedTrack, nil
		case missing.MID:
			close(dynamicStarted)
			<-ctx.Done()
			close(dynamicCanceled)
			return nil, ctx.Err()
		default:
			return nil, fmt.Errorf("unexpected MID %s", mid)
		}
	}}
	coordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{
		1: {PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{retained}},
		2: {PlanRevision: 2, Tracks: []captureplane.PulledCaptureTrack{retained, missing}},
		3: {PlanRevision: 3},
	})
	key := bytesOf(0x41)
	storage := &captureTestStorage{key: key, accessed: make(chan struct{})}
	packet := &rtp.Packet{Header: rtp.Header{SequenceNumber: 17, Timestamp: 48_000, SSRC: 7, PayloadType: 111}, Payload: []byte{0x55}}
	plans := &capturePlanWatchSource{steps: []capturePlanWatchStep{
		func(context.Context) (captureplan.Plan, error) { return initial, nil },
		func(ctx context.Context) (captureplan.Plan, error) {
			select {
			case <-retainedTrack.readStarted:
				return updated, nil
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
		},
		func(ctx context.Context) (captureplan.Plan, error) {
			select {
			case <-dynamicStarted:
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
			select {
			case retainedTrack.packets <- packet:
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
			select {
			case <-storage.accessed:
				clock.Set(stopAt)
				return stopped, nil
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
		},
	}}
	lifecycle := &captureTestLifecycle{}
	attempt := capturePlanWatchAttempt(t, authority, &origin, peer, coordinator, plans, storage, lifecycle, clock.Now, 200*time.Millisecond, 200*time.Millisecond)

	runCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := attempt.Run(runCtx); err != nil {
		t.Fatalf("run stop while retained track publishes during dynamic bind: %v", err)
	}
	select {
	case <-dynamicCanceled:
	default:
		t.Fatal("dynamic bind was not canceled and joined")
	}
	storage.mu.Lock()
	uploads := append([]CaptureObjectUpload(nil), storage.uploadHistory...)
	storage.mu.Unlock()
	packets := 0
	for uploadIndex, upload := range uploads {
		bundle, err := recordingbundle.Decrypt(key, upload.Body)
		if err != nil {
			t.Fatalf("decrypt retained-track bundle %d: %v", uploadIndex, err)
		}
		for _, fragment := range bundle.Fragments {
			if fragment.Track.TrackID != retained.TrackReference.String() {
				t.Fatalf("unexpected retained-track fragment: %+v", fragment)
			}
			for _, persisted := range fragment.Packets {
				packets++
				if persisted.SequenceNumber != packet.SequenceNumber || !slices.Equal(persisted.Payload, packet.Payload) {
					t.Fatalf("persisted retained packet = %+v, want sequence %d payload %v", persisted, packet.SequenceNumber, packet.Payload)
				}
			}
		}
		for _, gap := range bundle.Gaps {
			if !gap.Terminal {
				t.Fatalf("dynamic bind created a no-RTP checkpoint despite retained reader: %+v", bundle.Gaps)
			}
		}
	}
	if packets != 1 {
		t.Fatalf("persisted retained packet count = %d, want 1", packets)
	}
	if len(lifecycle.stopped) != 1 {
		t.Fatalf("stopped callbacks = %d, want 1", len(lifecycle.stopped))
	}
}

func TestCaptureAttemptNewerRunningPlanCancelsStaleTrackBind(t *testing.T) {
	origin := time.Unix(4_000, 0).UTC()
	start := origin.Add(time.Minute)
	clock := &capturePlanWatchClock{now: start}
	first := capturePlanWatchPulledTrack(t, "0", "first")
	stale := capturePlanWatchPulledTrack(t, "1", "stale")
	latest := capturePlanWatchPulledTrack(t, "2", "latest")
	authority := captureTestPlanAtEpoch(t, 2, 1, start).Authority()
	initial := capturePlanWatchPlan(t, authority, 1, start, captureplan.StopStateRunning, first)
	stalePlan := capturePlanWatchPlan(t, authority, 2, start.Add(time.Second), captureplan.StopStateRunning, stale)
	latestPlan := capturePlanWatchPlan(t, authority, 3, start.Add(2*time.Second), captureplan.StopStateRunning, latest)
	stopped := capturePlanWatchPlan(t, authority, 4, start.Add(3*time.Second), captureplan.StopStateRequested)
	firstTrack := newCapturePlanWatchTrack(first)
	latestTrack := newCapturePlanWatchTrack(latest)
	staleStarted := make(chan struct{})
	staleCanceled := make(chan struct{})
	peer := &capturePlanWatchPeer{tracks: []*capturePlanWatchTrack{firstTrack, latestTrack}, wait: func(ctx context.Context, mid captureplane.ProviderReference) (CaptureMediaTrack, error) {
		switch mid {
		case first.MID:
			return firstTrack, nil
		case stale.MID:
			close(staleStarted)
			<-ctx.Done()
			close(staleCanceled)
			return nil, ctx.Err()
		case latest.MID:
			return latestTrack, nil
		default:
			return nil, fmt.Errorf("unexpected MID %s", mid)
		}
	}}
	coordinator := newCapturePlanWatchCoordinator(map[captureplane.PlanRevision]recordercapture.Snapshot{
		1: {PlanRevision: 1, Tracks: []captureplane.PulledCaptureTrack{first}},
		2: {PlanRevision: 2, Tracks: []captureplane.PulledCaptureTrack{stale}},
		3: {PlanRevision: 3, Tracks: []captureplane.PulledCaptureTrack{latest}},
		4: {PlanRevision: 4},
	})
	plans := &capturePlanWatchSource{steps: []capturePlanWatchStep{
		func(context.Context) (captureplan.Plan, error) { return initial, nil },
		func(ctx context.Context) (captureplan.Plan, error) {
			select {
			case <-firstTrack.readStarted:
				return stalePlan, nil
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
		},
		func(ctx context.Context) (captureplan.Plan, error) {
			select {
			case <-staleStarted:
				clock.Set(start.Add(2 * time.Second))
				return latestPlan, nil
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
		},
		func(ctx context.Context) (captureplan.Plan, error) {
			select {
			case <-latestTrack.readStarted:
				clock.Set(start.Add(3 * time.Second))
				return stopped, nil
			case <-ctx.Done():
				return captureplan.Plan{}, ctx.Err()
			}
		},
	}}
	storage := &captureTestStorage{key: bytesOf(0x41)}
	lifecycle := &captureTestLifecycle{}
	attempt := capturePlanWatchAttempt(t, authority, &origin, peer, coordinator, plans, storage, lifecycle, clock.Now, 200*time.Millisecond, 200*time.Millisecond)

	runCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := attempt.Run(runCtx); err != nil {
		t.Fatalf("run capture across superseded dynamic bind: %v", err)
	}
	select {
	case <-staleCanceled:
	default:
		t.Fatal("stale running-plan bind was not canceled and joined")
	}
	if got := coordinator.Reconciled(); !slices.Equal(got, []captureplane.PlanRevision{2, 3, 4}) {
		t.Fatalf("reconciled revisions = %v, want [2 3 4]", got)
	}
	storage.mu.Lock()
	bundles := append([]recordingbundle.Bundle(nil), storage.bundles...)
	storage.mu.Unlock()
	foundLatest := false
	for _, bundle := range bundles {
		for _, layout := range bundle.LayoutTimeline {
			if layout.Revision == 2 {
				t.Fatalf("stale plan revision reached writer: %+v", bundle.LayoutTimeline)
			}
			foundLatest = foundLatest || layout.Revision == 3
		}
	}
	if !foundLatest || len(lifecycle.stopped) != 1 {
		t.Fatalf("latest writer revision/stopped callback = %v/%d, bundles=%+v", foundLatest, len(lifecycle.stopped), bundles)
	}
}
