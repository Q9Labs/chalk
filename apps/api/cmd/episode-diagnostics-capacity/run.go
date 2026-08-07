package main

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func run(parent context.Context, value config) (report, error) {
	if err := validateConfig(value); err != nil {
		return report{}, err
	}
	started := time.Now()
	result := newReport(value)
	startMemory := readMemory()
	sampler := startMemorySampler()

	if value.DryRun {
		result.Status = "dry_run"
		result.Counters.AttemptedEvents = 0
		result.Gaps = append(result.Gaps, fmt.Sprintf("planned %d bounded append batches; no network calls were made", len(batches(value))))
		finishReport(&result, started, startMemory, sampler)
		return result, nil
	}
	client, err := newAPIClient(value.BaseURL)
	if err != nil {
		result.Status = "failed"
		result.Gaps = append(result.Gaps, "API base URL was invalid")
		finishReport(&result, started, startMemory, sampler)
		return result, err
	}

	reference := strings.TrimSpace(value.Reference)
	appendStats := appendMetrics{}
	if value.Events > 0 {
		if err := validateScope(value); err != nil {
			result.Status = "failed"
			finishReport(&result, started, startMemory, sampler)
			return result, err
		}
		learned, appendErr := appendEvents(parent, client, value, &result.Latencies, &appendStats)
		if learned != "" && reference == "" {
			reference = learned
		}
		result.Reference = reference
		result.Counters = appendStats.counters
		if appendErr != nil {
			result.Status = "failed"
			finishReport(&result, started, startMemory, sampler)
			return result, appendErr
		}
	}
	result.Reference = reference
	if reference == "" {
		result.Status = "partial"
		result.Gaps = append(result.Gaps, "no diagnostic reference was supplied or returned by append; reads were skipped")
	} else if value.OperatorToken == "" {
		result.Status = "partial"
		result.Gaps = append(result.Gaps, "operator token is not configured; snapshot, page, and SSE reads were skipped")
	} else {
		readErr := runReads(parent, client, value, reference, &result)
		if readErr != nil {
			result.Status = "failed"
			finishReport(&result, started, startMemory, sampler)
			return result, readErr
		}
	}
	if result.Status == "" {
		result.Status = "ok"
	}
	finishReport(&result, started, startMemory, sampler)
	return result, nil
}

func newReport(value config) report {
	return report{
		SchemaVersion: "EpisodeDiagnosticsCapacityReport/v1",
		Config: reportConfig{
			BaseURL: sanitizedURL(value.BaseURL), Events: value.Events, Participants: value.Participants,
			Viewers: value.Viewers, BatchSize: value.BatchSize, AppendWorkers: value.AppendWorkers,
			PageSize: value.PageSize, Reconnects: value.Reconnects, DryRun: value.DryRun,
		},
		Latencies: make(map[string]latency),
		Retention: retentionReport{Status: "not_configured", ProbeURLConfigured: value.RetentionProbeURL != ""},
	}
}

func finishReport(result *report, started time.Time, startMemory memorySample, sampler *memorySampler) {
	endMemory := readMemory()
	peakMemory := sampler.stopAndRead()
	result.DurationMs = durationMilliseconds(time.Since(started))
	result.Memory = memoryReport{
		StartHeapAllocBytes: startMemory.heapAlloc,
		EndHeapAllocBytes:   endMemory.heapAlloc,
		PeakHeapAllocBytes:  peakMemory.heapAlloc,
		StartHeapInuseBytes: startMemory.heapInuse,
		EndHeapInuseBytes:   endMemory.heapInuse,
		PeakHeapInuseBytes:  peakMemory.heapInuse,
		StartSysBytes:       startMemory.sys,
		EndSysBytes:         endMemory.sys,
		PeakSysBytes:        peakMemory.sys,
		Goroutines:          runtime.NumGoroutine(),
	}
	if result.DurationMs > 0 {
		seconds := result.DurationMs / 1000
		result.Throughput.EventsPerSecond = float64(result.Counters.AttemptedEvents) / seconds
		result.Throughput.AcceptedEventsPerSecond = float64(result.Counters.AcceptedEvents) / seconds
		result.Throughput.BatchesPerSecond = float64(result.Latencies["append"].Count) / seconds
	}
}

type appendMetrics struct {
	counters counterReport
}

type appendOutcome struct {
	count    int
	response appendResponse
	latency  time.Duration
	err      error
}

