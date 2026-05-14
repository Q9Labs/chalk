package ops

import "time"

// DefaultHeartbeatGraceWindow implements the MVP grace defaults from the spec:
// - expected <= 1m => 3m
// - expected <= 5m => 12m
// - expected > 5m => 75m
func DefaultHeartbeatGraceWindow(expectedInterval time.Duration) time.Duration {
	switch {
	case expectedInterval <= time.Minute:
		return 3 * time.Minute
	case expectedInterval <= 5*time.Minute:
		return 12 * time.Minute
	default:
		return 75 * time.Minute
	}
}
