package media

import (
	"bufio"
	"bytes"
	"math"
	"os"
	"runtime/metrics"
	"strconv"
	"time"
)

// cpuTimes is one /proc/stat reading of the host's CPU time, in clock ticks.
// cpuTimes are the host's cumulative CPU ticks: stolen, idle (iowait included) and in total.
type cpuTimes struct{ steal, idle, total uint64 }

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
		switch index {
		case 3, 4:
			times.idle += value
		case 7:
			times.steal = value
		}
	}
	return times, true
}

// cpuShares is the steal and busy percent of the CPU time between two readings.
func cpuShares(first, last cpuTimes) (steal, busy float64) {
	total := last.total - first.total
	if total == 0 {
		return 0, 0
	}
	stolen, idle := last.steal-first.steal, last.idle-first.idle
	return 100 * float64(stolen) / float64(total), 100 * float64(total-stolen-idle) / float64(total)
}

// udpRates is the socket-buffer errors per second between two readings taken seconds apart.
func udpRates(first, last udpErrors, seconds float64) (receive, send float64) {
	return float64(last.receive-first.receive) / seconds, float64(last.send-first.send) / seconds
}

// pacerShare is the video the pacers dropped between two readings and its share of what they dropped or sent.
func pacerShare(first, last pacerLoad) (drops uint64, percent float64) {
	drops = last.dropped - first.dropped
	if total := drops + last.sent - first.sent; total > 0 {
		percent = 100 * float64(drops) / float64(total)
	}
	return drops, percent
}

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
