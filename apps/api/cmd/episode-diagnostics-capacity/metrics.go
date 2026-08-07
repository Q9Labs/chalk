package main

import (
	"runtime"
	"sort"
	"sync"
	"time"
)

type latencySamples struct {
	mu     sync.Mutex
	values []time.Duration
}

func (samples *latencySamples) add(value time.Duration) {
	samples.mu.Lock()
	samples.values = append(samples.values, value)
	samples.mu.Unlock()
}

func (samples *latencySamples) summary() latency {
	samples.mu.Lock()
	values := append([]time.Duration(nil), samples.values...)
	samples.mu.Unlock()
	if len(values) == 0 {
		return latency{}
	}
	sort.Slice(values, func(left, right int) bool { return values[left] < values[right] })
	return latency{
		Count: len(values),
		MinMs: durationMilliseconds(values[0]),
		MaxMs: durationMilliseconds(values[len(values)-1]),
		P50Ms: durationMilliseconds(percentile(values, 0.50)),
		P95Ms: durationMilliseconds(percentile(values, 0.95)),
		P99Ms: durationMilliseconds(percentile(values, 0.99)),
	}
}

func percentile(values []time.Duration, rank float64) time.Duration {
	if len(values) == 0 {
		return 0
	}
	index := int(float64(len(values)-1) * rank)
	if index < 0 {
		index = 0
	}
	if index >= len(values) {
		index = len(values) - 1
	}
	return values[index]
}

func durationMilliseconds(value time.Duration) float64 {
	return float64(value) / float64(time.Millisecond)
}

type memorySampler struct {
	stop chan struct{}
	done chan struct{}
	mu   sync.Mutex
	peak memorySample
}

type memorySample struct {
	heapAlloc uint64
	heapInuse uint64
	sys       uint64
}

func startMemorySampler() *memorySampler {
	sampler := &memorySampler{stop: make(chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(sampler.done)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				sampler.observe()
			case <-sampler.stop:
				return
			}
		}
	}()
	sampler.observe()
	return sampler
}

func (sampler *memorySampler) stopAndRead() memorySample {
	sampler.observe()
	close(sampler.stop)
	<-sampler.done
	sampler.observe()
	sampler.mu.Lock()
	defer sampler.mu.Unlock()
	return sampler.peak
}

func (sampler *memorySampler) observe() {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	sample := memorySample{heapAlloc: stats.HeapAlloc, heapInuse: stats.HeapInuse, sys: stats.Sys}
	sampler.mu.Lock()
	if sample.heapAlloc > sampler.peak.heapAlloc {
		sampler.peak.heapAlloc = sample.heapAlloc
	}
	if sample.heapInuse > sampler.peak.heapInuse {
		sampler.peak.heapInuse = sample.heapInuse
	}
	if sample.sys > sampler.peak.sys {
		sampler.peak.sys = sample.sys
	}
	sampler.mu.Unlock()
}

func readMemory() memorySample {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	return memorySample{heapAlloc: stats.HeapAlloc, heapInuse: stats.HeapInuse, sys: stats.Sys}
}