func appendEvents(parent context.Context, client *apiClient, value config, latencies *map[string]latency, metrics *appendMetrics) (string, error) {
	participantIDs := participantIDs(value.Participants)
	workCtx, cancel := context.WithCancel(parent)
	defer cancel()
	jobs := make(chan appendBatch)
	results := make(chan appendOutcome, value.AppendWorkers)
	var workers sync.WaitGroup
	var firstErr error
	var firstErrMu sync.Mutex
	for worker := 0; worker < value.AppendWorkers; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for batch := range jobs {
				request := makeAppendRequest(value, batch, participantIDs[batch.ParticipantIndex], 0, time.Now().UTC())
				if err := validateRequestWire(request); err != nil {
					results <- appendOutcome{count: batch.Count, err: err}
					firstErrMu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					firstErrMu.Unlock()
					cancel()
					continue
				}
				response, latency, err := client.append(workCtx, value.ProducerToken, request)
				results <- appendOutcome{count: batch.Count, response: response, latency: latency, err: err}
				if err != nil {
					firstErrMu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					firstErrMu.Unlock()
					cancel()
				}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, batch := range batches(value) {
			select {
			case jobs <- batch:
			case <-workCtx.Done():
				return
			}
		}
	}()
	go func() {
		workers.Wait()
		close(results)
	}()

	var reference string
	appendSamples := latencySamples{}
	for outcome := range results {
		metrics.counters.AttemptedEvents += int64(outcome.count)
		if outcome.latency > 0 {
			appendSamples.add(outcome.latency)
		}
		if outcome.err != nil {
			if apiFailure, ok := outcome.err.(*apiError); ok && apiFailure.Status >= 400 && apiFailure.Status < 500 {
				metrics.counters.Rejections++
			} else {
				metrics.counters.HTTPFailures++
			}
			continue
		}
		if reference == "" {
			reference = outcome.response.DiagnosticReference
		}
		metrics.counters.AcceptedEvents += int64(len(outcome.response.Accepted))
		metrics.counters.DuplicateEvents += int64(len(outcome.response.Duplicates))
		metrics.counters.Conflicts += int64(len(outcome.response.Conflicts))
	}
	(*latencies)["append"] = appendSamples.summary()
	firstErrMu.Lock()
	err := firstErr
	firstErrMu.Unlock()
	if err != nil {
		return reference, fmt.Errorf("append workload failed: %w", err)
	}
	return reference, nil
}

func validateScope(value config) error {
	for name, id := range map[string]string{"tenant-id": value.TenantID, "space-id": value.SpaceID, "episode-id": value.EpisodeID} {
		if _, err := utilities.ParseID(id); err != nil {
			return fmt.Errorf("%s must be a UUID", name)
		}
	}
	return nil
}

func runReads(parent context.Context, client *apiClient, value config, reference string, result *report) error {
	snapshot, latency, err := client.snapshot(parent, reference, value.OperatorToken)
	result.Latencies["snapshot"] = latencySummary(latency)
	if err != nil {
		result.Counters.ReadFailures++
		return err
	}
	var after *int64
	pageSamples := latencySamples{}
	for {
		page, pageLatency, pageErr := client.pageEvents(parent, reference, value.OperatorToken, after, value.PageSize)
		pageSamples.add(pageLatency)
		if pageErr != nil {
			result.Counters.ReadFailures++
			return pageErr
		}
		if !page.HasMore {
			break
		}
		if page.NextCursor == nil || (after != nil && *page.NextCursor <= *after) {
			return errors.New("event page did not advance its cursor")
		}
		next := *page.NextCursor
		after = &next
	}
	result.Latencies["page"] = pageSamples.summary()
	result.Reference = reference
	viewerStats, viewerErr := runViewers(parent, client, value, reference, snapshot.Projected)
	connectSamples := latencySamples{}
	for _, sample := range viewerStats.connectLatency {
		connectSamples.add(sample)
	}
	reconnectSamples := latencySamples{}
	for _, sample := range viewerStats.reconnectLatency {
		reconnectSamples.add(sample)
	}
	result.Latencies["sse_connect"] = connectSamples.summary()
	result.Latencies["sse_reconnect"] = reconnectSamples.summary()
	result.Reconnect = viewerStats.report
	result.Counters.ReadFailures += viewerStats.failures
	if viewerErr != nil {
		return viewerErr
	}
	return measureRetention(parent, client, value, reference, result)
}

func latencySummary(value time.Duration) latency {
	samples := latencySamples{}
	samples.add(value)
	return samples.summary()
}
