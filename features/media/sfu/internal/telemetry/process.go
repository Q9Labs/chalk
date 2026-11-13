package telemetry

import (
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
