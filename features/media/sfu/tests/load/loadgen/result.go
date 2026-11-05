package main

import (
	"context"
	"math"
	"slices"
	"sync"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/tests/load/hostmetrics"
)

// resultsFile is what loadgen writes. The report command merges it with the node's samples.
type resultsFile struct {
	Label       string              `json:"label"`
	EpisodeSize int                 `json:"episodeSize"`
	Workload    workloadDescription `json:"workload"`
	Steps       []stepResult        `json:"steps"`
}

type workloadDescription struct {
	VideoKbps         float64 `json:"videoKbps"`
	LowKbps           float64 `json:"lowKbps"`
	VideoPayloadBytes int     `json:"videoPayloadBytes"`
	VideoPPS          float64 `json:"videoPps"`
	LowPPS            float64 `json:"lowPps"`
	AudioPayloadBytes int     `json:"audioPayloadBytes"`
	AudioPPS          float64 `json:"audioPps"`
	PublishLow        bool    `json:"publishLow"`
}

// distribution summarizes one measured quantity over the window.
type distribution struct {
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	Max float64 `json:"max"`
}

// stepResult is one measured window. Every receive figure comes from packets that arrived at a subscriber.
type stepResult struct {
	Episodes     int `json:"episodes"`
	EpisodeSize  int `json:"episodeSize"`
	Participants int `json:"participants"`
	Streams      int `json:"streams"` // subscribed streams in the window

	WindowStartUnixMs int64   `json:"windowStartUnixMs"`
	WindowEndUnixMs   int64   `json:"windowEndUnixMs"`
	WindowSeconds     float64 `json:"windowSeconds"`

	RecvPPS  float64 `json:"recvPps"`
	RecvMbps float64 `json:"recvMbps"`
	SentPPS  float64 `json:"sentPps"`
	SentMbps float64 `json:"sentMbps"`

	LossPct            float64 `json:"lossPct"`
	VideoLossPct       float64 `json:"videoLossPct"`
	AudioLossPct       float64 `json:"audioLossPct"`
	WorstStreamLossPct float64 `json:"worstStreamLossPct"`
	ExpectedPackets    int64   `json:"expectedPackets"`
	LostPackets        int64   `json:"lostPackets"`

	// VideoStreamKbps shows which simulcast layer the SFU forwarded: the high layer
	// is about VideoKbps, the low layer about LowKbps.
	VideoStreamKbps distribution `json:"videoStreamKbps"`
	VideoJitterMs   distribution `json:"videoJitterMs"`
	AudioJitterMs   distribution `json:"audioJitterMs"`

	DroppedDuringWindow int `json:"droppedDuringWindow"`

	// The generator's own load, to show it was not the bottleneck.
	GenHostBusyAvgPct float64 `json:"genHostBusyAvgPct"`
	GenHostBusyMaxPct float64 `json:"genHostBusyMaxPct"`
	GenStealAvgPct    float64 `json:"genStealAvgPct"`
}

// hostRecorder keeps the generator's own host samples for the whole run.
type hostRecorder struct {
	reader  *hostmetrics.Reader
	mu      sync.Mutex
	samples []hostmetrics.Sample
}

func newHostRecorder(iface string) *hostRecorder {
	if iface == "" {
		iface = "eth0"
	}
	return &hostRecorder{reader: hostmetrics.NewReader(iface)}
}

func (h *hostRecorder) run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sample := h.reader.Next()
			h.mu.Lock()
			h.samples = append(h.samples, sample)
			h.mu.Unlock()
		}
	}
}

func (h *hostRecorder) between(from, to time.Time) []hostmetrics.Sample {
	h.mu.Lock()
	defer h.mu.Unlock()
	var window []hostmetrics.Sample
	for _, sample := range h.samples {
		if sample.UnixMs >= from.UnixMilli() && sample.UnixMs <= to.UnixMilli() {
			window = append(window, sample)
		}
	}
	return window
}

