package main

import (
	"context"
	"errors"
	"time"
)

func measureRetention(parent context.Context, client *apiClient, value config, reference string, result *report) error {
	if value.RetentionProbeURL != "" {
		latency, err := client.retentionProbe(parent, value.RetentionProbeURL, value.OperatorToken)
		result.Retention.ProbeLatencyMs = durationMilliseconds(latency)
		if err != nil {
			result.Retention.Status = "probe_failed"
			result.Counters.ReadFailures++
			return err
		}
		result.Retention.Status = "probe_ok"
		result.Retention.Note = "retention-probe-url was checked; the URL is omitted from this report"
		return nil
	}
	if value.RetentionWait <= 0 {
		result.Retention.Note = "set retention-wait or retention-probe-url to measure expiry; the API does not expose a force-expire route"
		return nil
	}
	started := time.Now()
	if _, _, err := client.snapshot(parent, reference, value.OperatorToken); err != nil {
		result.Retention.Status = "initial_probe_failed"
		result.Counters.ReadFailures++
		return err
	}
	select {
	case <-time.After(value.RetentionWait):
	case <-parent.Done():
		return parent.Err()
	}
	_, _, err := client.snapshot(parent, reference, value.OperatorToken)
	result.Retention.WaitMs = durationMilliseconds(time.Since(started))
	if err == nil {
		result.Retention.Status = "retained"
		return nil
	}
	var apiFailure *apiError
	if errors.As(err, &apiFailure) && apiFailure.Status == 404 {
		result.Retention.Status = "expired"
		return nil
	}
	result.Retention.Status = "final_probe_failed"
	result.Counters.ReadFailures++
	return err
}
