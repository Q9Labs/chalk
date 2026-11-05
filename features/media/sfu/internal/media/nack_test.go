package media

import (
	"slices"
	"testing"
	"time"
)

// recordingTracker is a tracker whose requests and keyframe fallbacks land on channels.
func recordingTracker() (*nackTracker, chan []uint16, chan struct{}) {
	sent := make(chan []uint16, 16)
	keyframes := make(chan struct{}, 16)
	tracker := &nackTracker{
		send:   func(seqs []uint16) { sent <- slices.Clone(seqs) },
		gaveUp: func() { keyframes <- struct{}{} },
	}
	return tracker, sent, keyframes
}

func nextRequest(t *testing.T, sent chan []uint16, within time.Duration) []uint16 {
	t.Helper()
	select {
	case seqs := <-sent:
		slices.Sort(seqs)
		return seqs
	case <-time.After(within):
		t.Fatalf("no NACK within %v", within)
		return nil
	}
}

func TestALostPacketIsRequestedUntilItsRepairArrives(t *testing.T) {
	tracker, sent, _ := recordingTracker()
	defer tracker.stop()
	base := uint64(1 << 16)
	tracker.observe(base, 0, monotonic())
	tracker.observe(base+1, base, monotonic())
	// base+2 and base+3 are lost.
	tracker.observe(base+4, base+1, monotonic())
	if got := nextRequest(t, sent, 50*time.Millisecond); !slices.Equal(got, []uint16{2, 3}) {
		t.Fatalf("first NACK %v, want [2 3]", got)
	}
	// The repair of base+2 arrives; only base+3 is asked for again.
	tracker.observe(base+2, base+4, monotonic())
	if got := nextRequest(t, sent, 200*time.Millisecond); !slices.Equal(got, []uint16{3}) {
		t.Fatalf("retry %v, want [3]", got)
	}
	nextRequest(t, sent, 200*time.Millisecond)
	// Three tries is the bound: no fourth request.
	select {
	case seqs := <-sent:
		t.Fatalf("a fourth request %v", seqs)
	case <-time.After(3 * nackRetry):
	}
	if requested := tracker.requested.Load(); requested != 4 {
		t.Fatalf("requested %d sequence numbers, want 4", requested)
	}
}

func TestAGapLongerThanTheTableAsksForAKeyframe(t *testing.T) {
	tracker, sent, keyframes := recordingTracker()
	defer tracker.stop()
	base := uint64(1 << 16)
	tracker.observe(base, 0, monotonic())
	tracker.observe(base+nackPending+2, base, monotonic())
	select {
	case <-keyframes:
	case <-time.After(time.Second):
		t.Fatal("no keyframe request for a long gap")
	}
	select {
	case seqs := <-sent:
		t.Fatalf("a long gap sent NACK %v", seqs)
	case <-time.After(20 * time.Millisecond):
	}
	if tracker.abandoned.Load() != 1 {
		t.Fatalf("abandoned %d, want 1", tracker.abandoned.Load())
	}
}

// A run of new gaps must not keep postponing the request for an older one.
func TestSteadyLossDoesNotStarveRequests(t *testing.T) {
	tracker, sent, _ := recordingTracker()
	defer tracker.stop()
	base := uint64(1 << 16)
	tracker.observe(base, 0, monotonic())
	newest := base
	start := time.Now()
	deadline := start.Add(100 * time.Millisecond)
	for time.Now().Before(deadline) {
		tracker.observe(newest+2, newest, monotonic())
		newest += 2
		select {
		case seqs := <-sent:
			if elapsed := time.Since(start); elapsed > 30*time.Millisecond {
				t.Fatalf("first NACK %v after %v", seqs, elapsed)
			}
			return
		case <-time.After(time.Millisecond):
		}
	}
	t.Fatal("steady loss sent no NACK")
}

func TestTheMeterReportsTheLastSecond(t *testing.T) {
	var meter rateMeter
	now := int64(0)
	meter.sample(now)
	// 100 packets of 125 bytes every 100 ms: 1,000 packets/s and 1 Mbit/s.
	for range 2 * meterSlots {
		for range 100 {
			meter.add(125)
		}
		now += int64(allocationInterval)
		meter.sample(now)
	}
	pps, bps := meter.rates()
	if pps != 1000 || bps != 1_000_000 {
		t.Fatalf("rates %.0f pps %.0f bps, want 1000 and 1000000", pps, bps)
	}
	// A silent second drains the window to zero.
	for range meterSlots {
		now += int64(allocationInterval)
		meter.sample(now)
	}
	if pps, _ := meter.rates(); pps != 0 {
		t.Fatalf("rate after a silent second %.0f, want 0", pps)
	}
}