// measure holds the current load for the window and summarizes what subscribers received.
func (g *generator) measure(ctx context.Context, result stepResult) (stepResult, error) {
	g.mu.Lock()
	people := append([]*participant(nil), g.participants...)
	g.mu.Unlock()

	var streams []*stream
	for _, p := range people {
		streams = append(streams, p.received.all()...)
	}
	before := make([]streamSnapshot, len(streams))
	for i, s := range streams {
		before[i] = s.snapshot()
	}
	sentBefore := sentTotals(people)
	droppedBefore := countDropped(people)

	start := time.Now()
	var videoJitter, audioJitter []float64
	sampler := time.NewTicker(time.Second)
	defer sampler.Stop()
	progress := time.NewTicker(30 * time.Second)
	defer progress.Stop()
	deadline := time.After(g.cfg.hold)
hold:
	for {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case <-deadline:
			break hold
		case <-sampler.C:
			for i, s := range streams {
				if !before[i].started {
					continue
				}
				if s.video {
					videoJitter = append(videoJitter, s.jitterMs())
				} else {
					audioJitter = append(audioJitter, s.jitterMs())
				}
			}
		case <-progress.C:
			g.log.Info("holding", "episodes", result.Episodes, "elapsed", time.Since(start).Round(time.Second), "dropped", countDropped(people)-droppedBefore)
		}
	}
	end := time.Now()
	seconds := end.Sub(start).Seconds()

	var recvPackets, recvBytes, expected, lost, videoExpected, videoLost, audioExpected, audioLost int64
	var worst float64
	var videoKbps []float64
	for i, s := range streams {
		if !before[i].started {
			continue
		}
		after := s.snapshot()
		packets := int64(after.packets - before[i].packets)
		bytes := int64(after.bytes - before[i].bytes)
		want := after.highest - before[i].highest
		missing := max(0, want-packets)
		recvPackets += packets
		recvBytes += bytes
		expected += want
		lost += missing
		if want > 0 {
			worst = max(worst, 100*float64(missing)/float64(want))
		}
		if s.video {
			videoExpected += want
			videoLost += missing
			videoKbps = append(videoKbps, float64(bytes)*8/seconds/1000)
		} else {
			audioExpected += want
			audioLost += missing
		}
	}
	sentAfter := sentTotals(people)

	result.Participants = len(people)
	result.Streams = len(streams)
	result.WindowStartUnixMs, result.WindowEndUnixMs, result.WindowSeconds = start.UnixMilli(), end.UnixMilli(), seconds
	result.RecvPPS = float64(recvPackets) / seconds
	result.RecvMbps = float64(recvBytes) * 8 / seconds / 1e6
	result.SentPPS = float64(sentAfter.packets-sentBefore.packets) / seconds
	result.SentMbps = float64(sentAfter.bytes-sentBefore.bytes) * 8 / seconds / 1e6
	result.ExpectedPackets, result.LostPackets = expected, lost
	result.LossPct, result.VideoLossPct, result.AudioLossPct = percent(lost, expected), percent(videoLost, videoExpected), percent(audioLost, audioExpected)
	result.WorstStreamLossPct = worst
	result.VideoStreamKbps = summarize(videoKbps)
	result.VideoJitterMs, result.AudioJitterMs = summarize(videoJitter), summarize(audioJitter)
	result.DroppedDuringWindow = countDropped(people) - droppedBefore

	var busy, steal []float64
	for _, sample := range g.host.between(start, end) {
		busy = append(busy, sample.HostBusyPct)
		steal = append(steal, sample.StealPct)
	}
	result.GenHostBusyAvgPct, result.GenHostBusyMaxPct, result.GenStealAvgPct = mean(busy), summarize(busy).Max, mean(steal)
	g.log.Info("measured", "episodes", result.Episodes, "recvPps", int(result.RecvPPS), "recvMbps", round(result.RecvMbps), "lossPct", round(result.LossPct), "genBusyPct", round(result.GenHostBusyAvgPct))
	return result, nil
}

type totals struct{ packets, bytes uint64 }

func sentTotals(people []*participant) totals {
	var sum totals
	for _, p := range people {
		for _, s := range p.sources {
			sum.packets += s.count.Load()
			sum.bytes += s.bytes.Load()
		}
	}
	return sum
}

func countDropped(people []*participant) int {
	count := 0
	for _, p := range people {
		if p.dropped.Load() {
			count++
		}
	}
	return count
}

func percent(part, whole int64) float64 {
	if whole <= 0 {
		return 0
	}
	return 100 * float64(part) / float64(whole)
}

func summarize(values []float64) distribution {
	if len(values) == 0 {
		return distribution{}
	}
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	at := func(q float64) float64 { return sorted[min(len(sorted)-1, int(q*float64(len(sorted))))] }
	return distribution{P50: round(at(0.5)), P95: round(at(0.95)), Max: round(sorted[len(sorted)-1])}
}

func mean(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

func round(v float64) float64 { return math.Round(v*100) / 100 }
