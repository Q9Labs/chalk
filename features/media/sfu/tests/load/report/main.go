// Command report merges a loadgen results file with the node's samples file and prints
// one markdown table row per measured step. The windows come from the generator's
// clock and the samples from the node's; both droplets run NTP, so they agree to well under a second.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"slices"
	"strings"

	"github.com/q9labs/chalk/features/media/sfu/tests/load/hostmetrics"
)

// nodeSample mirrors a line written by benchnode.
type nodeSample struct {
	hostmetrics.Sample
	HeapAllocBytes uint64 `json:"heapAllocBytes"`
	HeapInuseBytes uint64 `json:"heapInuseBytes"`
	GCCount        uint32 `json:"gcCount"`
	GCPauseTotalNs uint64 `json:"gcPauseTotalNs"`
	GCPauseMaxNs   uint64 `json:"gcPauseMaxNs"`
	Goroutines     int    `json:"goroutines"`
}

type stepResult struct {
	Episodes, EpisodeSize, Participants, Streams  int
	WindowStartUnixMs                             int64   `json:"windowStartUnixMs"`
	WindowEndUnixMs                               int64   `json:"windowEndUnixMs"`
	RecvPPS                                       float64 `json:"recvPps"`
	RecvMbps                                      float64 `json:"recvMbps"`
	SentPPS                                       float64 `json:"sentPps"`
	LossPct                                       float64 `json:"lossPct"`
	VideoLossPct                                  float64 `json:"videoLossPct"`
	AudioLossPct                                  float64 `json:"audioLossPct"`
	WorstStreamLossPct                            float64 `json:"worstStreamLossPct"`
	VideoStreamKbps, VideoJitterMs, AudioJitterMs struct{ P50, P95, Max float64 }
	DroppedDuringWindow                           int     `json:"droppedDuringWindow"`
	GenHostBusyAvgPct                             float64 `json:"genHostBusyAvgPct"`
	GenHostBusyMaxPct                             float64 `json:"genHostBusyMaxPct"`
}

type resultsFile struct {
	Label string       `json:"label"`
	Steps []stepResult `json:"steps"`
}

func main() {
	results := flag.String("results", "", "loadgen results file (steps.json)")
	samples := flag.String("samples", "", "benchnode samples file (samples.jsonl)")
	flag.Parse()
	if *results == "" || *samples == "" {
		log.Fatal("-results and -samples are required")
	}
	var file resultsFile
	raw, err := os.ReadFile(*results)
	if err != nil {
		log.Fatal(err)
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		log.Fatal(err)
	}
	nodes, err := readSamples(*samples)
	if err != nil {
		log.Fatal(err)
	}
	render(file, nodes)
}

