//go:build unix

package recorderworker

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workerresources"
)

func sampleProcessResources() (workerresources.Sample, error) {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return workerresources.Sample{}, err
	}
	statm, statErr := os.ReadFile("/proc/self/statm")
	meminfo, memErr := os.ReadFile("/proc/meminfo")
	loadavg, loadErr := os.ReadFile("/proc/loadavg")
	if statErr != nil || memErr != nil || loadErr != nil {
		return workerresources.Sample{}, fmt.Errorf("read proc resources: %v, %v, %v", statErr, memErr, loadErr)
	}
	statFields := strings.Fields(string(statm))
	loadFields := strings.Fields(string(loadavg))
	if len(statFields) < 2 || len(loadFields) < 1 {
		return workerresources.Sample{}, fmt.Errorf("invalid proc fields")
	}
	residentPages, pageErr := strconv.ParseInt(statFields[1], 10, 64)
	load, loadParseErr := strconv.ParseFloat(loadFields[0], 64)
	total, totalErr := memoryInfoBytes(meminfo, "MemTotal:")
	available, availableErr := memoryInfoBytes(meminfo, "MemAvailable:")
	if err := firstResourceError(pageErr, loadParseErr, totalErr, availableErr); err != nil {
		return workerresources.Sample{}, err
	}
	peakRSS := usage.Maxrss * 1024 // Linux getrusage reports KiB.
	if runtime.GOOS == "darwin" {
		peakRSS = usage.Maxrss
	}
	return workerresources.Sample{
		CPUUserSeconds: timevalSeconds(usage.Utime), CPUSystemSeconds: timevalSeconds(usage.Stime),
		RSSBytes: residentPages * int64(os.Getpagesize()), PeakRSSBytes: peakRSS,
		HostMemoryTotalBytes: total, HostMemoryAvailableBytes: available, Load1: load, SampledAt: time.Now().UTC(),
	}, nil
}

func timevalSeconds(value syscall.Timeval) float64 {
	return float64(value.Sec) + float64(value.Usec)/1e6
}
