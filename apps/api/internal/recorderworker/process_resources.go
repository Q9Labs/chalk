package recorderworker

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
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
