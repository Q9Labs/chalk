package recorderworker

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workerresources"
)

// StartProcessResourceLogs reports bounded host/process measurements until stop.
// The final measurement is emitted after the worker returns.
func StartProcessResourceLogs(ctx context.Context, role string) func() {
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				logProcessResources(role)
				return
			case <-stop:
				logProcessResources(role)
				return
			case <-ticker.C:
				logProcessResources(role)
			}
		}
	}()
	return func() { close(stop); <-done }
}

func logProcessResources(role string) {
	sample, err := sampleProcessResources()
	if err != nil {
		slog.Warn("recorder resource sample failed", "role", role, "error", err)
		return
	}
	slog.Info("recorder process resources", "role", role,
		"cpu_seconds", sample.CPUUserSeconds+sample.CPUSystemSeconds,
		"cpu_user_seconds", sample.CPUUserSeconds, "cpu_system_seconds", sample.CPUSystemSeconds,
		"rss_bytes", sample.RSSBytes, "peak_rss_bytes", sample.PeakRSSBytes,
		"host_memory_total_bytes", sample.HostMemoryTotalBytes, "host_memory_available_bytes", sample.HostMemoryAvailableBytes, "host_load_1m", sample.Load1)
}

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

func memoryInfoBytes(data []byte, key string) (int64, error) {
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, key) {
			fields := strings.Fields(strings.TrimPrefix(line, key))
			if len(fields) != 2 || fields[1] != "kB" {
				break
			}
			kilobytes, err := strconv.ParseInt(fields[0], 10, 64)
			return kilobytes * 1024, err
		}
	}
	return 0, fmt.Errorf("missing %s in proc meminfo", key)
}

func firstResourceError(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}
