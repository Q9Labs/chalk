package main

import (
	"net"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

const (
	maxAppendBatchSize    = 200
	maxPageSize           = 1000
	defaultStreamDuration = 2 * time.Second
	maxStreamDuration     = 30 * time.Minute
	maxRetentionWait      = 30 * 24 * time.Hour
	defaultTenantID       = "00000000-0000-4000-8000-000000000001"
	defaultSpaceID        = "00000000-0000-4000-8000-000000000002"
	defaultEpisodeID      = "00000000-0000-4000-8000-000000000003"
)

type config struct {
	BaseURL              string
	Events               int64
	Participants         int
	Viewers              int
	BatchSize            int
	AppendWorkers        int
	PageSize             int
	Reconnects           int
	StreamDuration       time.Duration
	RetentionWait        time.Duration
	Reference            string
	ProducerToken        string
	OperatorToken        string
	TenantID             string
	SpaceID              string
	EpisodeID            string
	ProducerInstance     string
	RetentionProbeURL    string
	DryRun               bool
	AcknowledgeExecution bool
	AllowRemote          bool
	AllowProduction      bool
}

type report struct {
	SchemaVersion string             `json:"schemaVersion"`
	Status        string             `json:"status"`
	Config        reportConfig       `json:"config"`
	Reference     string             `json:"reference,omitempty"`
	DurationMs    float64            `json:"durationMs"`
	Latencies     map[string]latency `json:"latencies"`
	Memory        memoryReport       `json:"memory"`
	Counters      counterReport      `json:"counters"`
	Throughput    throughputReport   `json:"throughput"`
	Reconnect     reconnectReport    `json:"reconnect"`
	Retention     retentionReport    `json:"retention"`
	Gaps          []string           `json:"gaps,omitempty"`
}

type reportConfig struct {
	BaseURL       string `json:"baseUrl"`
	Events        int64  `json:"events"`
	Participants  int    `json:"participants"`
	Viewers       int    `json:"viewers"`
	BatchSize     int    `json:"batchSize"`
	AppendWorkers int    `json:"appendWorkers"`
	PageSize      int    `json:"pageSize"`
	Reconnects    int    `json:"reconnects"`
	DryRun        bool   `json:"dryRun"`
}

type latency struct {
	Count int     `json:"count"`
	MinMs float64 `json:"minMs,omitempty"`
	MaxMs float64 `json:"maxMs,omitempty"`
	P50Ms float64 `json:"p50Ms,omitempty"`
	P95Ms float64 `json:"p95Ms,omitempty"`
	P99Ms float64 `json:"p99Ms,omitempty"`
}

type memoryReport struct {
	StartHeapAllocBytes uint64 `json:"startHeapAllocBytes"`
	EndHeapAllocBytes   uint64 `json:"endHeapAllocBytes"`
	PeakHeapAllocBytes  uint64 `json:"peakHeapAllocBytes"`
	StartHeapInuseBytes uint64 `json:"startHeapInuseBytes"`
	EndHeapInuseBytes   uint64 `json:"endHeapInuseBytes"`
	PeakHeapInuseBytes  uint64 `json:"peakHeapInuseBytes"`
	StartSysBytes       uint64 `json:"startSysBytes"`
	EndSysBytes         uint64 `json:"endSysBytes"`
	PeakSysBytes        uint64 `json:"peakSysBytes"`
	Goroutines          int    `json:"goroutines"`
}

type counterReport struct {
	AttemptedEvents int64 `json:"attemptedEvents"`
	AcceptedEvents  int64 `json:"acceptedEvents"`
	DuplicateEvents int64 `json:"duplicateEvents"`
	Conflicts       int64 `json:"conflicts"`
	Rejections      int64 `json:"rejections"`
	HTTPFailures    int64 `json:"httpFailures"`
	ReadFailures    int64 `json:"readFailures"`
}

type throughputReport struct {
	EventsPerSecond         float64 `json:"eventsPerSecond"`
	AcceptedEventsPerSecond float64 `json:"acceptedEventsPerSecond"`
	BatchesPerSecond        float64 `json:"batchesPerSecond"`
}

type reconnectReport struct {
	Connections       int64 `json:"connections"`
	ReconnectAttempts int64 `json:"reconnectAttempts"`
	Successful        int64 `json:"successful"`
	Deltas            int64 `json:"deltas"`
	Gaps              int64 `json:"gaps"`
	LostCursors       int64 `json:"lostCursors"`
	LastCursor        int64 `json:"lastCursor"`
}

type retentionReport struct {
	Status             string  `json:"status"`
	WaitMs             float64 `json:"waitMs,omitempty"`
	ProbeLatencyMs     float64 `json:"probeLatencyMs,omitempty"`
	ProbeURLConfigured bool    `json:"probeUrlConfigured"`
	Note               string  `json:"note,omitempty"`
}

func isLoopbackBaseURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if host == "localhost" {
		return true
	}
	if address, err := netip.ParseAddr(host); err == nil {
		return address.IsLoopback()
	}
	// net.ParseIP handles a few legacy textual forms that netip intentionally
	// rejects; it is still restricted to loopback addresses here.
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}
