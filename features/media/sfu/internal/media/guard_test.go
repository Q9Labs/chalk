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
