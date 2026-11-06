package telemetry

import (
	"bytes"
	"os"
	"strconv"
	"syscall"
	"time"
)

// processCPUSeconds is the user and system CPU time this process used.
func processCPUSeconds() (float64, bool) {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0, false
	}
	used := time.Duration(usage.Utime.Nano()) + time.Duration(usage.Stime.Nano())
	return used.Seconds(), true
}

// residentBytes reads this process's resident memory from /proc/self/statm. It reports false
// where the host has no procfs.
func residentBytes() (uint64, bool) {
	statm, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0, false
	}
	fields := bytes.Fields(statm)
	if len(fields) < 2 {
		return 0, false
	}
	pages, err := strconv.ParseUint(string(fields[1]), 10, 64)
	if err != nil {
		return 0, false
	}
	return pages * uint64(os.Getpagesize()), true
}
