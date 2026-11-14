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
