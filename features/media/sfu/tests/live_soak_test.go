package tests

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// The staging soak in docs/sfu/capacity-calibration.md: five hours at three classes against the
// 22,000 packets/s budget, covering the :00 and :30 marks, with no microphone stall over 500 ms.
const (
	soakHold      = 5 * time.Hour
	shortHold     = 5 * time.Minute
	stagingBudget = 22000
	// soakInterval is the longest sample spacing, for the run and for the node's CPU capture.
	soakInterval = 10 * time.Second
	// fullRunHold is the hold from which a run is the soak itself and must carry its full evidence.
	fullRunHold = time.Hour
	// captureCoverage is the share of expected node CPU samples a full run must have.
	captureCoverage = 0.9
)

// nodeCPUSample is one line of the node's CPU capture (scripts/node-cpu-capture): the host's steal
// and the SFU process's own CPU over the interval, both as a percent of the node.
type nodeCPUSample struct {
	At           time.Time `json:"at"`
	StealPercent float64   `json:"stealPercent"`
	OwnPercent   float64   `json:"ownPercent"`
}

// series summarises one metric over the run.
type series struct {
	Count int     `json:"count"`
	Mean  float64 `json:"mean"`
	P90   float64 `json:"p90"`
	P99   float64 `json:"p99"`
	Max   float64 `json:"max"`
}

func summarize(values []float64) series {
	if len(values) == 0 {
		return series{}
	}
	sorted := slices.Sorted(slices.Values(values))
	sum := 0.0
	for _, value := range sorted {
		sum += value
	}
	at := func(q float64) float64 { return sorted[min(len(sorted)-1, int(math.Ceil(q*float64(len(sorted))))-1)] }
	return series{Count: len(sorted), Mean: sum / float64(len(sorted)), P90: at(0.9), P99: at(0.99), Max: sorted[len(sorted)-1]}
}

// nodeCPUResult is the 10 s capture over the hold. Demand is own CPU over the CPU steal leaves,
// own / (1 - steal), the figure the capacity model is fitted to (stalls began near 75%).
type nodeCPUResult struct {
	Steal  series `json:"stealPercent"`
	Own    series `json:"ownPercent"`
	Demand series `json:"demandPercent"`
}

func readNodeCPU(path string, from, to time.Time) ([]nodeCPUSample, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var samples []nodeCPUSample
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var sample nodeCPUSample
		if err := json.Unmarshal(scanner.Bytes(), &sample); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if !sample.At.Before(from) && !sample.At.After(to) {
			samples = append(samples, sample)
		}
	}
	return samples, scanner.Err()
}

func summarizeNodeCPU(samples []nodeCPUSample) nodeCPUResult {
	var steal, own, demand []float64
	for _, sample := range samples {
		steal = append(steal, sample.StealPercent)
		own = append(own, sample.OwnPercent)
		demand = append(demand, 100*sample.OwnPercent/max(100-sample.StealPercent, 1))
	}
	return nodeCPUResult{Steal: summarize(steal), Own: summarize(own), Demand: summarize(demand)}
}

// marksCrossed counts the :00 and :30 UTC marks inside the window.
func marksCrossed(from, to time.Time) (hours, halves int) {
	for mark := from.UTC().Truncate(30 * time.Minute).Add(30 * time.Minute); !mark.After(to); mark = mark.Add(30 * time.Minute) {
		if mark.Minute() == 0 {
			hours++
		} else {
			halves++
		}
	}
	return hours, halves
}

// soakResult is the JSON result file: the acceptance numbers and the verdict.
type soakResult struct {
	Mode            string         `json:"mode"`
	StartedAt       time.Time      `json:"startedAt"`
	EndedAt         time.Time      `json:"endedAt"`
	Hold            string         `json:"hold"`
	Classes         int            `json:"classes"`
	Participants    int            `json:"participantsPerClass"`
	Cameras         int            `json:"camerasPerParticipant"`
	PacketBudget    int            `json:"packetBudget"`
	ReservedPackets int            `json:"reservedPackets"`
	Sessions        int            `json:"sessions"`
	Samples         int            `json:"samples"`
	Marks           map[string]int `json:"marksCrossed"`
	PacketsPerSec   series         `json:"packetsPerSecond"`
	ReadyzSteal     series         `json:"readyzStealPercent"` // the node's guard window, not 10 s
	NodeCPU         *nodeCPUResult `json:"nodeCpu,omitempty"`
	Peers           peerTotals     `json:"peers"`
	Failures        []string       `json:"failures"`
	Pass            bool           `json:"pass"`
}

// soakEvidence is what a run produced, before it is judged.
type soakEvidence struct {
	load           liveLoad
	started, ended time.Time
	first, last    liveSample
	samples        []liveSample
	nodeCPU        []nodeCPUSample
	nodeCPUErr     error
}

