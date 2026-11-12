package media

import (
	"log/slog"
	"math"
	"runtime/metrics"
	"sync"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

const (
	// minGuardPacerDrops is the drops in a window below which the drop share is noise.
	minGuardPacerDrops = 100
	// latencyWindow is how far back the guard reads scheduler latency, whatever
	// the guard window is. It is short so admission reopens within seconds of a
	// host stall ending. The p99 pools every wakeup in it, so a stall closes
	// admission once its late wakeups pass 1% of the window's.
	latencyWindow = 10 * time.Second
	latencySlots  = int(latencyWindow / time.Second) // one-second samples in latencyWindow
)

// the last bucket holds everything slower

// HostHealth is the guard's latest view of the host, for readiness and telemetry.
type HostHealth struct {
	// AdmissionReason is why new Episodes are refused, or empty while they are admitted.
	AdmissionReason string
	StealPercent    float64
	StealKnown      bool
	// BusyPercent is the host CPU time spent working over the window, steal and idle excluded,
	// valid with StealKnown.
	BusyPercent   float64
	QueueDelayP95 time.Duration
	// SchedulerLatencyP99 is how long runnable goroutines waited for a CPU, over
	// latencyWindow. It reads the whole node, readers, pacers and the control
	// loop alike, so it is the guard's signal of a host too slow to keep up.
	SchedulerLatencyP99 time.Duration
	// PacerDrops is the video the pacers dropped over the window, and PacerDropPercent its share of
	// the video they dropped or sent.
	PacerDrops       uint64
	PacerDropPercent float64
	// UDPReceiveErrorsPerSecond and UDPSendErrorsPerSecond are the host's datagrams dropped for a
	// full socket buffer, averaged over the window. They read zero where the host reports none.
	UDPReceiveErrorsPerSecond, UDPSendErrorsPerSecond float64
}

// pacerLoad is the node's cumulative video the pacers dropped and sent, since start.
type pacerLoad struct{ dropped, sent uint64 }

// guard closes admission of new Episodes while the host cannot serve them on
// time: CPU steal or busy time, the share of video the pacers drop, or UDP
// socket buffer errors above their thresholds over the guard window, or Go
// scheduler latency p99 above its threshold over latencyWindow. Existing
// Episodes keep running.
type guard struct {
	cfg       config.Guard
	log       *slog.Logger
	readSteal stealReader
	readUDP   func() (udpErrors, bool)
	readSched func() *metrics.Float64Histogram
	delays    delayHistogram

	mu        sync.Mutex
	steal     []cpuTimes // one reading a second, oldest first, at most one window plus one
	udp       []udpErrors
	pacer     []pacerLoad
	latest    pacerLoad // the node's latest counts, handed over by observePacer
	delayRing [][queueDelayBuckets]uint64
	sched     []metrics.Float64Histogram
	health    HostHealth
}

func newGuard(cfg config.Guard, log *slog.Logger) *guard {
	return &guard{
		cfg: cfg, log: log, readSteal: readProcStat, readSched: readSchedulerLatencies,
		readUDP: func() (udpErrors, bool) { return readUDPErrors(udpStatsPath) },
	}
}

// observePacer hands the guard the node's cumulative pacer counts for its next tick.
func (g *guard) observePacer(load pacerLoad) {
	g.mu.Lock()
	g.latest = load
	g.mu.Unlock()
}

// recentSteal is the steal, as a percent, over the latest second sampled, or 0.
func (g *guard) recentSteal() float64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.steal) < 2 {
		return 0
	}
	first, last := g.steal[len(g.steal)-2], g.steal[len(g.steal)-1]
	if last.total <= first.total {
		return 0
	}
	return 100 * float64(last.steal-first.steal) / float64(last.total-first.total)
}

// slots is how many one-second samples the window holds.
func (g *guard) slots() int { return max(int(g.cfg.Window/time.Second), 1) }

// closedReason is why new Episodes are refused, or empty.
func (g *guard) closedReason() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.health.AdmissionReason
}

func (g *guard) snapshot() HostHealth {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.health
}

