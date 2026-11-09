package media

import (
	"errors"
	"math"
	"runtime/metrics"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// fakeSteal is a host whose CPU spends percent of every second stolen.
type fakeSteal struct{ times cpuTimes }

func (f *fakeSteal) advance(percent uint64) {
	f.times.total += 100
	f.times.steal += percent
	f.times.idle += 100 - percent
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

// fakeSched is the runtime's cumulative scheduler latency histogram, with
// buckets up to 1, 5, 20, 50 and 100 ms and beyond.
type fakeSched struct{ counts [6]uint64 }

var fakeSchedBuckets = []float64{0, 0.001, 0.005, 0.02, 0.05, 0.1, math.Inf(1)}

// second adds one second of goroutine wakeups: prompt ones that waited up to
// 5 ms for a CPU, and late ones that waited up to 100 ms.
func (f *fakeSched) second(prompt, late uint64) {
	f.counts[1] += prompt
	f.counts[4] += late
}

func (f *fakeSched) read() *metrics.Float64Histogram {
	return &metrics.Float64Histogram{Counts: slices.Clone(f.counts[:]), Buckets: fakeSchedBuckets}
}

// A replay of an overload of a 1 vCPU staging node. Five classes held steady at
// 2-5% steal; then the host stole 12% for 20 s, 40% for 10 s and 25% for 10 s,
// and in the 40% stretch goroutines waited 100 ms for the CPU and peers stalled
// for up to 1.2 s. Steal stays under the node's 25% threshold over the window,
// so the scheduler latency alone has to close admission, and it reopens within
// seconds of the stall ending.
func TestAHostStallUnderTheStealThresholdClosesAdmissionAndReopensWithinSeconds(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) {
		cfg.Guard.MaxStealPercent, cfg.Guard.MaxSchedulerLatency = 25, 20*time.Millisecond
	})
	host, sched := &fakeSteal{}, &fakeSched{}
	node.guard.readSteal, node.guard.readSched = host.read, sched.read
	live := node.newTestSession(t, episodeScope("live", "alice"))
	run := func(seconds int, steal uint64, late uint64, check func(second int, health HostHealth)) {
		t.Helper()
		for second := range seconds {
			host.advance(steal)
			sched.second(20_000, late)
			node.guard.tick()
			check(second, node.guard.snapshot())
		}
	}
	open := func(phase string) func(int, HostHealth) {
		return func(second int, health HostHealth) {
			t.Helper()
			if health.AdmissionReason != "" {
				t.Fatalf("%s, second %d: health %+v, want admission open", phase, second, health)
			}
		}
	}

	run(100, 3, 0, open("steady five classes"))
	run(20, 12, 0, open("12% steal"))
	run(10, 4, 0, open("steal falls back"))
	run(10, 40, 1_000, func(second int, health HostHealth) {
		t.Helper()
		if second >= 3 && health.AdmissionReason != reasonSchedulerLatency {
			t.Fatalf("stall, second %d: health %+v, want admission closed for scheduler latency", second, health)
		}
	})
	if _, err := node.CreateSession("create-new", episodeScope("new", "bob")); !errors.Is(err, errAdmissionClosed) {
		t.Fatalf("new Episode during the stall: %v, want admission closed", err)
	}
	node.newTestSession(t, episodeScope("live", "carol"))
	if live.isClosed() {
		t.Fatal("the guard closed an existing session")
	}

	reopened := -1
	run(10, 25, 0, func(second int, health HostHealth) {
		t.Helper()
		if health.AdmissionReason == reasonCPUSteal {
			t.Fatalf("after the stall, second %d: health %+v, want steal under its threshold", second, health)
		}
		if health.AdmissionReason == "" && reopened < 0 {
			reopened = second
		}
		if health.AdmissionReason != "" && reopened >= 0 {
			t.Fatalf("after the stall, second %d: health %+v, want admission to stay open once reopened", second, health)
		}
	})
	if reopened < 0 {
		t.Fatalf("admission still closed %v after the stall ended", latencyWindow)
	}
	run(30, 2, 0, open("recovered"))
	node.newTestSession(t, episodeScope("new", "bob"))
}

// One class joining an idle node: its transports drain keyframes at their first
// estimate, so pacer queue delay reads 50-75 ms for 30 s, while the host is idle
// and goroutines get the CPU at once. That delay is the links', so admission
// stays open.
func TestAJoinsPacerQueueDelayDoesNotCloseAdmission(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.Guard.MaxSchedulerLatency = 20 * time.Millisecond })
	host, sched := &fakeSteal{}, &fakeSched{}
	node.guard.readSteal, node.guard.readSched = host.read, sched.read
	for second := range 40 {
		host.advance(2)
		sched.second(5_000, 0)
		if second < 30 {
			for range 84 {
				node.guard.delays.record(0)
			}
			for range 10 {
				node.guard.delays.record(45 * time.Millisecond)
			}
			for range 6 {
				node.guard.delays.record(70 * time.Millisecond)
			}
		}
		node.guard.tick()
		if health := node.guard.snapshot(); health.AdmissionReason != "" {
			t.Fatalf("second %d of a join: health %+v, want admission open", second, health)
		}
		if second == 29 && node.guard.snapshot().QueueDelayP95 <= 50*time.Millisecond {
			t.Fatalf("health %+v, want the join's queue delay still reported", node.guard.snapshot())
		}
	}
	node.newTestSession(t, episodeScope("new", "bob"))
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

// A joining Participant's real pacer at its first estimate, fed 120 kB of
// keyframes at once: the raise of the pace shrinks as the queue drains, so the
// burst's tail waits past 50 ms on any host. The node is idle, so admission stays
// open while readiness still reports the delay.
func TestAJoiningTransportsKeyframeBurstDoesNotCloseAdmission(t *testing.T) {
	node := newTestNode(t, nil)
	node.guard.readSteal = func() (cpuTimes, bool) { return cpuTimes{}, false }
	joining := node.newTestSession(t, episodeScope("live", "alice"))

	wire := &wireWriter{}
	video := &egressBinding{writer: wire, ssrc: 10, payloadType: 96, twccID: 3}
	var w packetWriter
	payload := make([]byte, 1100)
	const burst = 110 // inside the 128 kB queue, so nothing drops
	for seq := range uint16(burst) {
		joining.transport.send(&egressPacket{binding: video, class: classVideo, seq: seq, payload: payload}, &w)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(wire.sent()) < burst && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if sent := len(wire.sent()); sent != burst {
		t.Fatalf("the pacer sent %d of %d packets", sent, burst)
	}

	node.guard.tick()
	health := node.guard.snapshot()
	if health.QueueDelayP95 <= 50*time.Millisecond {
		t.Fatalf("health %+v, want the burst's tail to wait past 50 ms", health)
	}
	if health.AdmissionReason != "" {
		t.Fatalf("health %+v, want admission open after one transport's startup burst", health)
	}
	node.newTestSession(t, episodeScope("new", "bob"))
}
