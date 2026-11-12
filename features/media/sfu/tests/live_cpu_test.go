package tests

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"slices"
	"strings"
	"time"
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