// judgeSoak applies the doc's acceptance to a run. A short run is judged on stalls, drops, budget
// and admission; a run of fullRunHold or more also needs the :00 and :30 marks and the node's
// 10 s CPU capture.
func judgeSoak(e soakEvidence) soakResult {
	hours, halves := marksCrossed(e.started, e.ended)
	result := soakResult{
		Mode: "short", StartedAt: e.started.UTC(), EndedAt: e.ended.UTC(), Hold: e.ended.Sub(e.started).Round(time.Second).String(),
		Classes: e.load.classes, Participants: e.load.participants, Cameras: e.load.cameras, Samples: len(e.samples),
		Marks: map[string]int{":00": hours, ":30": halves}, Peers: e.last.Peers,
	}
	full := e.load.hold >= fullRunHold
	if full {
		result.Mode = "soak"
	}
	var pps, steal []float64
	for _, sample := range e.samples {
		if sample.Ready == nil {
			continue
		}
		pps = append(pps, sample.Ready.Host.PacketsPerSecond)
		if sample.Ready.Host.StealPercent != nil {
			steal = append(steal, *sample.Ready.Host.StealPercent)
		}
	}
	result.PacketsPerSec, result.ReadyzSteal = summarize(pps), summarize(steal)
	if e.last.Ready != nil {
		result.PacketBudget, result.ReservedPackets, result.Sessions = e.last.Ready.PacketBudget, e.last.Ready.ReservedPackets, e.last.Ready.Sessions
	}

	failures := fixedRunFailures(e.first, e.last)
	if want := e.load.expectBudget; want > 0 && e.last.Ready != nil && e.last.Ready.PacketBudget != want {
		failures = append(failures, fmt.Sprintf("the node's packet budget is %d, the soak is for %d", e.last.Ready.PacketBudget, want))
	}
	if want := e.load.classes * e.load.participants; e.last.Ready != nil && e.last.Ready.Sessions < want {
		failures = append(failures, fmt.Sprintf("the node holds %d sessions at the end, want %d", e.last.Ready.Sessions, want))
	}
	if len(e.nodeCPU) > 0 {
		cpu := summarizeNodeCPU(e.nodeCPU)
		result.NodeCPU = &cpu
	}
	if full {
		if e.load.every > soakInterval {
			failures = append(failures, fmt.Sprintf("SFU_LIVE_SAMPLE is %v; the soak samples at most every %v", e.load.every, soakInterval))
		}
		if hours == 0 || halves == 0 {
			failures = append(failures, fmt.Sprintf("the run crossed %d :00 and %d :30 marks; it must cover both", hours, halves))
		}
		expected := int(e.ended.Sub(e.started) / soakInterval)
		switch {
		case e.nodeCPUErr != nil:
			failures = append(failures, fmt.Sprintf("the node CPU capture (SFU_LIVE_NODE_CPU) is unreadable: %v", e.nodeCPUErr))
		case float64(len(e.nodeCPU)) < captureCoverage*float64(expected):
			failures = append(failures, fmt.Sprintf("the node CPU capture has %d samples in the window, want at least %d for 10 s spacing", len(e.nodeCPU), int(captureCoverage*float64(expected))))
		}
	}
	result.Failures, result.Pass = failures, len(failures) == 0
	return result
}

