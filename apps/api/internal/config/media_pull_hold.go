package config

import (
	"fmt"
	"time"
)

const (
	MediaPullHoldEnabled  = "CHALK_MEDIA_PULL_HOLD_ENABLED"
	MediaPullHoldBudgetMS = "CHALK_MEDIA_PULL_HOLD_BUDGET_MS"

	DefaultMediaPullHoldBudgetMS = int64(4000)
	// The 5.2.6 client abandons a pull after about 8 s, and the Cloudflare add-tracks call that
	// follows the hold can take over 1 s, so a longer hold would turn a late pull into a failed one.
	maxMediaPullHoldBudgetMS = int64(5000)
	minMediaPullHoldBudgetMS = int64(200)
)

// MediaPullHoldConfig controls the wait before a listener's pull of a freshly published track
// is forwarded to Cloudflare.
type MediaPullHoldConfig struct {
	Enabled bool
	Budget  time.Duration
}

func loadMediaPullHoldConfig() (MediaPullHoldConfig, error) {
	enabled, err := envStrictBool(MediaPullHoldEnabled, false)
	if err != nil {
		return MediaPullHoldConfig{}, err
	}
	budget, err := envBoundedMilliseconds(MediaPullHoldBudgetMS, DefaultMediaPullHoldBudgetMS, minMediaPullHoldBudgetMS, maxMediaPullHoldBudgetMS)
	if err != nil {
		return MediaPullHoldConfig{}, fmt.Errorf("load media pull hold: %w", err)
	}
	return MediaPullHoldConfig{Enabled: enabled, Budget: budget}, nil
}
