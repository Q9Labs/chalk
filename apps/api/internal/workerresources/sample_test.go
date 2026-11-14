package workerresources

import (
	"math"
	"testing"
	"time"
)

func TestSampleValidBoundsEveryField(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	valid := Sample{
		CPUUserSeconds: 1, CPUSystemSeconds: 2, RSSBytes: 100, PeakRSSBytes: 100,
		HostMemoryTotalBytes: 1000, HostMemoryAvailableBytes: 500, Load1: 0.5, SampledAt: now,
	}
	if !valid.Valid(now) {
		t.Fatal("a plausible sample was rejected")
	}
	changes := map[string]func(*Sample){
		"NaN cpu":            func(s *Sample) { s.CPUUserSeconds = math.NaN() },
		"infinite cpu":       func(s *Sample) { s.CPUSystemSeconds = math.Inf(1) },
		"negative cpu":       func(s *Sample) { s.CPUUserSeconds = -1 },
		"huge cpu":           func(s *Sample) { s.CPUUserSeconds = 1e13 },
		"huge load":          func(s *Sample) { s.Load1 = 1e7 },
		"negative rss":       func(s *Sample) { s.RSSBytes = -1 },
		"peak below rss":     func(s *Sample) { s.PeakRSSBytes = 99 },
		"huge peak":          func(s *Sample) { s.PeakRSSBytes = 1<<50 + 1 },
		"no host memory":     func(s *Sample) { s.HostMemoryTotalBytes = 0 },
		"available > total":  func(s *Sample) { s.HostMemoryAvailableBytes = 1001 },
		"negative available": func(s *Sample) { s.HostMemoryAvailableBytes = -1 },
		"unset time":         func(s *Sample) { s.SampledAt = time.Time{} },
		"stale":              func(s *Sample) { s.SampledAt = now.Add(-24*time.Hour - time.Second) },
		"future":             func(s *Sample) { s.SampledAt = now.Add(5*time.Minute + time.Second) },
	}
	for name, change := range changes {
		sample := valid
		change(&sample)
		if sample.Valid(now) {
			t.Errorf("%s: accepted", name)
		}
	}
	edge := valid
	edge.SampledAt = now.Add(-24 * time.Hour)
	edge.HostMemoryAvailableBytes = edge.HostMemoryTotalBytes
	if !edge.Valid(now) {
		t.Error("boundary values must be accepted")
	}
}
