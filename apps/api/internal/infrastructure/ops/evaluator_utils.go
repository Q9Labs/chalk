package ops

import (
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
)

// ConsecutiveMonitorFailures counts contiguous failed monitor results
// from newest to oldest until the first non-failed status.
func ConsecutiveMonitorFailures(statuses []domainops.MonitorResultStatus) int {
	failures := 0
	for _, status := range statuses {
		if status != domainops.MonitorResultStatusFailed {
			break
		}
		failures++
	}
	return failures
}

func IsHeartbeatMissed(lastIngestedAt, now time.Time, expectedInterval, graceWindow time.Duration) bool {
	if expectedInterval <= 0 || graceWindow <= 0 {
		return false
	}
	return now.After(lastIngestedAt.Add(expectedInterval).Add(graceWindow))
}

func IsEventWithinSkew(eventAt, now time.Time, maxPastSkew, maxFutureSkew time.Duration) bool {
	if maxPastSkew < 0 || maxFutureSkew < 0 {
		return false
	}
	if eventAt.Before(now.Add(-maxPastSkew)) {
		return false
	}
	if eventAt.After(now.Add(maxFutureSkew)) {
		return false
	}
	return true
}
