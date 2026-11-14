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
	finite := func(value, max float64) bool { return !math.IsNaN(value) && value >= 0 && value <= max }
	inBytes := func(value, min int64) bool { return value >= min && value <= maxBytes }
	return finite(s.CPUUserSeconds, 1e12) && finite(s.CPUSystemSeconds, 1e12) && finite(s.Load1, 1e6) &&
		inBytes(s.RSSBytes, 0) && inBytes(s.PeakRSSBytes, s.RSSBytes) &&
		inBytes(s.HostMemoryTotalBytes, 1) && s.HostMemoryAvailableBytes >= 0 && s.HostMemoryAvailableBytes <= s.HostMemoryTotalBytes &&
		!s.SampledAt.Before(now.Add(-24*time.Hour)) && !s.SampledAt.After(now.Add(5*time.Minute)) && !s.SampledAt.IsZero()
}