// tick takes one second's sample and reevaluates admission. The node calls it once a second.
func (g *guard) tick() {
	times, known := g.readSteal()
	udp, udpKnown := g.readUDP()
	delays := g.delays.collect()
	sched := g.readSched()

	g.mu.Lock()
	slots := g.slots()
	g.steal = sampleOrReset(g.steal, times, known, slots+1)
	g.udp = sampleOrReset(g.udp, udp, udpKnown, slots+1)
	g.pacer = appendBounded(g.pacer, g.latest, slots+1)
	g.delayRing = appendBounded(g.delayRing, delays, slots)
	if sched != nil {
		g.sched = appendBounded(g.sched, *sched, latencySlots+1)
	}
	health := g.evaluate(slots)
	previous := g.health.AdmissionReason
	g.health = health
	g.mu.Unlock()

	if health.AdmissionReason != previous {
		g.logAdmission(health, previous)
	}
}

// sampleOrReset appends a reading, or empties the ring while the host cannot be read.
func sampleOrReset[T any](ring []T, value T, known bool, limit int) []T {
	if !known {
		return ring[:0]
	}
	return appendBounded(ring, value, limit)
}

// evaluate reads the host's health off the sampled rings. The caller holds g.mu.
func (g *guard) evaluate(slots int) HostHealth {
	health := HostHealth{StealKnown: len(g.steal) > 1}
	if health.StealKnown {
		health.StealPercent, health.BusyPercent = cpuShares(g.steal[0], g.steal[len(g.steal)-1])
	}
	health.QueueDelayP95 = percentile(sumCounts(g.delayRing), 0.95)
	if len(g.udp) > slots {
		health.UDPReceiveErrorsPerSecond, health.UDPSendErrorsPerSecond = udpRates(g.udp[0], g.udp[len(g.udp)-1], float64(len(g.udp)-1))
	}
	if len(g.pacer) > slots {
		health.PacerDrops, health.PacerDropPercent = pacerShare(g.pacer[0], g.pacer[len(g.pacer)-1])
	}
	if len(g.sched) > 1 {
		health.SchedulerLatencyP99 = histogramDeltaPercentile(g.sched[0], g.sched[len(g.sched)-1], 0.99)
	}
	// Every rate needs a full window, so one busy second at boot never closes admission.
	health.AdmissionReason = g.refusal(health, len(g.steal) > slots, len(g.sched) > latencySlots)
	return health
}

// refusal is why the host's health closes admission, or empty.
func (g *guard) refusal(health HostHealth, fullStealWindow, fullLatencyWindow bool) string {
	switch {
	case health.StealKnown && fullStealWindow && health.StealPercent > g.cfg.MaxStealPercent:
		return RefusedCPUSteal
	case health.StealKnown && fullStealWindow && health.BusyPercent > g.cfg.MaxBusyPercent:
		return RefusedCPUBusy
	case fullLatencyWindow && health.SchedulerLatencyP99 > g.cfg.MaxSchedulerLatency:
		return RefusedSchedulerLatency
	case health.PacerDrops >= minGuardPacerDrops && health.PacerDropPercent > g.cfg.MaxPacerDropPercent:
		return RefusedPacerDrops
	case max(health.UDPReceiveErrorsPerSecond, health.UDPSendErrorsPerSecond) > float64(g.cfg.MaxUDPErrorsPerSecond):
		return RefusedUDPErrors
	}
	return ""
}

func (g *guard) logAdmission(health HostHealth, previous string) {
	attributes := []any{
		"reason", health.AdmissionReason, "previousReason", previous,
		"stealPercent", round2(health.StealPercent), "busyPercent", round2(health.BusyPercent),
		"schedulerLatencyP99Ms", health.SchedulerLatencyP99.Milliseconds(),
		"queueDelayP95Ms", health.QueueDelayP95.Milliseconds(),
		"pacerDrops", health.PacerDrops, "pacerDropPercent", round2(health.PacerDropPercent),
		"udpReceiveErrorsPerSecond", round2(health.UDPReceiveErrorsPerSecond),
		"udpSendErrorsPerSecond", round2(health.UDPSendErrorsPerSecond),
	}
	if health.AdmissionReason != "" {
		g.log.Warn("new Episodes refused", attributes...)
		return
	}
	g.log.Info("new Episodes admitted again", attributes...)
}

func appendBounded[T any](ring []T, value T, limit int) []T {
	ring = append(ring, value)
	if len(ring) > limit {
		ring = append(ring[:0], ring[len(ring)-limit:]...)
	}
	return ring
}

func round2(value float64) float64 { return math.Round(value*100) / 100 }
