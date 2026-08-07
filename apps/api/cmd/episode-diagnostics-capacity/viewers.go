package main

import (
	"context"
	"errors"
	"sync"
	"time"
)

type viewerStats struct {
	connectLatency   []time.Duration
	reconnectLatency []time.Duration
	report           reconnectReport
	failures         int64
}

type viewerResult struct {
	connectLatency   []time.Duration
	reconnectLatency []time.Duration
	connections      int64
	reconnects       int64
	successful       int64
	deltas           int64
	gaps             int64
	lost             int64
	lastCursor       int64
	failures         int64
}

func runViewers(parent context.Context, client *apiClient, value config, reference string, after int64) (viewerStats, error) {
	if value.Viewers == 0 {
		return viewerStats{}, nil
	}
	results := make(chan viewerResult, value.Viewers)
	var wait sync.WaitGroup
	for viewer := 0; viewer < value.Viewers; viewer++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results <- runViewer(parent, client, value, reference, after)
		}()
	}
	go func() {
		wait.Wait()
		close(results)
	}()

	stats := viewerStats{}
	var firstErr error
	for result := range results {
		stats.connectLatency = append(stats.connectLatency, result.connectLatency...)
		stats.reconnectLatency = append(stats.reconnectLatency, result.reconnectLatency...)
		stats.report.Connections += result.connections
		stats.report.ReconnectAttempts += result.reconnects
		stats.report.Successful += result.successful
		stats.report.Deltas += result.deltas
		stats.report.Gaps += result.gaps
		stats.report.LostCursors += result.lost
		if result.lastCursor > stats.report.LastCursor {
			stats.report.LastCursor = result.lastCursor
		}
		stats.failures += result.failures
		if result.failures > 0 && firstErr == nil {
			firstErr = errors.New("one or more diagnostics SSE viewers failed")
		}
	}
	if firstErr != nil {
		return stats, firstErr
	}
	return stats, nil
}

func runViewer(parent context.Context, client *apiClient, value config, reference string, after int64) viewerResult {
	result := viewerResult{}
	cursor := after
	connections := value.Reconnects + 1
	for connection := 0; connection < connections; connection++ {
		ctx, cancel := context.WithTimeout(parent, value.StreamDuration)
		stream, latency, err := client.stream(ctx, reference, value.OperatorToken, cursor)
		cancel()
		result.connections++
		if connection > 0 {
			result.reconnects++
		}
		if connection == 0 {
			result.connectLatency = append(result.connectLatency, latency)
		} else {
			result.reconnectLatency = append(result.reconnectLatency, latency)
		}
		if err != nil {
			result.failures++
			break
		}
		if !stream.ControlSeen {
			result.failures++
			break
		}
		result.successful++
		result.deltas += stream.Deltas
		result.gaps += stream.Gaps
		result.lost += stream.LostCursors
		if stream.LastCursor > cursor {
			cursor = stream.LastCursor
		}
		if stream.CloseCursor > cursor {
			cursor = stream.CloseCursor
		}
	}
	result.lastCursor = cursor
	return result
}