func writeSoakResult(t *testing.T, path string, result soakResult) {
	t.Helper()
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestLiveHarnessHoldsAClassOnALoopbackNode runs the live harness's short mode against an
// in-process node, so the soak's driver and verdict stay working between staging runs.
func TestLiveHarnessHoldsAClassOnALoopbackNode(t *testing.T) {
	svc := startService(t, newAuthority(t, "live-harness"), func(cfg *config.Config) {
		cfg.MaxSessions = 16
		cfg.Guard.MaxStealPercent, cfg.Guard.MaxBusyPercent = 100, 100
	})
	result := filepath.Join(t.TempDir(), "result.json")
	load := liveLoad{classes: 1, participants: 3, cameras: 2, cameraKbps: [2]int{800, 200}, shareDuty: 0.65, sharePeriod: 4 * time.Minute,
		hold: 8 * time.Second, every: 2 * time.Second, result: result, short: true}
	runLiveClasses(t, svc, load)

	raw, err := os.ReadFile(result)
	if err != nil {
		t.Fatal(err)
	}
	var got soakResult
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if !got.Pass || got.Mode != "short" || got.Sessions != 3 || got.Peers.Expected == 0 {
		t.Fatalf("result = %+v, want a passing short run with 3 sessions and received media", got)
	}
}

func TestMarksCrossedCountsHourAndHalfHourMarks(t *testing.T) {
	from := time.Date(2026, 11, 9, 14, 10, 0, 0, time.UTC)
	for _, tc := range []struct {
		hold          time.Duration
		hours, halves int
	}{{15 * time.Minute, 0, 0}, {20 * time.Minute, 0, 1}, {50 * time.Minute, 1, 1}, {5 * time.Hour, 5, 5}} {
		if hours, halves := marksCrossed(from, from.Add(tc.hold)); hours != tc.hours || halves != tc.halves {
			t.Errorf("%v from 14:10Z crosses %d :00 and %d :30 marks, want %d and %d", tc.hold, hours, halves, tc.hours, tc.halves)
		}
	}
}

func TestSummarizeReportsTheTailOfASeries(t *testing.T) {
	values := make([]float64, 100)
	for i := range values {
		values[i] = float64(i + 1)
	}
	if got := summarize(values); got.Count != 100 || got.Mean != 50.5 || got.P90 != 90 || got.P99 != 99 || got.Max != 100 {
		t.Fatalf("summarize(1..100) = %+v", got)
	}
}

// soakRun is a healthy five-hour run starting on a :10 mark, with the node's CPU captured at 10 s.
func soakRun() soakEvidence {
	started := time.Date(2026, 11, 9, 14, 10, 0, 0, time.UTC)
	ready := &protocol.ReadyResponse{PacketBudget: stagingBudget, ReservedPackets: 21510, Sessions: 9}
	evidence := soakEvidence{
		load:    liveLoad{classes: 3, participants: 3, hold: soakHold, every: soakInterval, expectBudget: stagingBudget},
		started: started, ended: started.Add(soakHold),
		first: liveSample{Ready: ready}, last: liveSample{Ready: ready, Peers: peerTotals{Expected: 1}},
		samples: []liveSample{{Ready: ready}},
	}
	for at := started; at.Before(evidence.ended); at = at.Add(soakInterval) {
		evidence.nodeCPU = append(evidence.nodeCPU, nodeCPUSample{At: at, StealPercent: 10, OwnPercent: 40})
	}
	return evidence
}

func TestJudgeSoakAcceptsAHealthyFiveHourRun(t *testing.T) {
	result := judgeSoak(soakRun())
	if !result.Pass || result.Mode != "soak" || result.NodeCPU == nil || result.NodeCPU.Demand.Max < 44 || result.NodeCPU.Demand.Max > 45 {
		t.Fatalf("a healthy soak = %+v, want a pass with demand 40/(1-0.1) = 44.4%%", result)
	}
}

func TestJudgeSoakFailsWhatTheDocRequires(t *testing.T) {
	for name, tc := range map[string]struct {
		change func(*soakEvidence)
		want   string
	}{
		"a microphone stall": {func(e *soakEvidence) { e.last.Peers.AudioStalls = 1 }, "microphones stalled"},
		"another budget":     {func(e *soakEvidence) { e.last.Ready.PacketBudget = 36000 }, "packet budget is 36000"},
		"a lost session": {func(e *soakEvidence) {
			e.last.Ready = &protocol.ReadyResponse{PacketBudget: stagingBudget, Sessions: 8}
		}, "holds 8 sessions"},
		"no node CPU capture":     {func(e *soakEvidence) { e.nodeCPU, e.nodeCPUErr = nil, errors.New("not set") }, "node CPU capture"},
		"a sparse node CPU":       {func(e *soakEvidence) { e.nodeCPU = e.nodeCPU[:100] }, "node CPU capture has 100 samples"},
		"a slow sample":           {func(e *soakEvidence) { e.load.every = time.Minute }, "samples at most every"},
		"a run missing the marks": {func(e *soakEvidence) { e.load.hold, e.ended = soakHold, e.started.Add(15*time.Minute) }, ":00"},
	} {
		t.Run(name, func(t *testing.T) {
			evidence := soakRun()
			tc.change(&evidence)
			result := judgeSoak(evidence)
			if result.Pass || !strings.Contains(strings.Join(result.Failures, "; "), tc.want) {
				t.Fatalf("failures = %q, want one containing %q", result.Failures, tc.want)
			}
		})
	}
}

func TestJudgeSoakShortRunNeedsNoNodeCaptureOrMarks(t *testing.T) {
	evidence := soakRun()
	evidence.load.hold, evidence.ended, evidence.nodeCPU = shortHold, evidence.started.Add(shortHold), nil
	if result := judgeSoak(evidence); !result.Pass || result.Mode != "short" {
		t.Fatalf("a short run = %+v, want a pass", result)
	}
}

func TestReadNodeCPUKeepsTheRunWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cpu.jsonl")
	lines := `{"at":"2026-11-09T14:00:00Z","stealPercent":1,"ownPercent":1}
{"at":"2026-11-09T14:10:00Z","stealPercent":2,"ownPercent":3}

{"at":"2026-11-09T14:20:00Z","stealPercent":4,"ownPercent":5}
`
	if err := os.WriteFile(path, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}
	from := time.Date(2026, 11, 9, 14, 5, 0, 0, time.UTC)
	got, err := readNodeCPU(path, from, from.Add(10*time.Minute))
	if err != nil || len(got) != 1 || got[0].OwnPercent != 3 {
		t.Fatalf("readNodeCPU = %v, %v; want only the 14:10Z sample", got, err)
	}
}
