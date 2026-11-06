package media

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// fakeSteal is a host whose CPU spends percent of every second stolen.
type fakeSteal struct{ times cpuTimes }

func (f *fakeSteal) advance(percent uint64) {
	f.times.total += 100
	f.times.steal += percent
}

func (f *fakeSteal) read() (cpuTimes, bool) { return f.times, true }

func TestStealAboveThresholdRefusesNewEpisodesAndKeepsExistingOnes(t *testing.T) {
	node := newTestNode(t, nil)
	host := &fakeSteal{}
	node.guard.readSteal = host.read
	existing := node.newTestSession(t, episodeScope("live", "alice"))
	node.newTestSession(t, episodeScope("solo", "dave"))

	// 3% is allowed; a full 30-second window at 3% leaves admission open.
	for range 31 {
		host.advance(3)
		node.guard.tick()
	}
	if reason := node.guard.closedReason(); reason != "" {
		t.Fatalf("admission closed at 3%% steal: %s", reason)
	}
	// 5% over the next window closes it.
	for range 31 {
		host.advance(5)
		node.guard.tick()
	}
	health := node.guard.snapshot()
	if health.AdmissionReason != reasonCPUSteal || health.StealPercent < 4.9 || health.StealPercent > 5.1 {
		t.Fatalf("health %+v, want cpu_steal near 5%%", health)
	}
	_, err := node.CreateSession("create-new-episode", episodeScope("new", "bob"))
	if !errors.Is(err, errAdmissionClosed) || !strings.Contains(err.Error(), reasonCPUSteal) {
		t.Fatalf("new Episode under steal: %v, want admission closed for cpu_steal", err)
	}
	// A lone Participant replacing their own connection is not a new Episode.
	if _, err := node.CreateSession("create-replace-dave", episodeScope("solo", "dave")); err != nil {
		t.Fatalf("a lone Participant's reconnect under steal: %v, want admitted", err)
	}
	// The live Episode still admits its own Participants and its session stays up.
	node.newTestSession(t, episodeScope("live", "carol"))
	if existing.isClosed() {
		t.Fatal("the guard closed an existing session")
	}
	// Steal back under the threshold for a window reopens admission.
	for range 31 {
		host.advance(1)
		node.guard.tick()
	}
	if reason := node.guard.closedReason(); reason != "" {
		t.Fatalf("admission still closed after steal fell: %s", reason)
	}
	node.newTestSession(t, episodeScope("new", "bob"))
}

func TestOneBusySecondAtBootDoesNotCloseAdmission(t *testing.T) {
	node := newTestNode(t, nil)
	host := &fakeSteal{}
	node.guard.readSteal = host.read
	for range 5 {
		host.advance(50)
		node.guard.tick()
	}
	if reason := node.guard.closedReason(); reason != "" {
		t.Fatalf("admission closed before a full window: %s", reason)
	}
}

func TestQueueDelayP95AboveThresholdRefusesNewEpisodes(t *testing.T) {
	node := newTestNode(t, nil)
	node.guard.readSteal = func() (cpuTimes, bool) { return cpuTimes{}, false }
	node.newTestSession(t, episodeScope("live", "alice"))

	// 90% of packets leave at once and 10% wait 80 ms: p95 is 80 ms.
	for range 90 {
		node.guard.delays.record(0)
	}
	for range 10 {
		node.guard.delays.record(80 * time.Millisecond)
	}
	node.guard.tick()
	health := node.guard.snapshot()
	if health.AdmissionReason != reasonPacerQueueDelay || health.QueueDelayP95 < 50*time.Millisecond {
		t.Fatalf("health %+v, want pacer_queue_delay above 50 ms", health)
	}
	if _, err := node.CreateSession("create-new", episodeScope("new", "bob")); !errors.Is(err, errAdmissionClosed) {
		t.Fatalf("new Episode under queue delay: %v, want admission closed", err)
	}
	node.newTestSession(t, episodeScope("live", "carol"))

	// The slow second leaves the 30-second window and admission reopens.
	for range 30 {
		node.guard.delays.record(time.Millisecond)
		node.guard.tick()
	}
	if reason := node.guard.closedReason(); reason != "" {
		t.Fatalf("admission still closed: %s", reason)
	}
}

func TestReadProcStatParsesStealOnLinux(t *testing.T) {
	times, ok := readProcStat()
	if !ok {
		t.Skip("no /proc/stat on this host")
	}
	if times.total == 0 || times.steal > times.total {
		t.Fatalf("cpu times %+v", times)
	}
}

func TestSchedulerLatencyIsReadable(t *testing.T) {
	first := readSchedulerLatencies()
	time.Sleep(10 * time.Millisecond)
	second := readSchedulerLatencies()
	if first == nil || second == nil {
		t.Fatal("the runtime exports no scheduler latency histogram")
	}
	_ = histogramDeltaPercentile(*first, *second, 0.99)
}

// TestADelayedPacerClosesAdmissionAndTheLiveEpisodeContinues delays packets in
// a live session's own pacer, so the delay reaches the guard the way production
// traffic does: new Episodes are refused while the live Episode still admits.
func TestADelayedPacerClosesAdmissionAndTheLiveEpisodeContinues(t *testing.T) {
	node := newTestNode(t, nil)
	node.guard.readSteal = func() (cpuTimes, bool) { return cpuTimes{}, false }
	live := node.newTestSession(t, episodeScope("live", "alice"))

	wire := &wireWriter{}
	video := &egressBinding{writer: wire, ssrc: 10, payloadType: 96, twccID: 3}
	pacer := live.transport
	pacer.mu.Lock()
	pacer.refill(monotonic())
	pacer.tokens = -1e6 // the pace lets nothing out
	pacer.mu.Unlock()
	var w packetWriter
	payload := make([]byte, 500)
	for seq := range uint16(4) {
		pacer.send(&egressPacket{binding: video, class: classVideo, seq: seq, payload: payload}, &w)
	}
	time.Sleep(80 * time.Millisecond)
	pacer.mu.Lock()
	pacer.tokens = 0
	pacer.mu.Unlock()
	pacer.signal()
	deadline := time.Now().Add(2 * time.Second)
	for len(wire.sent()) < 4 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if sent := len(wire.sent()); sent != 4 {
		t.Fatalf("the pacer sent %d of 4 packets", sent)
	}

	node.guard.tick()
	if health := node.guard.snapshot(); health.AdmissionReason != reasonPacerQueueDelay {
		t.Fatalf("health %+v, want admission closed for pacer queue delay", health)
	}
	if _, err := node.CreateSession("create-new", episodeScope("new", "bob")); !errors.Is(err, errAdmissionClosed) {
		t.Fatalf("new Episode while the pacer lags: %v, want admission closed", err)
	}
	node.newTestSession(t, episodeScope("live", "carol"))
}
