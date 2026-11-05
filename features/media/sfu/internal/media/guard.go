package media

import (
	"bufio"
	"bytes"
	"log/slog"
	"math"
	"os"
	"runtime/metrics"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// Admission reasons the guard reports while it refuses new Episodes.
const (
	reasonCPUSteal        = "cpu_steal"
	reasonPacerQueueDelay = "pacer_queue_delay"
)

// queueDelayBounds are the upper bounds of the pacer queue delay histogram. A
// percentile reads as the bound of its bucket, so it never understates the delay.
var queueDelayBounds = [...]time.Duration{
	0, time.Millisecond, 2 * time.Millisecond, 5 * time.Millisecond, 10 * time.Millisecond,
	20 * time.Millisecond, 35 * time.Millisecond, 50 * time.Millisecond, 75 * time.Millisecond,
	100 * time.Millisecond, 200 * time.Millisecond, 500 * time.Millisecond, time.Second,
}

const queueDelayBuckets = len(queueDelayBounds) + 1 // the last bucket holds everything slower

// delayHistogram counts pacer queue delays of every subscriber on the node. Pacers
// record without locking; the guard collects the counts once a second.
type delayHistogram struct {
	counts [queueDelayBuckets]atomic.Uint64
}

func (h *delayHistogram) record(delay time.Duration) {
	bucket := len(queueDelayBounds)
	for index, bound := range queueDelayBounds {
		if delay <= bound {
			bucket = index
			break
		}
	}
	h.counts[bucket].Add(1)
}

func (h *delayHistogram) collect() (counts [queueDelayBuckets]uint64) {
	for index := range h.counts {
		counts[index] = h.counts[index].Swap(0)
	}
	return counts
}

// percentile reads p of the counts as its bucket's upper bound.
func percentile(counts [queueDelayBuckets]uint64, p float64) time.Duration {
	var total uint64
	for _, count := range counts {
		total += count
	}
	if total == 0 {
		return 0
	}
	rank := uint64(math.Ceil(p * float64(total)))
	var seen uint64
	for index, count := range counts {
		seen += count
		if seen >= rank {
			if index < len(queueDelayBounds) {
				return queueDelayBounds[index]
			}
			break
		}
	}
	return 2 * queueDelayBounds[len(queueDelayBounds)-1]
}

// cpuTimes is one /proc/stat reading of the host's CPU time, in clock ticks.
type cpuTimes struct{ steal, total uint64 }

// stealReader reads the host's CPU times. It reports false where the host
// does not expose them, and steal then reads as zero.
type stealReader func() (cpuTimes, bool)

// readProcStat reads the aggregate "cpu" line of /proc/stat. Guest time is
// already counted in user time, so the total leaves it out.
func readProcStat() (cpuTimes, bool) {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return cpuTimes{}, false
	}
	defer func() { _ = file.Close() }()
	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		return cpuTimes{}, false
	}
	fields := bytes.Fields(scanner.Bytes())
	if len(fields) < 9 || string(fields[0]) != "cpu" {
		return cpuTimes{}, false
	}
	var times cpuTimes
	for index, field := range fields[1:9] { // user nice system idle iowait irq softirq steal
		value, err := strconv.ParseUint(string(field), 10, 64)
		if err != nil {
			return cpuTimes{}, false
		}
		times.total += value
		if index == 7 {
			times.steal = value
		}
	}
	return times, true
}

// HostHealth is the guard's latest view of the host, for readiness and telemetry.
type HostHealth struct {
	// AdmissionReason is why new Episodes are refused, or empty while they are admitted.
	AdmissionReason     string
	StealPercent        float64
	StealKnown          bool
	QueueDelayP95       time.Duration
	SchedulerLatencyP99 time.Duration
}

// guard closes admission of new Episodes while the host cannot serve them on
// time: CPU steal above its threshold, or pacer queue delay p95 above its
// threshold, each over the guard window. Existing Episodes keep running.
type guard struct {
	cfg       config.Guard
	log       *slog.Logger
	readSteal stealReader
	delays    delayHistogram

	mu        sync.Mutex
	steal     []cpuTimes // one reading a second, oldest first, at most one window plus one
	delayRing [][queueDelayBuckets]uint64
	sched     []metrics.Float64Histogram
	health    HostHealth
}

