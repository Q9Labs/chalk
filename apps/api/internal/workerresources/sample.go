package workerresources

import (
	"math"
	"time"
)

// Sample is a worker process and its host at one instant. CPU values are
// cumulative process seconds; memory values are bytes.
type Sample struct {
	CPUUserSeconds           float64   `json:"cpu_user_seconds"`
	CPUSystemSeconds         float64   `json:"cpu_system_seconds"`
	RSSBytes                 int64     `json:"rss_bytes"`
	PeakRSSBytes             int64     `json:"peak_rss_bytes"`
	HostMemoryTotalBytes     int64     `json:"host_memory_total_bytes"`
	HostMemoryAvailableBytes int64     `json:"host_memory_available_bytes"`
	Load1                    float64   `json:"load1"`
	SampledAt                time.Time `json:"sampled_at"`
}

func (s Sample) Valid(now time.Time) bool {
	const maxBytes = int64(1 << 50)
	validFloat := func(value float64) bool {
		return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1e12
	}
	return validFloat(s.CPUUserSeconds) && validFloat(s.CPUSystemSeconds) && validFloat(s.Load1) && s.Load1 <= 1e6 &&
		s.RSSBytes >= 0 && s.RSSBytes <= maxBytes && s.PeakRSSBytes >= s.RSSBytes && s.PeakRSSBytes <= maxBytes &&
		s.HostMemoryTotalBytes > 0 && s.HostMemoryTotalBytes <= maxBytes && s.HostMemoryAvailableBytes >= 0 && s.HostMemoryAvailableBytes <= s.HostMemoryTotalBytes &&
		!s.SampledAt.IsZero() && !s.SampledAt.Before(now.Add(-24*time.Hour)) && !s.SampledAt.After(now.Add(5*time.Minute))
}