func readSamples(path string) ([]nodeSample, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []nodeSample
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var s nodeSample
		if err := json.Unmarshal(scanner.Bytes(), &s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, scanner.Err()
}

func render(file resultsFile, nodes []nodeSample) {
	const mib = 1 << 20
	idleRSS := uint64(0)
	if len(nodes) > 0 {
		idleRSS = nodes[0].RSSBytes
		for _, s := range nodes[:min(len(nodes), 10)] {
			idleRSS = min(idleRSS, s.RSSBytes)
		}
	}
	fmt.Printf("### %s\n\n", file.Label)
	fmt.Println("| Episodes x size | PCs | SFU out pkt/s | SFU in pkt/s | Egress Mbps | Host CPU % avg/max | Process CPU % avg | Steal % avg/max | RSS MiB | Heap MiB p50 | GC/s | GC pause ms/s | GC max pause ms | Loss % (worst stream) | Video jitter ms p50/p95/max | Audio jitter ms p50/p95/max | Video stream kbps p50 | µs CPU per pkt (process / host) | RcvbufErrors | Dropped PCs | Gen CPU % avg/max |")
	fmt.Println("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
	var previous *stepResult
	var previousRSS float64
	var perPC []string
	for i := range file.Steps {
		step := file.Steps[i]
		var window []nodeSample
		for _, s := range nodes {
			if s.UnixMs >= step.WindowStartUnixMs && s.UnixMs <= step.WindowEndUnixMs {
				window = append(window, s)
			}
		}
		if len(window) == 0 {
			fmt.Printf("| %d x %d | %d | no node samples in window |\n", step.Episodes, step.EpisodeSize, step.Participants)
			continue
		}
		pick := func(f func(nodeSample) float64) []float64 {
			values := make([]float64, len(window))
			for i, s := range window {
				values[i] = f(s)
			}
			return values
		}
		out := avg(pick(func(s nodeSample) float64 { return s.UDPOutPPS }))
		in := avg(pick(func(s nodeSample) float64 { return s.UDPInPPS }))
		host := pick(func(s nodeSample) float64 { return s.HostBusyPct })
		proc := pick(func(s nodeSample) float64 { return s.ProcCPUPct })
		steal := pick(func(s nodeSample) float64 { return s.StealPct })
		rss := pick(func(s nodeSample) float64 { return float64(s.RSSBytes) / mib })
		heap := pick(func(s nodeSample) float64 { return float64(s.HeapAllocBytes) / mib })
		first, last := window[0], window[len(window)-1]
		seconds := float64(last.UnixMs-first.UnixMs) / 1000
		gcPerSecond := float64(last.GCCount-first.GCCount) / seconds
		pausePerSecond := float64(last.GCPauseTotalNs-first.GCPauseTotalNs) / 1e6 / seconds
		var maxPause uint64
		for _, s := range window {
			maxPause = max(maxPause, s.GCPauseMaxNs)
		}
		cpus := float64(first.NumCPU)
		perPacket := func(busyPct float64) float64 {
			if in+out == 0 {
				return 0
			}
			return busyPct / 100 * cpus / (in + out) * 1e6
		}
		rcvbuf := last.UDPRcvbufErrTotal - first.UDPRcvbufErrTotal
		fmt.Printf("| %d x %d | %d | %.0f | %.0f | %.1f | %.1f / %.1f | %.1f | %.2f / %.2f | %.0f | %.0f | %.2f | %.2f | %.2f | %.3f (%.2f) | %.2f / %.2f / %.2f | %.2f / %.2f / %.2f | %.0f | %.1f / %.1f | %d | %d | %.1f / %.1f |\n",
			step.Episodes, step.EpisodeSize, step.Participants, out, in,
			avg(pick(func(s nodeSample) float64 { return s.NetTxMbps })),
			avg(host), maxOf(host), avg(proc), avg(steal), maxOf(steal),
			maxOf(rss), median(heap), gcPerSecond, pausePerSecond, float64(maxPause)/1e6,
			step.LossPct, step.WorstStreamLossPct,
			step.VideoJitterMs.P50, step.VideoJitterMs.P95, step.VideoJitterMs.Max,
			step.AudioJitterMs.P50, step.AudioJitterMs.P95, step.AudioJitterMs.Max,
			step.VideoStreamKbps.P50, perPacket(avg(proc)), perPacket(avg(host)),
			rcvbuf, step.DroppedDuringWindow, step.GenHostBusyAvgPct, step.GenHostBusyMaxPct)

		line := fmt.Sprintf("- %d PCs: RSS %.0f MiB (%.2f MiB per PC above the idle node's %.0f MiB), Go heap %.0f MiB (%.2f MiB per PC)",
			step.Participants, maxOf(rss), (maxOf(rss)-float64(idleRSS)/mib)/float64(step.Participants), float64(idleRSS)/mib, median(heap), median(heap)/float64(step.Participants))
		if previous != nil && step.Participants > previous.Participants {
			line += fmt.Sprintf("; +%.2f MiB RSS per added PC since the previous step", (maxOf(rss)-previousRSS)/float64(step.Participants-previous.Participants))
		}
		perPC = append(perPC, line)
		previous, previousRSS = &file.Steps[i], maxOf(rss)
	}
	fmt.Printf("\nMemory per PeerConnection:\n\n%s\n", strings.Join(perPC, "\n"))
}

func avg(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

func maxOf(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	return slices.Max(values)
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	return sorted[len(sorted)/2]
}
