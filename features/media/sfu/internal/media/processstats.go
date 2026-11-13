package media

import (
	"os"
	"runtime/metrics"
	"strconv"
	"strings"
)

const rssPath = "/proc/self/statm"

// ResidentBytes is the process's resident memory, from /proc/self/statm. It reports false where the
// host has no procfs.
func ResidentBytes() (uint64, bool) { return readRSS(rssPath) }

// readRSS reads the process's resident memory from /proc/self/statm, whose second field is
// resident pages. It reports false where the host has no such file.
func readRSS(path string) (uint64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 2 {
		return 0, false
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return pages * uint64(os.Getpagesize()), true
}

// readRuntime reads the Go runtime's live goroutines and in-use heap. Unlike runtime.ReadMemStats it
// does not stop the world, which matters on a one-vCPU node that is forwarding media. The heap in
// use is HeapInuse as MemStats defines it: allocated objects (heap/objects, which counts unswept
// garbage) plus the unused room inside in-use spans (heap/unused).
func readRuntime() (goroutines int, heapInuse uint64) {
	samples := []metrics.Sample{
		{Name: "/sched/goroutines:goroutines"},
		{Name: "/memory/classes/heap/objects:bytes"},
		{Name: "/memory/classes/heap/unused:bytes"},
	}
	metrics.Read(samples)
	for index, sample := range samples {
		if sample.Value.Kind() != metrics.KindUint64 {
			continue
		}
		if index == 0 {
			goroutines = int(sample.Value.Uint64())
			continue
		}
		heapInuse += sample.Value.Uint64()
	}
	return goroutines, heapInuse
}
