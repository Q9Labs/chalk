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
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		slog.Warn("recorder resource sample failed", "role", role, "error", err)
		return
	}
	statm, statErr := os.ReadFile("/proc/self/statm")
	meminfo, memErr := os.ReadFile("/proc/meminfo")
	loadavg, loadErr := os.ReadFile("/proc/loadavg")
	if statErr != nil || memErr != nil || loadErr != nil {
		slog.Warn("recorder resource sample failed", "role", role, "statm_error", statErr, "meminfo_error", memErr, "load_error", loadErr)
		return
	}
	statFields := strings.Fields(string(statm))
	loadFields := strings.Fields(string(loadavg))
	if len(statFields) < 2 || len(loadFields) < 1 {
		slog.Warn("recorder resource sample failed", "role", role, "error", "invalid proc fields")
		return
	}
	residentPages, pageErr := strconv.ParseInt(statFields[1], 10, 64)
	load, loadParseErr := strconv.ParseFloat(loadFields[0], 64)
	total, totalErr := memoryInfoBytes(meminfo, "MemTotal:")
	available, availableErr := memoryInfoBytes(meminfo, "MemAvailable:")
	if err := firstResourceError(pageErr, loadParseErr, totalErr, availableErr); err != nil {
		slog.Warn("recorder resource sample failed", "role", role, "error", err)
		return
	}
	peakRSS := usage.Maxrss * 1024 // Linux getrusage reports KiB.
	if runtime.GOOS == "darwin" {
		peakRSS = usage.Maxrss
	}
	slog.Info("recorder process resources", "role", role,
		"cpu_seconds", timevalSeconds(usage.Utime)+timevalSeconds(usage.Stime),
		"cpu_user_seconds", timevalSeconds(usage.Utime), "cpu_system_seconds", timevalSeconds(usage.Stime),
		"rss_bytes", residentPages*int64(os.Getpagesize()), "peak_rss_bytes", peakRSS,
		"host_memory_total_bytes", total, "host_memory_available_bytes", available, "host_load_1m", load)
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