func newGuard(cfg config.Guard, log *slog.Logger) *guard {
	return &guard{cfg: cfg, log: log, readSteal: readProcStat}
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
	delays := g.delays.collect()
	sched := readSchedulerLatencies()

	g.mu.Lock()
	slots := g.slots()
	if known {
		g.steal = appendBounded(g.steal, times, slots+1)
	} else {
		g.steal = g.steal[:0]
	}
	g.delayRing = appendBounded(g.delayRing, delays, slots)
	if sched != nil {
		g.sched = appendBounded(g.sched, *sched, slots+1)
	}

	health := HostHealth{StealKnown: len(g.steal) > 1}
	if health.StealKnown {
		first, last := g.steal[0], g.steal[len(g.steal)-1]
		if total := last.total - first.total; total > 0 {
			health.StealPercent = 100 * float64(last.steal-first.steal) / float64(total)
		}
	}
	var window [queueDelayBuckets]uint64
	for _, counts := range g.delayRing {
		for index, count := range counts {
			window[index] += count
		}
	}
	health.QueueDelayP95 = percentile(window, 0.95)
	if len(g.sched) > 1 {
		health.SchedulerLatencyP99 = histogramDeltaPercentile(g.sched[0], g.sched[len(g.sched)-1], 0.99)
	}
	// Steal needs a full window, so one busy second at boot never closes admission.
	switch {
	case health.StealKnown && len(g.steal) > slots && health.StealPercent > g.cfg.MaxStealPercent:
		health.AdmissionReason = reasonCPUSteal
	case health.QueueDelayP95 > g.cfg.MaxQueueDelay:
		health.AdmissionReason = reasonPacerQueueDelay
	}
	previous := g.health.AdmissionReason
	g.health = health
	g.mu.Unlock()

	if health.AdmissionReason != previous {
		attributes := []any{
			"reason", health.AdmissionReason, "previousReason", previous,
			"stealPercent", round2(health.StealPercent), "queueDelayP95Ms", health.QueueDelayP95.Milliseconds(),
		}
		if health.AdmissionReason != "" {
			g.log.Warn("new Episodes refused", attributes...)
		} else {
			g.log.Info("new Episodes admitted again", attributes...)
		}
	}
}

func appendBounded[T any](ring []T, value T, limit int) []T {
	ring = append(ring, value)
	if len(ring) > limit {
		ring = append(ring[:0], ring[len(ring)-limit:]...)
	}
	return ring
}

func round2(value float64) float64 { return math.Round(value*100) / 100 }

const schedLatencyMetric = "/sched/latencies:seconds"

// readSchedulerLatencies reads the Go runtime's cumulative histogram of how long
// runnable goroutines waited to run.
func readSchedulerLatencies() *metrics.Float64Histogram {
	sample := []metrics.Sample{{Name: schedLatencyMetric}}
	metrics.Read(sample)
	if sample[0].Value.Kind() != metrics.KindFloat64Histogram {
		return nil
	}
	histogram := sample[0].Value.Float64Histogram()
	return &metrics.Float64Histogram{Counts: append([]uint64(nil), histogram.Counts...), Buckets: histogram.Buckets}
}

// histogramDeltaPercentile reads p of the latencies recorded between two
// cumulative readings, as the upper bound of its bucket.
func histogramDeltaPercentile(older, newer metrics.Float64Histogram, p float64) time.Duration {
	if len(older.Counts) != len(newer.Counts) {
		return 0
	}
	var total uint64
	for index := range newer.Counts {
		total += newer.Counts[index] - older.Counts[index]
	}
	if total == 0 {
		return 0
	}
	rank := uint64(math.Ceil(p * float64(total)))
	var seen uint64
	for index := range newer.Counts {
		seen += newer.Counts[index] - older.Counts[index]
		if seen >= rank {
			bound := newer.Buckets[index+1]
			if math.IsInf(bound, 1) {
				bound = newer.Buckets[index]
			}
			return time.Duration(bound * float64(time.Second))
		}
	}
	return 0
}
